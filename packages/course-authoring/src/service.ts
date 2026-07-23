import type {
  ApplyCourseEditsInput,
  ApplyCourseEditsResult,
  ContentBlock,
  CourseDraft,
  CourseEditOperation,
  CourseEditorService,
  CourseLesson,
  CourseModule,
  CourseValidationResult,
  PublishCourseInput,
  RequestContext,
} from "@course-ai/contracts";
import { AuthoringError, requireAuthoring } from "./errors.js";
import { deterministicId, fingerprint } from "./ids.js";
import { DEFAULT_URL_POLICY, sanitizeBlock, sanitizeText, type UrlPolicy } from "./sanitizer.js";
import type {
  CommandReceipt,
  CourseAuthoringCommand,
  CourseAuthoringOperation,
  CourseAuthoringRepository,
  CourseRevision,
  CreateCourseCommand,
  NewContentBlock,
  PublishCommand,
  RollbackCommand,
} from "./types.js";
import { validateCourse } from "./validation.js";

export interface CourseAuthoringServiceOptions {
  readonly now?: () => Date;
  readonly urlPolicy?: UrlPolicy;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function assertContext(context: RequestContext): void {
  requireAuthoring(
    context.tenantId.trim().length > 0,
    "authoring.tenant_mismatch",
    "A trusted tenant scope is required.",
  );
  requireAuthoring(
    context.deadlineMs > Date.now(),
    "authoring.deadline_exceeded",
    "The authoring request deadline has expired.",
  );
  requireAuthoring(
    context.actor.type === "creator" ||
      context.actor.type === "owner" ||
      context.actor.type === "system",
    "authoring.unauthorized",
    "This actor cannot author courses.",
  );
}

function normalizePositions<T extends { readonly position: number }>(
  values: readonly T[],
): T[] {
  return values.map((value, position) => ({ ...value, position }));
}

function insertAt<T>(values: readonly T[], position: number, value: T): T[] {
  requireAuthoring(
    Number.isInteger(position) && position >= 0 && position <= values.length,
    "authoring.invalid_input",
    "Insert position is outside the collection.",
  );
  const result = [...values];
  result.splice(position, 0, value);
  return result;
}

function moveTo<T>(values: readonly T[], from: number, position: number): T[] {
  requireAuthoring(
    from >= 0 && Number.isInteger(position) && position >= 0 && position < values.length,
    "authoring.invalid_input",
    "Move position is outside the collection.",
  );
  const result = [...values];
  const [item] = result.splice(from, 1);
  requireAuthoring(item !== undefined, "authoring.not_found", "Item was not found.");
  result.splice(position, 0, item);
  return result;
}

function findLesson(
  modules: readonly CourseModule[],
  lessonId: string,
): { readonly moduleIndex: number; readonly lessonIndex: number; readonly lesson: CourseLesson } {
  for (const [moduleIndex, module] of modules.entries()) {
    const lessonIndex = module.lessons.findIndex((lesson) => lesson.lessonId === lessonId);
    if (lessonIndex >= 0) {
      return { moduleIndex, lessonIndex, lesson: module.lessons[lessonIndex]! };
    }
  }
  throw new AuthoringError("authoring.not_found", "Lesson was not found.", { lessonId });
}

function replaceLesson(
  modules: CourseModule[],
  moduleIndex: number,
  lessonIndex: number,
  lesson: CourseLesson,
): void {
  const module = modules[moduleIndex]!;
  const lessons = [...module.lessons];
  lessons[lessonIndex] = lesson;
  modules[moduleIndex] = { ...module, lessons };
}

function normalizeNewBlock(
  block: NewContentBlock,
  namespace: string,
  ordinal: string,
  policy: UrlPolicy,
): ContentBlock {
  const candidate = block as Partial<ContentBlock>;
  const withId = {
    ...block,
    id:
      typeof candidate.id === "string" && candidate.id.trim()
        ? candidate.id
        : deterministicId("block", namespace, ordinal, block),
  } as ContentBlock;
  return sanitizeBlock(withId, policy);
}

function ensureUniqueIds(course: CourseDraft): void {
  const seen = new Set<string>();
  for (const module of course.modules) {
    requireAuthoring(
      !seen.has(module.moduleId),
      "authoring.invalid_input",
      "Module id already exists.",
    );
    seen.add(module.moduleId);
    for (const lesson of module.lessons) {
      requireAuthoring(
        !seen.has(lesson.lessonId),
        "authoring.invalid_input",
        "Lesson id already exists.",
      );
      seen.add(lesson.lessonId);
      for (const block of lesson.blocks) {
        requireAuthoring(
          !seen.has(block.id),
          "authoring.invalid_input",
          "Block id already exists.",
        );
        seen.add(block.id);
      }
    }
  }
}

export class CourseAuthoringService implements CourseEditorService {
  readonly #repository: CourseAuthoringRepository;
  readonly #now: () => Date;
  readonly #urlPolicy: UrlPolicy;

