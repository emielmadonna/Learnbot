import type { LearningDocument } from "@course-ai/contracts";
import { applyCleanupRecipes } from "./cleanup.js";
import {
  extractDiagramCandidates,
  reviewDiagramCandidate as reviewCandidate,
} from "./diagrams.js";
import {
  legacyChunk,
  paragraphizeText,
  paragraphizeTranscript,
  stableId,
} from "./legacy-chunker.js";
import {
  CONTRACT_STAGE_BY_PIPELINE_STAGE,
  PIPELINE_STAGES,
  PipelineFailure,
  type Clock,
  type CleanupRecipe,
  type DiagramCandidate,
  type KnowledgeVersion,
  type OperationState,
  type PipelineArtifacts,
  type PipelineJobState,
  type PipelineOptions,
  type PipelineStage,
  type ReprocessImpactPreview,
  type SelectiveChange,
  type SelectiveReprocessResult,
  type SourceIntake,
  type StageState,
  type TenantScope,
} from "./types.js";

interface MutableJob {
  jobId: string;
  tenantId: string;
  sourceId: string;
  documentId: string;
  contentHash: string;
  idempotencyKey: string;
  intake: SourceIntake;
  status: PipelineJobState["status"];
  currentStage?: PipelineStage;
  stages: StageState[];
  artifacts: PipelineArtifacts;
  draftVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface RunConfiguration {
  readonly options: PipelineOptions;
  readonly startAt: PipelineStage;
  readonly seed?: PipelineArtifacts;
}

const DEFAULT_RECIPES: readonly CleanupRecipe[] = [
  { type: "normalize_whitespace" },
];

export class DeterministicLearningPipeline {
  readonly #jobs = new Map<string, MutableJob>();
  readonly #jobIdByIdempotency = new Map<string, string>();
  readonly #versions = new Map<string, KnowledgeVersion>();
  readonly #versionIdsByTenant = new Map<string, string[]>();
  readonly #activeVersionIdByTenant = new Map<string, string>();

  constructor(
    private readonly clock: Clock = {
      now: () => new Date().toISOString(),
    },
  ) {}

