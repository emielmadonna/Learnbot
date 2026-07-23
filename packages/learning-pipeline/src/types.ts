import type {
  IngestionJobStatus,
  IngestionJobType,
  IsoTimestamp,
  LearningChunk,
  LearningDocument,
  TenantId,
} from "@course-ai/contracts";

export const PIPELINE_STAGES = [
  "validate",
  "scan",
  "extract",
  "clean",
  "structure",
  "chunk",
  "embed",
  "diagram.extract",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const CONTRACT_STAGE_BY_PIPELINE_STAGE: Readonly<
  Record<PipelineStage, IngestionJobType>
> = {
  validate: "file.inspect",
  scan: "file.inspect",
  extract: "document.extract",
  clean: "content.clean",
  structure: "hierarchy.reconcile",
  chunk: "content.chunk",
  embed: "content.embed",
  "diagram.extract": "diagram.extract",
};

export type PipelineFailureCode =
  | "TENANT_ACCESS_DENIED"
  | "SOURCE_INVALID"
  | "MALWARE_DETECTED"
  | "EXTRACTION_FAILED"
  | "CLEANUP_FAILED"
  | "STRUCTURE_FAILED"
  | "CHUNK_FAILED"
  | "EMBED_FAILED"
  | "DIAGRAM_UNSAFE"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "NOT_FOUND";

export class PipelineFailure extends Error {
  override readonly name = "PipelineFailure";

  constructor(
    readonly code: PipelineFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly stage?: PipelineStage,
  ) {
    super(message);
  }
}

export interface TenantScope {
  readonly tenantId: TenantId;
}

export interface TranscriptCue {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SourceIntake {
  readonly tenantId: TenantId;
  readonly sourceId: string;
  readonly documentId: string;
  readonly title: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly body?: string;
  readonly transcriptCues?: readonly TranscriptCue[];
  readonly courseId?: string;
  readonly moduleId?: string;
  readonly lessonId?: string;
}

export type CleanupRecipe =
  | { readonly type: "normalize_whitespace" }
  | { readonly type: "remove_repeated_line"; readonly exactLine: string }
  | { readonly type: "replace"; readonly search: string; readonly replacement: string };

export interface PipelineOptions {
  readonly cleanupRecipes?: readonly CleanupRecipe[];
  readonly failAtStage?: PipelineStage;
}

export interface TranscriptParagraph {
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
}

export interface EmbeddedChunk extends LearningChunk {
  readonly embedding: readonly number[];
}

export type DiagramCandidateState = "pending" | "approved" | "rejected";
export type DiagramSafety = "safe" | "requires_review" | "blocked";

export interface DiagramCandidate {
  readonly candidateId: string;
  readonly tenantId: TenantId;
  readonly documentId: string;
  readonly sourceText: string;
  readonly nodes: readonly string[];
  readonly safety: DiagramSafety;
  readonly state: DiagramCandidateState;
  readonly reviewerNote?: string;
}

export interface StageState {
  readonly stage: PipelineStage;
  readonly contractStage: IngestionJobType;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly attempt: number;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly failure?: {
    readonly code: PipelineFailureCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface PipelineArtifacts {
  readonly paragraphs: readonly TranscriptParagraph[];
  readonly document?: LearningDocument;
  readonly chunks: readonly EmbeddedChunk[];
  readonly diagrams: readonly DiagramCandidate[];
}

export interface PipelineJobState {
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly sourceId: string;
  readonly documentId: string;
  readonly contentHash: string;
  readonly idempotencyKey: string;
  readonly status: IngestionJobStatus;
  readonly currentStage?: PipelineStage;
  readonly stages: readonly StageState[];
  readonly artifacts: PipelineArtifacts;
  readonly draftVersionId?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface OperationState {
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly status: IngestionJobStatus;
  readonly currentStage?: PipelineStage;
  readonly contractStage?: IngestionJobType;
  readonly draftVersionId?: string;
  readonly failure?: {
    readonly stage: PipelineStage;
    readonly code: PipelineFailureCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly updatedAt: IsoTimestamp;
}

export interface KnowledgeVersion {
  readonly versionId: string;
  readonly tenantId: TenantId;
  readonly sequence: number;
  readonly status: "draft" | "active" | "retired";
  readonly sourceJobId: string;
  readonly documents: readonly LearningDocument[];
  readonly chunks: readonly EmbeddedChunk[];
  readonly diagrams: readonly DiagramCandidate[];
  readonly createdAt: IsoTimestamp;
  readonly publishedAt?: IsoTimestamp;
}

export type SelectiveChange =
  | {
    readonly kind: "cleanup_recipe";
    readonly documentIds: readonly string[];
    readonly recipes: readonly CleanupRecipe[];
  }
  | {
    readonly kind: "edit_document";
    readonly documentIds: readonly string[];
    readonly replacementBody: string;
  }
  | {
    readonly kind: "replace_source";
    readonly documentIds: readonly string[];
  }
  | {
    readonly kind: "diagram_review";
    readonly documentIds: readonly string[];
  };

export interface ReprocessImpactPreview {
  readonly tenantId: TenantId;
  readonly fromVersionId: string;
  readonly targetDocumentIds: readonly string[];
  readonly invalidatedStages: readonly PipelineStage[];
  readonly affectedChunkIds: readonly string[];
  readonly estimatedEmbeddingWrites: number;
  readonly activeVersionRemains: string;
}

export interface SelectiveReprocessResult {
  readonly preview: ReprocessImpactPreview;
  readonly job: PipelineJobState;
  readonly draftVersion: KnowledgeVersion;
}

export interface Clock {
  now(): IsoTimestamp;
}