  constructor(
    repository: CourseAuthoringRepository,
    options: CourseAuthoringServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date());
    this.#urlPolicy = options.urlPolicy ?? DEFAULT_URL_POLICY;
  }

  async create(context: RequestContext, command: CreateCourseCommand): Promise<CourseDraft> {
    assertContext(context);
    const commandFingerprint = fingerprint({ kind: "create", command });
    const replay = await this.#replay<CourseDraft>(
      context.tenantId,
      command.idempotencyKey,
      commandFingerprint,
    );
    if (replay) return replay;

    const createdAt = nowIso(this.#now);
    const courseId = deterministicId(
      "course",
      context.tenantId,
      command.idempotencyKey,
      { title: command.title, slug: command.slug },
    );
    const course: CourseDraft = {
      courseId,
      tenantId: context.tenantId,
      title: sanitizeText(command.title, "course title").trim(),
      slug: sanitizeText(command.slug, "course slug").trim(),
      ...(command.description === undefined
        ? {}
        : { description: sanitizeText(command.description, "course description") }),
      status: "draft",
      version: 1,
      modules: [],
      createdAt,
      updatedAt: createdAt,
    };
    const validation = validateCourse(course);
    requireAuthoring(
      !validation.issues.some((issue) => issue.severity === "error"),
      "authoring.validation_failed",
      "Course metadata is invalid.",
    );
    const revision = this.#revision(context, course, "created", command.idempotencyKey);
    const receipt = this.#receipt(context, command.idempotencyKey, commandFingerprint, course);
    await this.#repository.create(course, revision, receipt);
    return clone(course);
  }