  start(
    scope: TenantScope,
    intake: SourceIntake,
    idempotencyKey: string,
    options: PipelineOptions = {},
  ): PipelineJobState {
    this.#assertTenant(scope, intake.tenantId);
    this.#validateIdempotencyKey(idempotencyKey);
    return this.#startConfigured(scope, intake, idempotencyKey, {
      options,
      startAt: "validate",
    });
  }

  resume(
    scope: TenantScope,
    jobId: string,
    options: PipelineOptions = {},
  ): PipelineJobState {
    const job = this.#ownedJob(scope, jobId);
    if (job.status === "succeeded") return snapshotJob(job);
    const failedStage = job.stages.find((stage) => stage.status === "failed");
    if (failedStage === undefined) return snapshotJob(job);
    this.#execute(job, this.#intakeFromJob(job), {
      options,
      startAt: failedStage.stage,
      seed: job.artifacts,
    });
    return snapshotJob(job);
  }

  getJob(scope: TenantScope, jobId: string): PipelineJobState {
    return snapshotJob(this.#ownedJob(scope, jobId));
  }

  getOperationState(scope: TenantScope, jobId: string): OperationState {
    const job = this.#ownedJob(scope, jobId);
    const failed = job.stages.find((stage) => stage.status === "failed");
    const currentStage = job.currentStage;
    return {
      jobId: job.jobId,
      tenantId: job.tenantId,
      status: job.status,
      ...(currentStage === undefined ? {} : { currentStage }),
      ...(currentStage === undefined
        ? {}
        : { contractStage: CONTRACT_STAGE_BY_PIPELINE_STAGE[currentStage] }),
      ...(job.draftVersionId === undefined
        ? {}
        : { draftVersionId: job.draftVersionId }),
      ...(failed?.failure === undefined
        ? {}
        : {
            failure: {
              stage: failed.stage,
              code: failed.failure.code,
              message: failed.failure.message,
              retryable: failed.failure.retryable,
            },
          }),
      updatedAt: job.updatedAt,
    };
  }

  /** These adapters deliberately expose the same canonical operation state. */
  getUiOperationState(scope: TenantScope, jobId: string): OperationState {
    return this.getOperationState(scope, jobId);
  }

  getApiOperationState(scope: TenantScope, jobId: string): OperationState {
    return this.getOperationState(scope, jobId);
  }

  getMcpOperationState(scope: TenantScope, jobId: string): OperationState {
    return this.getOperationState(scope, jobId);
  }

  listVersions(scope: TenantScope): readonly KnowledgeVersion[] {
    return (this.#versionIdsByTenant.get(scope.tenantId) ?? []).map((id) => {
      const version = this.#versions.get(id);
      if (version === undefined) {
        throw new PipelineFailure("NOT_FOUND", "Version not found.", false);
      }
      return version;
    });
  }

  getActiveVersion(scope: TenantScope): KnowledgeVersion | undefined {
    const id = this.#activeVersionIdByTenant.get(scope.tenantId);
    return id === undefined ? undefined : this.#versions.get(id);
  }

  publish(
    scope: TenantScope,
    draftVersionId: string,
    expectedActiveVersionId?: string,
  ): KnowledgeVersion {
    const draft = this.#ownedVersion(scope, draftVersionId);
    if (draft.status !== "draft") {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "Only a draft knowledge version can be published.",
        false,
      );
    }
    const currentActiveId = this.#activeVersionIdByTenant.get(scope.tenantId);
    if (currentActiveId !== expectedActiveVersionId) {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "The active knowledge version changed before publish.",
        true,
      );
    }

    const publishedAt = this.clock.now();
    if (currentActiveId !== undefined) {
      const current = this.#versions.get(currentActiveId);
      if (current !== undefined) {
        this.#versions.set(currentActiveId, { ...current, status: "retired" });
      }
    }
    const active: KnowledgeVersion = {
      ...draft,
      status: "active",
      publishedAt,
    };
    this.#versions.set(active.versionId, active);
    this.#activeVersionIdByTenant.set(scope.tenantId, active.versionId);
    return active;
  }

  rollback(
    scope: TenantScope,
    targetVersionId: string,
    expectedActiveVersionId: string,
  ): KnowledgeVersion {
    const target = this.#ownedVersion(scope, targetVersionId);
    const currentActiveId = this.#activeVersionIdByTenant.get(scope.tenantId);
    if (currentActiveId !== expectedActiveVersionId) {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "The active version changed before rollback.",
        true,
      );
    }
    if (currentActiveId === targetVersionId) return target;
    if (target.status === "draft") {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "Rollback targets must be previously published versions.",
        false,
      );
    }

    const current = this.#versions.get(currentActiveId);
    if (current !== undefined) {
      this.#versions.set(current.versionId, { ...current, status: "retired" });
    }
    const active = {
      ...target,
      status: "active" as const,
      publishedAt: this.clock.now(),
    };
    this.#versions.set(active.versionId, active);
    this.#activeVersionIdByTenant.set(scope.tenantId, active.versionId);
    return active;
  }

  previewSelectiveReprocess(
    scope: TenantScope,
    change: SelectiveChange,
  ): ReprocessImpactPreview {
    const active = this.getActiveVersion(scope);
    if (active === undefined) {
      throw new PipelineFailure(
        "NOT_FOUND",
        "No active knowledge version exists.",
        false,
      );
    }
    const requested = new Set(change.documentIds);
    const targetDocumentIds = active.documents
      .filter((document) => requested.has(document.documentId))
      .map((document) => document.documentId);
    if (targetDocumentIds.length !== requested.size) {
      throw new PipelineFailure(
        "NOT_FOUND",
        "One or more target documents are unavailable.",
        false,
      );
    }
    const affectedChunkIds = active.chunks
      .filter((chunk) => requested.has(chunk.documentId))
      .map((chunk) => chunk.chunkId);
    const invalidatedStages = stagesForChange(change.kind);
    return {
      tenantId: scope.tenantId,
      fromVersionId: active.versionId,
      targetDocumentIds,
      invalidatedStages,
      affectedChunkIds,
      estimatedEmbeddingWrites: invalidatedStages.includes("embed")
        ? affectedChunkIds.length
        : 0,
      activeVersionRemains: active.versionId,
    };
  }

  selectiveReprocess(
    scope: TenantScope,
    change: SelectiveChange,
    idempotencyKey: string,
  ): SelectiveReprocessResult {
    if (change.documentIds.length !== 1) {
      throw new PipelineFailure(
        "SOURCE_INVALID",
        "The deterministic slice reprocesses one document per job.",
        false,
      );
    }
    const preview = this.previewSelectiveReprocess(scope, change);
    const active = this.getActiveVersion(scope)!;
    const document = active.documents.find(
      (candidate) => candidate.documentId === change.documentIds[0],
    )!;
    const body =
      change.kind === "edit_document" ? change.replacementBody : document.body;
    const intake: SourceIntake = {
      tenantId: scope.tenantId,
      sourceId: document.sourceId,
      documentId: document.documentId,
      title: document.title,
      mediaType: "text/plain",
      contentHash: stableId("content", body),
      body,
      ...(document.courseId === undefined
        ? {}
        : { courseId: document.courseId }),
      ...(document.moduleId === undefined
        ? {}
        : { moduleId: document.moduleId }),
      ...(document.lessonId === undefined
        ? {}
        : { lessonId: document.lessonId }),
    };
    const startAt = preview.invalidatedStages[0]!;
    const recipes =
      change.kind === "cleanup_recipe" ? change.recipes : DEFAULT_RECIPES;
    const seed: PipelineArtifacts = {
      paragraphs: paragraphizeText(body),
      document,
      chunks: active.chunks.filter(
        (chunk) => chunk.documentId === document.documentId,
      ),
      diagrams: active.diagrams.filter(
        (diagram) => diagram.documentId === document.documentId,
      ),
    };
    const job = this.#startConfigured(scope, intake, idempotencyKey, {
      options: { cleanupRecipes: recipes },
      startAt,
      seed,
    });
    const draft = this.#ownedVersion(scope, job.draftVersionId!);
    return { preview, job, draftVersion: draft };
  }

  reviewDiagramCandidate(
    scope: TenantScope,
    draftVersionId: string,
    candidateId: string,
    decision: "approve" | "reject",
    reviewerNote?: string,
  ): DiagramCandidate {
    const draft = this.#ownedVersion(scope, draftVersionId);
    if (draft.status !== "draft") {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "Diagram review is only allowed on a draft version.",
        false,
      );
    }
    const candidate = draft.diagrams.find(
      (diagram) => diagram.candidateId === candidateId,
    );
    if (candidate === undefined) {
      throw new PipelineFailure("NOT_FOUND", "Diagram not found.", false);
    }
    const reviewed = reviewCandidate(candidate, decision, reviewerNote);
    this.#versions.set(draft.versionId, {
      ...draft,
      diagrams: draft.diagrams.map((diagram) =>
        diagram.candidateId === candidateId ? reviewed : diagram,
      ),
    });
    return reviewed;
  }

  #startConfigured(
    scope: TenantScope,
    intake: SourceIntake,
    idempotencyKey: string,
    configuration: RunConfiguration,
  ): PipelineJobState {
    const idempotencyScope = `${scope.tenantId}:${idempotencyKey}`;
    const existingId = this.#jobIdByIdempotency.get(idempotencyScope);
    if (existingId !== undefined) {
      const existing = this.#jobs.get(existingId)!;
      if (
        existing.contentHash !== intake.contentHash ||
        existing.documentId !== intake.documentId
      ) {
        throw new PipelineFailure(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for different content.",
          false,
        );
      }
      return snapshotJob(existing);
    }

    const now = this.clock.now();
    const startIndex = PIPELINE_STAGES.indexOf(configuration.startAt);
    const stages = PIPELINE_STAGES.map<StageState>((stage, index) => ({
      stage,
      contractStage: CONTRACT_STAGE_BY_PIPELINE_STAGE[stage],
      status: index < startIndex ? "succeeded" : "pending",
      attempt: 0,
    }));
    const job: MutableJob = {
      jobId: stableId("job", idempotencyScope),
      tenantId: scope.tenantId,
      sourceId: intake.sourceId,
      documentId: intake.documentId,
      contentHash: intake.contentHash,
      idempotencyKey,
      intake: structuredClone(intake),
      status: "queued",
      stages,
      artifacts: configuration.seed ?? {
        paragraphs: [],
        chunks: [],
        diagrams: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    this.#jobs.set(job.jobId, job);
    this.#jobIdByIdempotency.set(idempotencyScope, job.jobId);
    this.#execute(job, intake, configuration);
    return snapshotJob(job);
  }

  #execute(
    job: MutableJob,
    intake: SourceIntake,
    configuration: RunConfiguration,
  ): void {
    const startIndex = PIPELINE_STAGES.indexOf(configuration.startAt);
    job.status = "running";
    for (let index = startIndex; index < PIPELINE_STAGES.length; index += 1) {
      const stage = PIPELINE_STAGES[index]!;
      const previous = job.stages[index]!;
      const startedAt = this.clock.now();
      job.currentStage = stage;
      job.stages[index] = {
        ...previous,
        status: "running",
        attempt: previous.attempt + 1,
        startedAt,
      };
      try {
        if (configuration.options.failAtStage === stage) {
          throw simulatedFailure(stage);
        }
        this.#executeStage(job, intake, stage, configuration.options);
        job.stages[index] = {
          ...job.stages[index]!,
          status: "succeeded",
          completedAt: this.clock.now(),
        };
      } catch (error) {
        const failure =
          error instanceof PipelineFailure
            ? error
            : new PipelineFailure(
                failureCodeForStage(stage),
                "The stage failed deterministically.",
                true,
                stage,
              );
        job.stages[index] = {
          ...job.stages[index]!,
          status: "failed",
          completedAt: this.clock.now(),
          failure: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          },
        };
        job.status = "failed";
        job.updatedAt = this.clock.now();
        return;
      }
    }
    job.status = "succeeded";
    job.currentStage = PIPELINE_STAGES.at(-1)!;
    job.updatedAt = this.clock.now();
    const version = this.#createDraftVersion(job);
    job.draftVersionId = version.versionId;
  }

  #executeStage(
    job: MutableJob,
    intake: SourceIntake,
    stage: PipelineStage,
    options: PipelineOptions,
  ): void {
    switch (stage) {
      case "validate":
        validateSource(intake);
        return;
      case "scan":
        if (/\bEICAR-STANDARD-ANTIVIRUS-TEST-FILE\b/u.test(sourceText(intake))) {
          throw new PipelineFailure(
            "MALWARE_DETECTED",
            "Content scan rejected the source.",
            false,
            stage,
          );
        }
        return;
      case "extract":
        job.artifacts = {
          ...job.artifacts,
          paragraphs:
            intake.transcriptCues === undefined
              ? paragraphizeText(intake.body ?? "")
              : paragraphizeTranscript(intake.transcriptCues),
        };
        return;
      case "clean":
        job.artifacts = {
          ...job.artifacts,
          paragraphs: applyCleanupRecipes(
            job.artifacts.paragraphs,
            options.cleanupRecipes ?? DEFAULT_RECIPES,
          ),
        };
        return;
      case "structure": {
        const now = this.clock.now();
        const body = job.artifacts.paragraphs
          .map((paragraph) => paragraph.text)
          .join("\n\n");
        const existingVersion = job.artifacts.document?.version ?? 0;
        const document: LearningDocument = {
          documentId: intake.documentId,
          tenantId: intake.tenantId,
          sourceId: intake.sourceId,
          title: intake.title,
          body,
          version: existingVersion + 1,
          sourceHash: intake.contentHash,
          ...(intake.courseId === undefined ? {} : { courseId: intake.courseId }),
          ...(intake.moduleId === undefined ? {} : { moduleId: intake.moduleId }),
          ...(intake.lessonId === undefined ? {} : { lessonId: intake.lessonId }),
          createdAt: job.artifacts.document?.createdAt ?? now,
          updatedAt: now,
        };
        job.artifacts = { ...job.artifacts, document };
        return;
      }
      case "chunk":
        job.artifacts = {
          ...job.artifacts,
          chunks: legacyChunk(
            intake.tenantId,
            intake.documentId,
            job.artifacts.paragraphs,
          ),
        };
        return;
      case "embed":
        // `legacyChunk` includes the deterministic local embedding. Keeping this
        // as a separate stage preserves retry/impact semantics for a real provider.
        job.artifacts = {
          ...job.artifacts,
          chunks: job.artifacts.chunks.map((chunk) => ({ ...chunk })),
        };
        return;
      case "diagram.extract": {
        const body =
          job.artifacts.document?.body ??
          job.artifacts.paragraphs.map((paragraph) => paragraph.text).join("\n");
        job.artifacts = {
          ...job.artifacts,
          diagrams: extractDiagramCandidates(
            intake.tenantId,
            intake.documentId,
            body,
          ),
        };
      }
    }
  }

  #createDraftVersion(job: MutableJob): KnowledgeVersion {
    if (job.artifacts.document === undefined) {
      throw new PipelineFailure(
        "STRUCTURE_FAILED",
        "A successful job must contain a structured document.",
        false,
        "structure",
      );
    }
    const active = this.getActiveVersion({ tenantId: job.tenantId });
    const documents = [
      ...(active?.documents.filter(
        (document) => document.documentId !== job.documentId,
      ) ?? []),
      job.artifacts.document,
    ];
    const chunks = [
      ...(active?.chunks.filter((chunk) => chunk.documentId !== job.documentId) ??
        []),
      ...job.artifacts.chunks,
    ];
    const diagrams = [
      ...(active?.diagrams.filter(
        (diagram) => diagram.documentId !== job.documentId,
      ) ?? []),
      ...job.artifacts.diagrams,
    ];
    const sequence =
      (this.#versionIdsByTenant.get(job.tenantId)?.length ?? 0) + 1;
    const version: KnowledgeVersion = {
      versionId: stableId(
        "knowledge",
        `${job.tenantId}:${sequence}:${job.jobId}`,
      ),
      tenantId: job.tenantId,
      sequence,
      status: "draft",
      sourceJobId: job.jobId,
      documents,
      chunks,
      diagrams,
      createdAt: this.clock.now(),
    };
    this.#versions.set(version.versionId, version);
    const ids = this.#versionIdsByTenant.get(job.tenantId) ?? [];
    this.#versionIdsByTenant.set(job.tenantId, [...ids, version.versionId]);
    return version;
  }

  #ownedJob(scope: TenantScope, jobId: string): MutableJob {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.tenantId !== scope.tenantId) {
      throw new PipelineFailure(
        "TENANT_ACCESS_DENIED",
        "The requested resource is unavailable in this tenant.",
        false,
      );
    }
    return job;
  }

  #ownedVersion(scope: TenantScope, versionId: string): KnowledgeVersion {
    const version = this.#versions.get(versionId);
    if (version === undefined || version.tenantId !== scope.tenantId) {
      throw new PipelineFailure(
        "TENANT_ACCESS_DENIED",
        "The requested resource is unavailable in this tenant.",
        false,
      );
    }
    return version;
  }

  #assertTenant(scope: TenantScope, resourceTenantId: string): void {
    if (scope.tenantId !== resourceTenantId) {
      throw new PipelineFailure(
        "TENANT_ACCESS_DENIED",
        "The requested resource is unavailable in this tenant.",
        false,
      );
    }
  }

  #validateIdempotencyKey(idempotencyKey: string): void {
    if (idempotencyKey.trim().length < 4) {
      throw new PipelineFailure(
        "SOURCE_INVALID",
        "An idempotency key of at least four characters is required.",
        false,
      );
    }
  }

  #intakeFromJob(job: MutableJob): SourceIntake {
    return structuredClone(job.intake);
  }
}

