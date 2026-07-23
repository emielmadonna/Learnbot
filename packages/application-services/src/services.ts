import type {
  AttachmentProcessingStatus,
  ChatAttachment,
  Conversation,
  ConversationModality,
  CostLedgerEntry,
  CostSummary,
  CourseDraft,
  CourseSummary,
  IngestionJob,
  IngestionJobStatus,
  LearningContextMapping,
  LearningSource,
  LearningSourceStatus,
  ResolvedLearningContext,
  StudentLearningProgress,
  TenantBranding,
} from "@course-ai/contracts";
import { assertPermission } from "./authorization.js";
import { ApplicationError } from "./errors.js";
import { DeterministicIdGenerator } from "./id.js";
import {
  stableStringify,
  TenantIdempotencyStore,
  TenantMemoryRepository,
} from "./repository.js";
import type {
  AuditRecord,
  AuthorizedTenantContext,
  BrandingDraftInput,
  Clock,
  ContextResolutionInput,
  CostRecordInput,
  CreateAttachmentInput,
  CreateConversationInput,
  IdGenerator,
  PlatformSeed,
  StartJobInput,
  StudentProgressRecord,
  TenantConfigurationPatch,
  TenantConfigurationRecord,
} from "./types.js";

interface BrandingVersionRecord {
  readonly tenantId: string;
  readonly recordId: string;
  readonly branding: TenantBranding;
  readonly state: "draft" | "published";
}

interface MappingRecord extends LearningContextMapping {
  readonly recordId: string;
}

interface ProgressRecord extends StudentProgressRecord {
  readonly recordId: string;
}

const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
};

function iso(clock: Clock): string {
  return clock.now().toISOString();
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ApplicationError(
      "VALIDATION_FAILED",
      `${field} cannot be empty.`,
      { field },
    );
  }
  return normalized;
}

function notFound(resourceType: string): never {
  throw new ApplicationError(
    "RESOURCE_NOT_FOUND",
    "The requested resource was not found.",
    { resourceType },
  );
}

function summarizeCourse(course: CourseDraft): CourseSummary {
  return {
    courseId: course.courseId,
    tenantId: course.tenantId,
    title: course.title,
    slug: course.slug,
    status: course.status,
    version: course.version,
    moduleCount: course.modules.length,
    lessonCount: course.modules.reduce(
      (count, module) => count + module.lessons.length,
      0,
    ),
    updatedAt: course.updatedAt,
  };
}