  async createCourse(
    context: RequestContext,
    input: Pick<CourseDraft, "title" | "slug" | "description">,
  ): Promise<CourseDraft> {
    return this.create(context, {
      idempotencyKey: `create:${context.requestId}`,
      title: input.title,
      slug: input.slug,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
  }

  async getCourse(context: RequestContext, courseId: string): Promise<CourseDraft> {
    assertContext(context);
    return this.#getScoped(context, courseId);
  }

  async execute(
    context: RequestContext,
    command: CourseAuthoringCommand,
  ): Promise<ApplyCourseEditsResult> {
    assertContext(context);
    requireAuthoring(
      typeof command.courseId === "string" &&
        command.courseId.trim().length > 0 &&
        Number.isInteger(command.expectedVersion) &&
        command.expectedVersion >= 1 &&
        isRuntimeArray(command.operations) &&
        command.operations.length > 0,
      "authoring.invalid_input",
      "Course id, expected version, and at least one operation are required.",
    );
    const commandFingerprint = fingerprint({ kind: "edit", command });
    const replay = await this.#replay<ApplyCourseEditsResult>(
      context.tenantId,
      command.idempotencyKey,
      commandFingerprint,
    );
    if (replay) return replay;

    const current = await this.#getScoped(context, command.courseId);
    requireAuthoring(
      current.version === command.expectedVersion,
      "authoring.version_conflict",
      "Course changed since this edit began.",
      { expectedVersion: command.expectedVersion, actualVersion: current.version },
    );

    let modules = current.modules.map((module) => ({
      ...clone(module),
      lessons: [...clone(module.lessons)],
    }));
    let title = current.title;
    let slug = current.slug;
    let description = current.description;

    command.operations.forEach((operation, operationIndex) => {
      const namespace = `${context.tenantId}:${command.courseId}:${command.idempotencyKey}`;
      switch (operation.op) {
        case "course.update":
          if (operation.patch.title !== undefined) {
            title = sanitizeText(operation.patch.title).trim();
          }
          if (operation.patch.slug !== undefined) {
            slug = sanitizeText(operation.patch.slug).trim();
          }
          if (operation.patch.description !== undefined) {
            description =
              operation.patch.description === null
                ? undefined
                : sanitizeText(operation.patch.description);
          }
          break;
        case "module.create": {
          const moduleId =
            operation.moduleId ??
            deterministicId("module", namespace, operationIndex, operation);
          const position = operation.position ?? modules.length;
          modules = normalizePositions(
            insertAt(modules, position, {
              moduleId,
              title: sanitizeText(operation.title).trim(),
              ...(operation.description === undefined
                ? {}
                : { description: sanitizeText(operation.description) }),
              position,
              lessons: [],
            }),
          );
          break;
        }
        case "module.update": {
          const index = modules.findIndex((module) => module.moduleId === operation.moduleId);
          requireAuthoring(index >= 0, "authoring.not_found", "Module was not found.");
          const module = modules[index]!;
          let updatedModule = {
            ...module,
            lessons: [...module.lessons],
            ...(operation.patch.title === undefined
              ? {}
              : { title: sanitizeText(operation.patch.title).trim() }),
          };
          if (operation.patch.description === null) {
            const { description: _removed, ...withoutDescription } = updatedModule;
            updatedModule = withoutDescription;
          } else if (operation.patch.description !== undefined) {
            updatedModule = {
              ...updatedModule,
              description: sanitizeText(operation.patch.description),
            };
          }
          modules[index] = updatedModule;
          break;
        }
        case "module.move": {
          const index = modules.findIndex((module) => module.moduleId === operation.moduleId);
          requireAuthoring(index >= 0, "authoring.not_found", "Module was not found.");
          modules = normalizePositions(moveTo(modules, index, operation.position));
          break;
        }
        case "module.delete": {
          const index = modules.findIndex((module) => module.moduleId === operation.moduleId);
          requireAuthoring(index >= 0, "authoring.not_found", "Module was not found.");
          modules.splice(index, 1);
          modules = normalizePositions(modules);
          break;
        }
        case "lesson.create": {
          const moduleIndex = modules.findIndex(
            (module) => module.moduleId === operation.moduleId,
          );
          requireAuthoring(moduleIndex >= 0, "authoring.not_found", "Module was not found.");
          const module = modules[moduleIndex]!;
          const lessonId =
            operation.lessonId ??
            deterministicId("lesson", namespace, operationIndex, operation);
          const position = operation.position ?? module.lessons.length;
          const updatedAt = nowIso(this.#now);
          const lesson: CourseLesson = {
            lessonId,
            title: sanitizeText(operation.title).trim(),
            slug: sanitizeText(operation.slug).trim(),
            ...(operation.description === undefined
              ? {}
              : { description: sanitizeText(operation.description) }),
            position,
            status: "draft",
            blocks: [],
            sourceDocumentIds: [],
            ...(operation.estimatedMinutes === undefined
              ? {}
              : { estimatedMinutes: operation.estimatedMinutes }),
            updatedAt,
          };
          modules[moduleIndex] = {
            ...module,
            lessons: normalizePositions(insertAt(module.lessons, position, lesson)),
          };
          break;
        }
        case "lesson.update": {
          const found = findLesson(modules, operation.lessonId);
          const patch = operation.patch;
          let lesson: CourseLesson = {
            ...found.lesson,
            ...(patch.title === undefined
              ? {}
              : { title: sanitizeText(patch.title).trim() }),
            ...(patch.slug === undefined ? {} : { slug: sanitizeText(patch.slug).trim() }),
            ...(patch.status === undefined ? {} : { status: patch.status }),
            updatedAt: nowIso(this.#now),
          };
          if (patch.description === null) {
            const { description: _removed, ...withoutDescription } = lesson;
            lesson = withoutDescription;
          } else if (patch.description !== undefined) {
            lesson = { ...lesson, description: sanitizeText(patch.description) };
          }
          if (patch.estimatedMinutes === null) {
            const { estimatedMinutes: _removed, ...withoutEstimate } = lesson;
            lesson = withoutEstimate;
          } else if (patch.estimatedMinutes !== undefined) {
            lesson = { ...lesson, estimatedMinutes: patch.estimatedMinutes };
          }
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, lesson);
          break;
        }
        case "lesson.move": {
          const found = findLesson(modules, operation.lessonId);
          const sourceModule = modules[found.moduleIndex]!;
          const sourceLessons = [...sourceModule.lessons];
          sourceLessons.splice(found.lessonIndex, 1);
          modules[found.moduleIndex] = {
            ...sourceModule,
            lessons: normalizePositions(sourceLessons),
          };
          const targetIndex = modules.findIndex(
            (module) => module.moduleId === operation.moduleId,
          );
          requireAuthoring(targetIndex >= 0, "authoring.not_found", "Target module was not found.");
          const targetModule = modules[targetIndex]!;
          modules[targetIndex] = {
            ...targetModule,
            lessons: normalizePositions(
              insertAt(targetModule.lessons, operation.position, found.lesson),
            ),
          };
          break;
        }
        case "lesson.delete": {
          const found = findLesson(modules, operation.lessonId);
          const module = modules[found.moduleIndex]!;
          const lessons = [...module.lessons];
          lessons.splice(found.lessonIndex, 1);
          modules[found.moduleIndex] = { ...module, lessons: normalizePositions(lessons) };
          break;
        }
        case "block.insert": {
          const found = findLesson(modules, operation.lessonId);
          let blocks = [...found.lesson.blocks];
          operation.blocks.forEach((block, blockIndex) => {
            const normalized = normalizeNewBlock(
              block,
              namespace,
              `${operationIndex}:${blockIndex}`,
              this.#urlPolicy,
            );
            requireAuthoring(
              normalized.type !== "diagram",
              "authoring.validation_failed",
              "Diagram candidates must use the approval operation.",
            );
            blocks = insertAt(blocks, operation.position + blockIndex, normalized);
          });
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, {
            ...found.lesson,
            blocks,
            updatedAt: nowIso(this.#now),
          });
          break;
        }
        case "block.update": {
          const found = findLesson(modules, operation.lessonId);
          const index = found.lesson.blocks.findIndex((block) => block.id === operation.blockId);
          requireAuthoring(index >= 0, "authoring.not_found", "Block was not found.");
          const block = normalizeNewBlock(
            { ...operation.block, id: operation.blockId } as NewContentBlock,
            namespace,
            String(operationIndex),
            this.#urlPolicy,
          );
          const existing = found.lesson.blocks[index]!;
          requireAuthoring(
            block.type !== "diagram" ||
              (existing.type === "diagram" &&
                existing.metadata?.approvalStatus === "approved" &&
                block.metadata?.approvalStatus === "approved" &&
                existing.metadata.diagramCandidateId ===
                  block.metadata.diagramCandidateId),
            "authoring.validation_failed",
            "New or substituted diagram candidates must use the approval operation.",
          );
          const blocks = [...found.lesson.blocks];
          blocks[index] = block;
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, {
            ...found.lesson,
            blocks,
            updatedAt: nowIso(this.#now),
          });
          break;
        }
        case "block.move": {
          const found = findLesson(modules, operation.lessonId);
          const index = found.lesson.blocks.findIndex((block) => block.id === operation.blockId);
          requireAuthoring(index >= 0, "authoring.not_found", "Block was not found.");
          const blocks = moveTo(found.lesson.blocks, index, operation.position);
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, {
            ...found.lesson,
            blocks,
            updatedAt: nowIso(this.#now),
          });
          break;
        }
        case "block.delete": {
          const found = findLesson(modules, operation.lessonId);
          const ids = new Set(operation.blockIds);
          requireAuthoring(
            ids.size === operation.blockIds.length &&
              [...ids].every((id) =>
                found.lesson.blocks.some((block) => block.id === id),
              ),
            "authoring.not_found",
            "One or more requested blocks were not found.",
          );
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, {
            ...found.lesson,
            blocks: found.lesson.blocks.filter((block) => !ids.has(block.id)),
            updatedAt: nowIso(this.#now),
          });
          break;
        }
        case "block.replace": {
          const found = findLesson(modules, operation.lessonId);
          const blocks = operation.blocks.map((block, blockIndex) => {
            const normalized = normalizeNewBlock(
              block,
              namespace,
              `${operationIndex}:${blockIndex}`,
              this.#urlPolicy,
            );
            requireAuthoring(
              normalized.type !== "diagram",
              "authoring.validation_failed",
              "Diagram candidates must use the approval operation.",
            );
            return normalized;
          });
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, {
            ...found.lesson,
            blocks,
            updatedAt: nowIso(this.#now),
          });
          break;
        }
        case "diagram.approve": {
          requireAuthoring(
            operation.candidate.tenantId === context.tenantId,
            "authoring.tenant_mismatch",
            "A diagram candidate cannot cross tenant boundaries.",
          );
          requireAuthoring(
            operation.altText.trim().length >= 5 && operation.caption.trim().length > 0,
            "authoring.validation_failed",
            "Approved diagrams require meaningful alt text and a caption.",
          );
          const found = findLesson(modules, operation.lessonId);
          const block = sanitizeBlock(
            {
              id: deterministicId("block", namespace, operationIndex, operation.candidate),
              type: "diagram",
              assetId: operation.candidate.assetId,
              altText: operation.altText,
              caption: operation.caption,
              ...(operation.layout === undefined ? {} : { layout: operation.layout }),
              metadata: {
                approvalStatus: "approved",
                diagramCandidateId: operation.candidate.candidateId,
              },
            },
            this.#urlPolicy,
          );
          replaceLesson(modules, found.moduleIndex, found.lessonIndex, {
            ...found.lesson,
            blocks: insertAt(found.lesson.blocks, operation.position, block),
            updatedAt: nowIso(this.#now),
          });
          break;
        }
        default: {
          const unsupported = operation as { readonly op?: unknown };
          throw new AuthoringError(
            "authoring.invalid_input",
            `Unsupported authoring operation: ${String(unsupported.op)}`,
          );
        }
      }
    });

    const updatedAt = nowIso(this.#now);
    let course: CourseDraft = {
      ...current,
      title,
      slug,
      status: "draft",
      version: current.version + 1,
      modules,
      updatedAt,
    };
    if (course.publishedAt !== undefined) {
      const { publishedAt: _removed, ...withoutPublishedAt } = course;
      course = withoutPublishedAt;
    }
    if (description === undefined) {
      const { description: _removed, ...withoutDescription } = course;
      course = withoutDescription;
    } else {
      course = { ...course, description };
    }
    ensureUniqueIds(course);
    const validation = validateCourse(course);
    requireAuthoring(
      !validation.issues.some((issue) => issue.severity === "error"),
      "authoring.validation_failed",
      "The edit would leave invalid course content.",
    );
    const result: ApplyCourseEditsResult = {
      course,
      appliedOperationCount: command.operations.length,
      warnings: validation.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.message),
    };
    await this.#repository.commit({
      tenantId: context.tenantId,
      courseId: command.courseId,
      expectedVersion: command.expectedVersion,
      course,
      revision: this.#revision(
        context,
        course,
        "edited",
        command.idempotencyKey,
        command.auditNote,
      ),
      receipt: this.#receipt(
        context,
        command.idempotencyKey,
        commandFingerprint,
        result,
      ),
    });
    return clone(result);
  }

  async applyEdits(
    context: RequestContext,
    input: ApplyCourseEditsInput,
  ): Promise<ApplyCourseEditsResult> {
    return this.execute(context, {
      courseId: input.courseId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      operations: input.operations.flatMap((operation) =>
        this.#translateOperation(operation),
      ),
      ...(input.auditNote === undefined ? {} : { auditNote: input.auditNote }),
    });
  }

  async validate(
    context: RequestContext,
    courseId: string,
  ): Promise<CourseValidationResult> {
    const course = await this.getCourse(context, courseId);
    return validateCourse(course, "draft");
  }

  async publish(context: RequestContext, command: PublishCommand): Promise<CourseDraft> {
    assertContext(context);
    const commandFingerprint = fingerprint({ kind: "publish", command });
    const replay = await this.#replay<CourseDraft>(
      context.tenantId,
      command.idempotencyKey,
      commandFingerprint,
    );
    if (replay) return replay;
    requireAuthoring(
      command.auditNote.trim().length > 0,
      "authoring.invalid_input",
      "Publishing requires an audit note.",
    );
    const current = await this.#getScoped(context, command.courseId);
    requireAuthoring(
      current.version === command.expectedVersion,
      "authoring.version_conflict",
      "Course changed before publishing.",
      { expectedVersion: command.expectedVersion, actualVersion: current.version },
    );
    const validation = validateCourse(current, "publish");
    requireAuthoring(
      validation.valid,
      "authoring.validation_failed",
      "Course is not ready to publish.",
      { errorCount: validation.issues.filter((issue) => issue.severity === "error").length },
    );
    const publishedAt = nowIso(this.#now);
    const course: CourseDraft = {
      ...current,
      status: "published",
      version: current.version + 1,
      modules: current.modules.map((module) => ({
        ...module,
        lessons: module.lessons.map((lesson) => ({ ...lesson, status: "published" })),
      })),
      updatedAt: publishedAt,
      publishedAt,
    };
    await this.#repository.commit({
      tenantId: context.tenantId,
      courseId: course.courseId,
      expectedVersion: command.expectedVersion,
      course,
      revision: this.#revision(
        context,
        course,
        "published",
        command.idempotencyKey,
        command.auditNote,
      ),
      receipt: this.#receipt(
        context,
        command.idempotencyKey,
        commandFingerprint,
        course,
      ),
    });
    return clone(course);
  }

  async publishCourse(
    context: RequestContext,
    input: PublishCourseInput,
  ): Promise<CourseDraft> {
    return this.publish(context, {
      ...input,
      idempotencyKey: `publish:${context.requestId}`,
    });
  }

  async rollback(context: RequestContext, command: RollbackCommand): Promise<CourseDraft> {
    assertContext(context);
    const commandFingerprint = fingerprint({ kind: "rollback", command });
    const replay = await this.#replay<CourseDraft>(
      context.tenantId,
      command.idempotencyKey,
      commandFingerprint,
    );
    if (replay) return replay;
    requireAuthoring(
      command.auditNote.trim().length > 0,
      "authoring.invalid_input",
      "Rollback requires an audit note.",
    );
    const current = await this.#getScoped(context, command.courseId);
    requireAuthoring(
      current.version === command.expectedVersion,
      "authoring.version_conflict",
      "Course changed before rollback.",
      { expectedVersion: command.expectedVersion, actualVersion: current.version },
    );
    const target = await this.#repository.getRevision(
      context.tenantId,
      command.courseId,
      command.targetVersion,
    );
    requireAuthoring(
      target !== undefined,
      "authoring.not_found",
      "Rollback target revision was not found.",
      { targetVersion: command.targetVersion },
    );
    const updatedAt = nowIso(this.#now);
    let course: CourseDraft = {
      ...clone(target.snapshot),
      version: current.version + 1,
      updatedAt,
    };
    if (target.snapshot.status !== "published") {
      const { publishedAt: _removed, ...withoutPublishedAt } = course;
      course = withoutPublishedAt;
    }
    const revision = {
      ...this.#revision(
        context,
        course,
        "rolled_back",
        command.idempotencyKey,
        command.auditNote,
      ),
      rollbackTargetVersion: command.targetVersion,
    };
    await this.#repository.commit({
      tenantId: context.tenantId,
      courseId: course.courseId,
      expectedVersion: command.expectedVersion,
      course,
      revision,
      receipt: this.#receipt(
        context,
        command.idempotencyKey,
        commandFingerprint,
        course,
      ),
    });
    return clone(course);
  }

  async listRevisions(
    context: RequestContext,
    courseId: string,
  ): Promise<readonly CourseRevision[]> {
    assertContext(context);
    await this.#getScoped(context, courseId);
    return this.#repository.listRevisions(context.tenantId, courseId);
  }

  async #getScoped(context: RequestContext, courseId: string): Promise<CourseDraft> {
    const course = await this.#repository.get(context.tenantId, courseId);
    requireAuthoring(
      course !== undefined,
      "authoring.not_found",
      "Course was not found in this tenant.",
      { courseId },
    );
    requireAuthoring(
      course.tenantId === context.tenantId,
      "authoring.tenant_mismatch",
      "Course belongs to another tenant.",
    );
    return course;
  }

  async #replay<TResult>(
    tenantId: string,
    idempotencyKey: string,
    commandFingerprint: string,
  ): Promise<TResult | undefined> {
    requireAuthoring(
      idempotencyKey.trim().length >= 4,
      "authoring.invalid_input",
      "Idempotency key is required.",
    );
    const receipt = await this.#repository.findReceipt<TResult>(tenantId, idempotencyKey);
    if (!receipt) return undefined;
    requireAuthoring(
      receipt.fingerprint === commandFingerprint,
      "authoring.idempotency_conflict",
      "The idempotency key was reused with a different command.",
    );
    return clone(receipt.result);
  }

  #receipt<TResult>(
    context: RequestContext,
    idempotencyKey: string,
    commandFingerprint: string,
    result: TResult,
  ): CommandReceipt<TResult> {
    return {
      tenantId: context.tenantId,
      idempotencyKey,
      fingerprint: commandFingerprint,
      result: clone(result),
      committedAt: nowIso(this.#now),
    };
  }

  #revision(
    context: RequestContext,
    course: CourseDraft,
    kind: CourseRevision["kind"],
    commandId: string,
    auditNote?: string,
  ): CourseRevision {
    return {
      revisionId: deterministicId(
        "revision",
        `${context.tenantId}:${course.courseId}`,
        course.version,
        { kind, commandId },
      ),
      tenantId: context.tenantId,
      courseId: course.courseId,
      version: course.version,
      kind,
      commandId,
      ...(auditNote === undefined ? {} : { auditNote: sanitizeText(auditNote) }),
      ...(context.actor.id === undefined ? {} : { actorId: context.actor.id }),
      createdAt: nowIso(this.#now),
      snapshot: clone(course),
    };
  }

  #translateOperation(operation: CourseEditOperation): readonly CourseAuthoringOperation[] {
    switch (operation.op) {
      case "course.update":
        return [operation];
      case "module.add": {
        const create: CourseAuthoringOperation = {
          op: "module.create",
          moduleId: operation.module.moduleId,
          title: operation.module.title,
          ...(operation.module.description === undefined
            ? {}
            : { description: operation.module.description }),
          position: operation.module.position,
        };
        return [
          create,
          ...(operation.module.lessons ?? []).flatMap((lesson) => [
            {
              op: "lesson.create" as const,
              moduleId: operation.module.moduleId,
              lessonId: lesson.lessonId,
              title: lesson.title,
              slug: lesson.slug,
              ...(lesson.description === undefined
                ? {}
                : { description: lesson.description }),
              ...(lesson.estimatedMinutes === undefined
                ? {}
                : { estimatedMinutes: lesson.estimatedMinutes }),
              position: lesson.position,
            },
            ...(lesson.blocks.length === 0
              ? []
              : [
                  {
                    op: "block.insert" as const,
                    lessonId: lesson.lessonId,
                    position: 0,
                    blocks: lesson.blocks,
                  },
                ]),
          ]),
        ];
      }
      case "module.update":
      case "module.move":
        return [operation];
      case "module.remove":
        return [{ op: "module.delete", moduleId: operation.moduleId }];
      case "lesson.add": {
        const create: CourseAuthoringOperation = {
          op: "lesson.create",
          moduleId: operation.moduleId,
          lessonId: operation.lesson.lessonId,
          title: operation.lesson.title,
          slug: operation.lesson.slug,
          ...(operation.lesson.description === undefined
            ? {}
            : { description: operation.lesson.description }),
          ...(operation.lesson.estimatedMinutes === undefined
            ? {}
            : { estimatedMinutes: operation.lesson.estimatedMinutes }),
          position: operation.lesson.position,
        };
        return [
          create,
          ...(operation.lesson.blocks.length === 0
            ? []
            : [
                {
                  op: "block.insert" as const,
                  lessonId: operation.lesson.lessonId,
                  position: 0,
                  blocks: operation.lesson.blocks,
                },
              ]),
        ];
      }
      case "lesson.update":
      case "lesson.move":
        return [operation];
      case "lesson.remove":
        return [{ op: "lesson.delete", lessonId: operation.lessonId }];
      case "blocks.insert":
        return [{
          op: "block.insert",
          lessonId: operation.lessonId,
          position: operation.position,
          blocks: operation.blocks,
        }];
      case "blocks.remove":
        return [{
          op: "block.delete",
          lessonId: operation.lessonId,
          blockIds: operation.blockIds,
        }];
      case "blocks.replace":
        return [
          {
            op: "block.replace",
            lessonId: operation.lessonId,
            blocks: operation.blocks,
          },
        ];
    }
  }
}