function validateSource(intake: SourceIntake): void {
  if (
    intake.tenantId.trim() === "" ||
    intake.sourceId.trim() === "" ||
    intake.documentId.trim() === "" ||
    intake.title.trim() === "" ||
    intake.contentHash.trim() === "" ||
    intake.mediaType.trim() === ""
  ) {
    throw new PipelineFailure(
      "SOURCE_INVALID",
      "Source identity, title, media type and content hash are required.",
      false,
      "validate",
    );
  }
  if (
    intake.transcriptCues?.some(
      (cue, index, cues) =>
        !Number.isFinite(cue.startMs) ||
        !Number.isFinite(cue.endMs) ||
        cue.startMs < 0 ||
        cue.endMs < cue.startMs ||
        (index > 0 && cue.startMs < cues[index - 1]!.startMs),
    ) === true
  ) {
    throw new PipelineFailure(
      "SOURCE_INVALID",
      "Transcript timestamps must be finite, non-negative and ordered.",
      false,
      "validate",
    );
  }
  if (
    (intake.body === undefined || intake.body.trim() === "") &&
    (intake.transcriptCues === undefined ||
      intake.transcriptCues.length === 0)
  ) {
    throw new PipelineFailure(
      "SOURCE_INVALID",
      "The source contains no extractable content.",
      false,
      "validate",
    );
  }
}