function safeWildcardMatch(pattern: string, value: string): boolean {
  if (
    pattern.length === 0 ||
    pattern.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(pattern)
  ) {
    return false;
  }
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function mappingMatches(mapping: LearningContextMapping, url: string): boolean {
  if (mapping.match.type === "exact") {
    return mapping.match.url === url;
  }
  if (mapping.match.type === "prefix") {
    return url.startsWith(mapping.match.urlPrefix);
  }
  return safeWildcardMatch(mapping.match.safePattern, url);
}

function isTerminalJob(status: IngestionJobStatus): boolean {
  return [
    "succeeded",
    "failed",
    "dead_letter",
    "cancelled",
  ].includes(status);
}

/**
 * Transport-independent application service facade.
 *
 * The in-memory repositories deliberately expose no unscoped lookup. A future
 * SQL adapter should preserve the same `(tenant_id, resource_id)` access shape
 * and enforce it again with row-level security.
 */
export class PlatformApplicationServices {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #idempotency = new TenantIdempotencyStore();
  readonly #tenants = new TenantMemoryRepository<TenantConfigurationRecord>(
    (record) => record.tenantId,
  );
  readonly #branding = new TenantMemoryRepository<BrandingVersionRecord>(
    (record) => record.recordId,
  );
  readonly #mappings = new TenantMemoryRepository<MappingRecord>(
    (record) => record.recordId,
  );
  readonly #progress = new TenantMemoryRepository<ProgressRecord>(
    (record) => record.recordId,
  );
  readonly #courses = new TenantMemoryRepository<CourseDraft>(
    (record) => record.courseId,
  );
  readonly #sources = new TenantMemoryRepository<LearningSource>(
    (record) => record.sourceId,
  );
  readonly #jobs = new TenantMemoryRepository<IngestionJob>(
    (record) => record.jobId,
  );
  readonly #conversations = new TenantMemoryRepository<Conversation>(
    (record) => record.id,
  );
  readonly #attachments = new TenantMemoryRepository<ChatAttachment>(
    (record) => record.attachmentId,
  );
  readonly #audits = new TenantMemoryRepository<AuditRecord>(
    (record) => record.auditId,
  );
  readonly #costs = new TenantMemoryRepository<CostLedgerEntry>(
    (record) => record.costEntryId,
  );

  constructor(
    seed: PlatformSeed = {},
    options: { readonly clock?: Clock; readonly ids?: IdGenerator } = {},
  ) {
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#ids = options.ids ?? new DeterministicIdGenerator();

    for (const record of seed.tenants ?? []) this.#tenants.seed(record);
    for (const branding of seed.branding ?? []) {
      this.#branding.seed({
        tenantId: branding.tenantId,
        recordId: String(branding.version),
        branding,
        state: "published",
      });
    }
    for (const mapping of seed.mappings ?? []) {
      this.#mappings.seed({
        ...mapping,
        recordId: mapping.mappingId,
      });
    }
    for (const progress of seed.progress ?? []) {
      this.#progress.seed({
        ...progress,
        recordId: `${progress.studentId}:${progress.progress.courseId}`,
      });
    }
    for (const course of seed.courses ?? []) this.#courses.seed(course);
    for (const source of seed.sources ?? []) this.#sources.seed(source);
    for (const job of seed.jobs ?? []) this.#jobs.seed(job);
    for (const conversation of seed.conversations ?? [])
      this.#conversations.seed(conversation);
    for (const attachment of seed.attachments ?? [])
      this.#attachments.seed(attachment);
    for (const audit of seed.audits ?? []) this.#audits.seed(audit);
    for (const cost of seed.costs ?? []) this.#costs.seed(cost);
  }

  async getTenantConfiguration(
    context: AuthorizedTenantContext,
  ): Promise<TenantConfigurationRecord> {
    assertPermission(context, "tenant.read");
    return this.#tenants.get(context.tenantId, context.tenantId) ??
      notFound("tenant");
  }

  async updateTenantConfiguration(
    context: AuthorizedTenantContext,
    patch: TenantConfigurationPatch,
    idempotencyKey: string,
  ): Promise<TenantConfigurationRecord> {
    assertPermission(context, "tenant.write");
    return this.#mutate(
      context,
      "tenant.update",
      idempotencyKey,
      patch,
      () => {
        const current =
          this.#tenants.get(context.tenantId, context.tenantId) ??
          notFound("tenant");
        const now = iso(this.#clock);
        const tenant = {
          ...current.tenant,
          ...(patch.planId === undefined ? {} : { planId: patch.planId }),
          ...(patch.locale === undefined ? {} : { locale: patch.locale }),
          ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
          ...(patch.featureFlags === undefined
            ? {}
            : { featureFlags: patch.featureFlags }),
          ...(patch.limits === undefined ? {} : { limits: patch.limits }),
          resolvedAt: now,
        };
        const updated: TenantConfigurationRecord = {
          ...current,
          ...(patch.displayName === undefined
            ? {}
            : { displayName: requireText(patch.displayName, "displayName") }),
          tenant,
          ...(patch.settings === undefined
            ? {}
            : { settings: patch.settings }),
          version: current.version + 1,
          updatedAt: now,
        };
        this.#tenants.put(context.tenantId, updated);
        this.#audit(context, "tenant.update", "tenant", context.tenantId, {
          version: updated.version,
        });
        return updated;
      },
    );
  }

  async getPublishedBranding(
    context: AuthorizedTenantContext,
  ): Promise<TenantBranding> {
    assertPermission(context, "branding.read");
    const published = this.#branding
      .list(context.tenantId)
      .filter((record) => record.state === "published")
      .sort((left, right) => right.branding.version - left.branding.version)[0];
    return published?.branding ?? notFound("branding");
  }

  async getBrandingDraft(
    context: AuthorizedTenantContext,
  ): Promise<TenantBranding | undefined> {
    assertPermission(context, "branding.read");
    return this.#branding
      .list(context.tenantId)
      .filter((record) => record.state === "draft")
      .sort((left, right) => right.branding.version - left.branding.version)[0]
      ?.branding;
  }

  async saveBrandingDraft(
    context: AuthorizedTenantContext,
    input: BrandingDraftInput,
    idempotencyKey: string,
  ): Promise<TenantBranding> {
    assertPermission(context, "branding.write");
    return this.#mutate(
      context,
      "branding.save_draft",
      idempotencyKey,
      input,
      () => {
        requireText(input.assistant.name, "assistant.name");
        const version = this.#nextBrandingVersion(context.tenantId);
        const branding: TenantBranding = {
          tenantId: context.tenantId,
          version,
          assistant: input.assistant,
          colors: input.colors,
          typography: input.typography,
          launcher: input.launcher,
          attribution: input.attribution,
          voice: input.voice,
          updatedAt: iso(this.#clock),
        };
        this.#branding.put(context.tenantId, {
          tenantId: context.tenantId,
          recordId: String(version),
          branding,
          state: "draft",
        });
        this.#audit(
          context,
          "branding.save_draft",
          "branding",
          String(version),
          { version },
        );
        return branding;
      },
    );
  }

  async publishBranding(
    context: AuthorizedTenantContext,
    version: number,
    idempotencyKey: string,
  ): Promise<TenantBranding> {
    assertPermission(context, "branding.write");
    return this.#mutate(
      context,
      "branding.publish",
      idempotencyKey,
      { version },
      () => {
        const draft = this.#branding.get(context.tenantId, String(version));
        if (draft === undefined || draft.state !== "draft") {
          return notFound("branding_draft");
        }
        const published: BrandingVersionRecord = {
          ...draft,
          state: "published",
          branding: { ...draft.branding, updatedAt: iso(this.#clock) },
        };
        this.#branding.put(context.tenantId, published);
        this.#audit(
          context,
          "branding.publish",
          "branding",
          String(version),
          { version },
        );
        return published.branding;
      },
    );
  }

  async rollbackBranding(
    context: AuthorizedTenantContext,
    targetVersion: number,
    idempotencyKey: string,
  ): Promise<TenantBranding> {
    assertPermission(context, "branding.write");
    return this.#mutate(
      context,
      "branding.rollback",
      idempotencyKey,
      { targetVersion },
      () => {
        const target = this.#branding.get(
          context.tenantId,
          String(targetVersion),
        );
        if (target === undefined || target.state !== "published") {
          return notFound("branding_version");
        }
        const newVersion = this.#nextBrandingVersion(context.tenantId);
        const branding: TenantBranding = {
          ...target.branding,
          tenantId: context.tenantId,
          version: newVersion,
          updatedAt: iso(this.#clock),
        };
        this.#branding.put(context.tenantId, {
          tenantId: context.tenantId,
          recordId: String(newVersion),
          branding,
          state: "published",
        });
        this.#audit(
          context,
          "branding.rollback",
          "branding",
          String(newVersion),
          { targetVersion, version: newVersion },
        );
        return branding;
      },
    );
  }

  async listLearningContextMappings(
    context: AuthorizedTenantContext,
  ): Promise<readonly LearningContextMapping[]> {
    assertPermission(context, "context.read");
    return [...this.#mappings
      .list(context.tenantId)]
      .sort((left, right) => right.priority - left.priority)
      .map(({ recordId: _recordId, ...mapping }) => mapping);
  }

  async upsertLearningContextMapping(
    context: AuthorizedTenantContext,
    input: Omit<
      LearningContextMapping,
      "tenantId" | "mappingId" | "updatedAt"
    > & { readonly mappingId?: string },
    idempotencyKey: string,
  ): Promise<LearningContextMapping> {
    assertPermission(context, "context.write");
    return this.#mutate(
      context,
      "context.mapping_upsert",
      idempotencyKey,
      input,
      () => {
        const mappingId =
          input.mappingId ??
          this.#ids.deterministic(
            "map",
            context.tenantId,
            "context.mapping",
            idempotencyKey,
          );
        const mapping: LearningContextMapping = {
          mappingId,
          tenantId: context.tenantId,
          enabled: input.enabled,
          priority: input.priority,
          match: input.match,
          context: input.context,
          updatedAt: iso(this.#clock),
        };
        this.#mappings.put(context.tenantId, {
          ...mapping,
          recordId: mappingId,
        });
        this.#audit(
          context,
          "context.mapping_upsert",
          "context_mapping",
          mappingId,
          { enabled: mapping.enabled, priority: mapping.priority },
        );
        return mapping;
      },
    );
  }

  async saveStudentProgress(
    context: AuthorizedTenantContext,
    studentId: string,
    progress: StudentLearningProgress,
    idempotencyKey: string,
  ): Promise<StudentProgressRecord> {
    assertPermission(context, "context.write");
    return this.#mutate(
      context,
      "context.progress_save",
      idempotencyKey,
      { studentId, progress },
      () => {
        const normalizedStudentId = requireText(studentId, "studentId");
        const record: ProgressRecord = {
          recordId: `${normalizedStudentId}:${progress.courseId}`,
          tenantId: context.tenantId,
          studentId: normalizedStudentId,
          progress: { ...progress, updatedAt: iso(this.#clock) },
          updatedAt: iso(this.#clock),
        };
        this.#progress.put(context.tenantId, record);
        this.#audit(
          context,
          "context.progress_save",
          "student_progress",
          record.recordId,
          { courseId: progress.courseId },
        );
        const { recordId: _recordId, ...result } = record;
        return result;
      },
    );
  }

  async resolveLearningContext(
    context: AuthorizedTenantContext,
    input: ContextResolutionInput,
  ): Promise<ResolvedLearningContext> {
    assertPermission(context, "context.read");
    if (input.hostContext?.courseId !== undefined) {
      const progress = this.#matchingProgress(
        context.tenantId,
        input.studentId,
        input.hostContext.courseId,
      );
      return {
        ...input.page,
        ...input.hostContext,
        source: "verified_host_context",
        confidence: 1,
        ...(progress === undefined ? {} : { progress }),
        resolvedAt: iso(this.#clock),
      };
    }

    const mapping = this.#mappings
      .list(context.tenantId)
      .filter(
        (candidate) =>
          candidate.enabled && mappingMatches(candidate, input.page.url),
      )
      .sort((left, right) => right.priority - left.priority)[0];
    if (mapping !== undefined) {
      const progress = this.#matchingProgress(
        context.tenantId,
        input.studentId,
        mapping.context.courseId,
      );
      return {
        ...input.page,
        ...mapping.context,
        source: "url_mapping",
        confidence: mapping.match.type === "exact" ? 0.95 : 0.85,
        ...(progress === undefined ? {} : { progress }),
        resolvedAt: iso(this.#clock),
      };
    }

    const resume = this.#latestProgress(context.tenantId, input.studentId);
    if (resume !== undefined) {
      const course = this.#courses.get(
        context.tenantId,
        resume.progress.courseId,
      );
      const module = course?.modules.find(
        (candidate) => candidate.moduleId === resume.progress.moduleId,
      );
      const lesson = module?.lessons.find(
        (candidate) => candidate.lessonId === resume.progress.lessonId,
      );
      return {
        ...input.page,
        courseId: resume.progress.courseId,
        ...(course === undefined ? {} : { course: course.title }),
        ...(module === undefined
          ? {}
          : { moduleId: module.moduleId, module: module.title }),
        ...(lesson === undefined
          ? {}
          : { lessonId: lesson.lessonId, lesson: lesson.title }),
        source: "progress_resume",
        confidence: 0.7,
        progress: resume.progress,
        resolvedAt: iso(this.#clock),
      };
    }

    return {
      ...input.page,
      source: "unknown",
      confidence: 0,
      resolvedAt: iso(this.#clock),
    };
  }

  async listCourses(
    context: AuthorizedTenantContext,
  ): Promise<readonly CourseSummary[]> {
    assertPermission(context, "course.read");
    return this.#courses
      .list(context.tenantId)
      .map(summarizeCourse)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getCourse(
    context: AuthorizedTenantContext,
    courseId: string,
  ): Promise<CourseDraft> {
    assertPermission(context, "course.read");
    return this.#courses.get(context.tenantId, courseId) ?? notFound("course");
  }

  async createCourse(
    context: AuthorizedTenantContext,
    input: {
      readonly title: string;
      readonly slug: string;
      readonly description?: string;
    },
    idempotencyKey: string,
  ): Promise<CourseDraft> {
    assertPermission(context, "course.write");
    return this.#mutate(
      context,
      "course.create",
      idempotencyKey,
      input,
      () => {
        const courseId = this.#ids.deterministic(
          "crs",
          context.tenantId,
          "course.create",
          idempotencyKey,
        );
        const now = iso(this.#clock);
        const course: CourseDraft = {
          courseId,
          tenantId: context.tenantId,
          title: requireText(input.title, "title"),
          slug: requireText(input.slug, "slug"),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          status: "draft",
          version: 1,
          modules: [],
          createdAt: now,
          updatedAt: now,
        };
        this.#courses.put(context.tenantId, course);
        this.#audit(context, "course.create", "course", courseId, {
          version: 1,
        });
        return course;
      },
    );
  }

  async updateCourseMetadata(
    context: AuthorizedTenantContext,
    courseId: string,
    expectedVersion: number,
    patch: {
      readonly title?: string;
      readonly slug?: string;
      readonly description?: string | null;
    },
    idempotencyKey: string,
  ): Promise<CourseDraft> {
    assertPermission(context, "course.write");
    return this.#mutate(
      context,
      "course.update",
      idempotencyKey,
      { courseId, expectedVersion, patch },
      () => {
        const current =
          this.#courses.get(context.tenantId, courseId) ?? notFound("course");
        if (current.version !== expectedVersion) {
          throw new ApplicationError(
            "CONFLICT",
            "The course changed after it was loaded.",
            { expectedVersion, actualVersion: current.version },
          );
        }
        const { description: _description, ...withoutDescription } = current;
        const descriptionBase =
          patch.description === null ? withoutDescription : current;
        const updated: CourseDraft = {
          ...descriptionBase,
          ...(patch.title === undefined
            ? {}
            : { title: requireText(patch.title, "title") }),
          ...(patch.slug === undefined
            ? {}
            : { slug: requireText(patch.slug, "slug") }),
          ...(patch.description === undefined
            ? {}
            : patch.description === null
              ? {}
              : { description: patch.description }),
          version: current.version + 1,
          updatedAt: iso(this.#clock),
        };
        this.#courses.put(context.tenantId, updated);
        this.#audit(context, "course.update", "course", courseId, {
          version: updated.version,
        });
        return updated;
      },
    );
  }

  async publishCourse(
    context: AuthorizedTenantContext,
    courseId: string,
    expectedVersion: number,
    auditNote: string,
    idempotencyKey: string,
  ): Promise<CourseDraft> {
    assertPermission(context, "course.write");
    return this.#mutate(
      context,
      "course.publish",
      idempotencyKey,
      { courseId, expectedVersion, auditNote },
      () => {
        const current =
          this.#courses.get(context.tenantId, courseId) ?? notFound("course");
        if (current.version !== expectedVersion) {
          throw new ApplicationError(
            "CONFLICT",
            "The course changed after it was loaded.",
          );
        }
        requireText(auditNote, "auditNote");
        if (current.modules.length === 0) {
          throw new ApplicationError(
            "VALIDATION_FAILED",
            "A course needs at least one module before publishing.",
          );
        }
        const now = iso(this.#clock);
        const published: CourseDraft = {
          ...current,
          status: "published",
          version: current.version + 1,
          updatedAt: now,
          publishedAt: now,
        };
        this.#courses.put(context.tenantId, published);
        this.#audit(context, "course.publish", "course", courseId, {
          version: published.version,
          auditNote,
        });
        return published;
      },
    );
  }

  async listLearningSources(
    context: AuthorizedTenantContext,
  ): Promise<readonly LearningSource[]> {
    assertPermission(context, "source.read");
    return this.#sources.list(context.tenantId);
  }

  async getLearningSource(
    context: AuthorizedTenantContext,
    sourceId: string,
  ): Promise<LearningSource> {
    assertPermission(context, "source.read");
    return (
      this.#sources.get(context.tenantId, sourceId) ??
      notFound("learning_source")
    );
  }

  async createLearningSource(
    context: AuthorizedTenantContext,
    input: Omit<
      LearningSource,
      "sourceId" | "tenantId" | "status" | "createdAt" | "updatedAt"
    >,
    idempotencyKey: string,
  ): Promise<LearningSource> {
    assertPermission(context, "source.write");
    return this.#mutate(
      context,
      "source.create",
      idempotencyKey,
      input,
      () => {
        const sourceId = this.#ids.deterministic(
          "src",
          context.tenantId,
          "source.create",
          idempotencyKey,
        );
        const now = iso(this.#clock);
        const source: LearningSource = {
          ...input,
          sourceId,
          tenantId: context.tenantId,
          name: requireText(input.name, "name"),
          status: "draft",
          createdAt: now,
          updatedAt: now,
        };
        this.#sources.put(context.tenantId, source);
        this.#audit(context, "source.create", "learning_source", sourceId, {
          type: source.type,
        });
        return source;
      },
    );
  }

  async updateLearningSourceStatus(
    context: AuthorizedTenantContext,
    sourceId: string,
    status: LearningSourceStatus,
    idempotencyKey: string,
  ): Promise<LearningSource> {
    assertPermission(context, "source.write");
    return this.#mutate(
      context,
      "source.status_update",
      idempotencyKey,
      { sourceId, status },
      () => {
        const current =
          this.#sources.get(context.tenantId, sourceId) ??
          notFound("learning_source");
        const updated: LearningSource = {
          ...current,
          status,
          updatedAt: iso(this.#clock),
        };
        this.#sources.put(context.tenantId, updated);
        this.#audit(
          context,
          "source.status_update",
          "learning_source",
          sourceId,
          { status },
        );
        return updated;
      },
    );
  }

  async startIngestionJob(
    context: AuthorizedTenantContext,
    input: StartJobInput,
  ): Promise<IngestionJob> {
    assertPermission(context, "job.write");
    return this.#mutate(
      context,
      "job.start",
      input.idempotencyKey,
      input,
      () => {
        const jobId = this.#ids.deterministic(
          "job",
          context.tenantId,
          input.type,
          input.idempotencyKey,
        );
        const now = iso(this.#clock);
        const job: IngestionJob = {
          jobId,
          tenantId: context.tenantId,
          type: input.type,
          schemaVersion: 1,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
          status: "queued",
          priority: input.priority ?? 50,
          attempt: 0,
          maxAttempts: input.maxAttempts ?? 3,
          traceId: context.traceId,
          ...(input.parentJobId === undefined
            ? {}
            : { parentJobId: input.parentJobId }),
          createdAt: now,
          availableAt: now,
        };
        this.#jobs.put(context.tenantId, job);
        this.#audit(context, "job.start", "ingestion_job", jobId, {
          type: input.type,
        });
        return job;
      },
    );
  }

  async listIngestionJobs(
    context: AuthorizedTenantContext,
  ): Promise<readonly IngestionJob[]> {
    assertPermission(context, "job.read");
    return [...this.#jobs
      .list(context.tenantId)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getIngestionJob(
    context: AuthorizedTenantContext,
    jobId: string,
  ): Promise<IngestionJob> {
    assertPermission(context, "job.read");
    return this.#jobs.get(context.tenantId, jobId) ?? notFound("ingestion_job");
  }

  async updateIngestionJobStatus(
    context: AuthorizedTenantContext,
    jobId: string,
    status: IngestionJobStatus,
    idempotencyKey: string,
  ): Promise<IngestionJob> {
    assertPermission(context, "job.write");
    return this.#mutate(
      context,
      "job.status_update",
      idempotencyKey,
      { jobId, status },
      () => {
        const current =
          this.#jobs.get(context.tenantId, jobId) ??
          notFound("ingestion_job");
        if (isTerminalJob(current.status) && status !== current.status) {
          throw new ApplicationError(
            "CONFLICT",
            "A terminal ingestion job cannot change status.",
          );
        }
        const now = iso(this.#clock);
        const updated: IngestionJob = {
          ...current,
          status,
          ...(status === "running" && current.startedAt === undefined
            ? { startedAt: now, attempt: current.attempt + 1 }
            : {}),
          ...(isTerminalJob(status) ? { completedAt: now } : {}),
        };
        this.#jobs.put(context.tenantId, updated);
        this.#audit(
          context,
          "job.status_update",
          "ingestion_job",
          jobId,
          { status },
        );
        return updated;
      },
    );
  }

  async createConversation(
    context: AuthorizedTenantContext,
    input: CreateConversationInput,
  ): Promise<Conversation> {
    assertPermission(context, "conversation.write");
    return this.#mutate(
      context,
      "conversation.create",
      input.idempotencyKey,
      input,
      () => {
        if (
          context.role === "student" &&
          input.studentId !== undefined &&
          input.studentId !== context.actor.id
        ) {
          throw new ApplicationError(
            "PERMISSION_DENIED",
            "A student cannot create a conversation for another student.",
          );
        }
        const id = this.#ids.deterministic(
          "cnv",
          context.tenantId,
          "conversation.create",
          input.idempotencyKey,
        );
        const now = iso(this.#clock);
        const conversation: Conversation = {
          id,
          tenantId: context.tenantId,
          ...(input.studentId === undefined
            ? context.role === "student" && context.actor.id !== undefined
              ? { studentId: context.actor.id }
              : {}
            : { studentId: input.studentId }),
          identityTier: input.identityTier,
          status: "active",
          activeModality: input.activeModality,
          ...(input.pageContext === undefined
            ? {}
            : { pageContext: input.pageContext }),
          startedAt: now,
          updatedAt: now,
        };
        this.#conversations.put(context.tenantId, conversation);
        this.#audit(
          context,
          "conversation.create",
          "conversation",
          id,
          { modality: input.activeModality },
        );
        return conversation;
      },
    );
  }

  async getConversation(
    context: AuthorizedTenantContext,
    conversationId: string,
  ): Promise<Conversation> {
    assertPermission(context, "conversation.read");
    const conversation =
      this.#conversations.get(context.tenantId, conversationId) ??
      notFound("conversation");
    this.#assertStudentOwns(context, conversation.studentId);
    return conversation;
  }

  async setConversationModality(
    context: AuthorizedTenantContext,
    conversationId: string,
    modality: ConversationModality,
    idempotencyKey: string,
  ): Promise<Conversation> {
    assertPermission(context, "conversation.write");
    return this.#mutate(
      context,
      "conversation.modality_update",
      idempotencyKey,
      { conversationId, modality },
      () => {
        const current =
          this.#conversations.get(context.tenantId, conversationId) ??
          notFound("conversation");
        this.#assertStudentOwns(context, current.studentId);
        const updated: Conversation = {
          ...current,
          activeModality: modality,
          updatedAt: iso(this.#clock),
        };
        this.#conversations.put(context.tenantId, updated);
        this.#audit(
          context,
          "conversation.modality_update",
          "conversation",
          conversationId,
          { modality },
        );
        return updated;
      },
    );
  }

  async createAttachment(
    context: AuthorizedTenantContext,
    input: CreateAttachmentInput,
  ): Promise<ChatAttachment> {
    assertPermission(context, "attachment.write");
    return this.#mutate(
      context,
      "attachment.create",
      input.idempotencyKey,
      input,
      () => {
        const conversation =
          this.#conversations.get(context.tenantId, input.conversationId) ??
          notFound("conversation");
        this.#assertStudentOwns(context, conversation.studentId);
        if (input.sizeBytes <= 0) {
          throw new ApplicationError(
            "VALIDATION_FAILED",
            "Attachment size must be positive.",
          );
        }
        const attachmentId = this.#ids.deterministic(
          "att",
          context.tenantId,
          input.conversationId,
          input.idempotencyKey,
        );
        const attachment: ChatAttachment = {
          attachmentId,
          tenantId: context.tenantId,
          conversationId: input.conversationId,
          kind: input.kind,
          fileName: requireText(input.fileName, "fileName"),
          mediaType: requireText(input.mediaType, "mediaType"),
          sizeBytes: input.sizeBytes,
          ...(input.contentHash === undefined
            ? {}
            : { contentHash: input.contentHash }),
          status: "pending_upload",
          createdAt: iso(this.#clock),
        };
        this.#attachments.put(context.tenantId, attachment);
        this.#audit(
          context,
          "attachment.create",
          "attachment",
          attachmentId,
          { kind: input.kind, sizeBytes: input.sizeBytes },
        );
        return attachment;
      },
    );
  }

  async getAttachment(
    context: AuthorizedTenantContext,
    attachmentId: string,
  ): Promise<ChatAttachment> {
    assertPermission(context, "attachment.read");
    const attachment =
      this.#attachments.get(context.tenantId, attachmentId) ??
      notFound("attachment");
    const conversation =
      this.#conversations.get(context.tenantId, attachment.conversationId) ??
      notFound("conversation");
    this.#assertStudentOwns(context, conversation.studentId);
    return attachment;
  }

  async updateAttachmentStatus(
    context: AuthorizedTenantContext,
    attachmentId: string,
    status: AttachmentProcessingStatus,
    idempotencyKey: string,
  ): Promise<ChatAttachment> {
    assertPermission(context, "attachment.write");
    return this.#mutate(
      context,
      "attachment.status_update",
      idempotencyKey,
      { attachmentId, status },
      () => {
        const current =
          this.#attachments.get(context.tenantId, attachmentId) ??
          notFound("attachment");
        const conversation =
          this.#conversations.get(context.tenantId, current.conversationId) ??
          notFound("conversation");
        this.#assertStudentOwns(context, conversation.studentId);
        const updated: ChatAttachment = { ...current, status };
        this.#attachments.put(context.tenantId, updated);
        this.#audit(
          context,
          "attachment.status_update",
          "attachment",
          attachmentId,
          { status },
        );
        return updated;
      },
    );
  }

  async listAuditRecords(
    context: AuthorizedTenantContext,
  ): Promise<readonly AuditRecord[]> {
    assertPermission(context, "audit.read");
    return [...this.#audits
      .list(context.tenantId)]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  async recordCost(
    context: AuthorizedTenantContext,
    input: CostRecordInput,
  ): Promise<CostLedgerEntry> {
    assertPermission(context, "cost.write");
    return this.#mutate(
      context,
      "cost.record",
      input.idempotencyKey,
      input,
      () => {
        if (input.amount < 0) {
          throw new ApplicationError(
            "VALIDATION_FAILED",
            "Cost cannot be negative.",
          );
        }
        const now = iso(this.#clock);
        const costEntryId = this.#ids.deterministic(
          "cst",
          context.tenantId,
          `${input.referenceType}:${input.referenceId}`,
          input.idempotencyKey,
        );
        const entry: CostLedgerEntry = {
          costEntryId,
          tenantId: context.tenantId,
          requestId: context.requestId,
          ...(context.actor.id === undefined
            ? {}
            : { actorId: context.actor.id }),
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          ...(input.attemptId === undefined
            ? {}
            : { attemptId: input.attemptId }),
          feature: requireText(input.feature, "feature"),
          capability: input.capability,
          provider: requireText(input.provider, "provider"),
          adapterId: requireText(input.adapterId, "adapterId"),
          ...(input.modelOrSku === undefined
            ? {}
            : { modelOrSku: input.modelOrSku }),
          quantities: input.quantities,
          cost: {
            amount: input.amount,
            currency: requireText(input.currency, "currency"),
            status: input.status,
          },
          fundingSource: context.fundingSource,
          occurredAt: input.occurredAt ?? now,
          recordedAt: now,
          traceId: context.traceId,
          ...(input.safeMetadata === undefined
            ? {}
            : { safeMetadata: input.safeMetadata }),
        };
        this.#costs.put(context.tenantId, entry);
        this.#audit(context, "cost.record", "cost_entry", costEntryId, {
          capability: input.capability,
          amount: input.amount,
          currency: input.currency,
        });
        return entry;
      },
    );
  }

  async listCosts(
    context: AuthorizedTenantContext,
  ): Promise<readonly CostLedgerEntry[]> {
    assertPermission(context, "cost.read");
    return [...this.#costs
      .list(context.tenantId)]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  async summarizeCosts(
    context: AuthorizedTenantContext,
    from: string,
    through: string,
    currency: string,
  ): Promise<CostSummary> {
    assertPermission(context, "cost.read");
    const entries = this.#costs
      .list(context.tenantId)
      .filter(
        (entry) =>
          entry.occurredAt >= from &&
          entry.occurredAt <= through &&
          entry.cost.currency === currency &&
          entry.cost.status !== "voided",
      );
    return {
      tenantId: context.tenantId,
      from,
      through,
      currency,
      estimatedCost: entries
        .filter((entry) => entry.cost.status === "estimated")
        .reduce((total, entry) => total + entry.cost.amount, 0),
      finalCost: entries
        .filter((entry) => entry.cost.status === "final")
        .reduce((total, entry) => total + entry.cost.amount, 0),
      invoicedCost: entries
        .filter((entry) => entry.cost.status === "reconciled")
        .reduce((total, entry) => total + entry.cost.amount, 0),
      entryCount: entries.length,
      partial: false,
    };
  }

  #nextBrandingVersion(tenantId: string): number {
    return (
      Math.max(
        0,
        ...this.#branding
          .list(tenantId)
          .map((record) => record.branding.version),
      ) + 1
    );
  }

  #matchingProgress(
    tenantId: string,
    studentId: string | undefined,
    courseId: string,
  ): StudentLearningProgress | undefined {
    if (studentId === undefined) return undefined;
    return this.#progress.get(tenantId, `${studentId}:${courseId}`)?.progress;
  }

  #latestProgress(
    tenantId: string,
    studentId: string | undefined,
  ): ProgressRecord | undefined {
    if (studentId === undefined) return undefined;
    return this.#progress
      .list(tenantId)
      .filter((record) => record.studentId === studentId)
      .sort((left, right) =>
        right.progress.updatedAt.localeCompare(left.progress.updatedAt),
      )[0];
  }

  #assertStudentOwns(
    context: AuthorizedTenantContext,
    studentId: string | undefined,
  ): void {
    if (
      context.role === "student" &&
      (studentId === undefined || studentId !== context.actor.id)
    ) {
      throw new ApplicationError(
        "RESOURCE_NOT_FOUND",
        "The requested resource was not found.",
      );
    }
  }

  #audit(
    context: AuthorizedTenantContext,
    action: string,
    resourceType: string,
    resourceId: string,
    safeMetadata: AuditRecord["safeMetadata"],
  ): void {
    const auditId = this.#ids.deterministic(
      "aud",
      context.tenantId,
      `${context.requestId}:${action}`,
      resourceId,
    );
    const record: AuditRecord = {
      auditId,
      tenantId: context.tenantId,
      ...(context.actor.id === undefined
        ? {}
        : { actorId: context.actor.id }),
      actorRole: context.role,
      action,
      resourceType,
      resourceId,
      requestId: context.requestId,
      traceId: context.traceId,
      occurredAt: iso(this.#clock),
      safeMetadata,
    };
    this.#audits.put(context.tenantId, record);
  }

  #mutate<T>(
    context: AuthorizedTenantContext,
    scope: string,
    idempotencyKey: string,
    input: unknown,
    operation: () => T,
  ): T {
    const fingerprint = stableStringify(input);
    const replay = this.#idempotency.replay<T>(
      context.tenantId,
      scope,
      idempotencyKey,
      fingerprint,
    );
    if (replay !== undefined) return replay;
    const value = operation();
    return this.#idempotency.remember(
      context.tenantId,
      scope,
      idempotencyKey,
      fingerprint,
      value,
    );
  }
}