function sourceText(intake: SourceIntake): string {
  return [
    intake.body ?? "",
    ...(intake.transcriptCues?.map((cue) => cue.text) ?? []),
  ].join("\n");
}

function stagesForChange(
  kind: SelectiveChange["kind"],
): readonly PipelineStage[] {
  switch (kind) {
    case "replace_source":
      return PIPELINE_STAGES;
    case "cleanup_recipe":
    case "edit_document":
      return ["clean", "structure", "chunk", "embed", "diagram.extract"];
    case "diagram_review":
      return ["diagram.extract"];
  }
}

function failureCodeForStage(stage: PipelineStage): PipelineFailure["code"] {
  switch (stage) {
    case "validate":
      return "SOURCE_INVALID";
    case "scan":
      return "MALWARE_DETECTED";
    case "extract":
      return "EXTRACTION_FAILED";
    case "clean":
      return "CLEANUP_FAILED";
    case "structure":
      return "STRUCTURE_FAILED";
    case "chunk":
      return "CHUNK_FAILED";
    case "embed":
      return "EMBED_FAILED";
    case "diagram.extract":
      return "DIAGRAM_UNSAFE";
  }
}

function simulatedFailure(stage: PipelineStage): PipelineFailure {
  return new PipelineFailure(
    failureCodeForStage(stage),
    `Simulated ${stage} failure.`,
    stage !== "validate" && stage !== "scan",
    stage,
  );
}

function snapshotJob(job: MutableJob): PipelineJobState {
  const { intake: _intake, ...publicJob } = job;
  return structuredClone(publicJob);
}
