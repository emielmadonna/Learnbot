import type {
  AssetId,
  ChunkId,
  CourseId,
  DocumentId,
  IsoTimestamp,
  JsonObject,
  LessonId,
  ModuleId,
  ProtectedObjectRef,
  TenantId,
  TraceId,
} from "./common.js";
import type { RequestContext } from "./context.js";

export type LearningSourceType =
  | "upload"
  | "circle"
  | "youtube"
  | "vimeo"
  | "url"
  | "kajabi"
  | "teachable"
  | "skool"
  | "api"
  | "mcp";

export type LearningSourceStatus =
  | "draft"
  | "connecting"
  | "ready"
  | "syncing"
  | "degraded"
  | "disconnected"
  | "failed";

export interface LearningSource {
  readonly sourceId: string;
  readonly tenantId: TenantId;
  readonly type: LearningSourceType;
  readonly name: string;
  readonly status: LearningSourceStatus;
  readonly externalRef?: string;
  /** Vault handle only. */
  readonly credentialRef?: string;
  readonly configuration: JsonObject;
  readonly cursor?: string;
  readonly lastSyncedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface UploadDescriptor {
  readonly uploadId: string;
  readonly object: ProtectedObjectRef;
  readonly originalFileName: string;
  readonly mediaType: string;
  readonly detectedKind:
    | "audio"
    | "video"
    | "pdf"
    | "document"
    | "presentation"
    | "spreadsheet"
    | "text"
    | "archive"
    | "unknown";
}

export interface LearningLocation {
  readonly courseExternalId?: string;
  readonly course: string;
  readonly moduleExternalId?: string;
  readonly module?: string;
  readonly lessonExternalId?: string;
  readonly lesson: string;
  readonly order?: number;
  readonly sourceUrl?: string;
}

/**
 * All connectors normalize into this shape before content cleaning and
 * hierarchy reconciliation. Raw artifacts remain referenced for replay.
 */
export interface NormalizedLearningItem {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly externalId: string;
  readonly location: LearningLocation;
  readonly title: string;
  readonly body: string;
  readonly contentFormat: "plain_text" | "markdown" | "html" | "transcript";
  readonly language?: string;
  readonly durationMs?: number;
  readonly publishedAt?: IsoTimestamp;
  readonly rawObjectRef?: ProtectedObjectRef;
  readonly mediaRefs: readonly ProtectedObjectRef[];
  readonly metadata: JsonObject;
}

export interface ConnectorDiscoverInput {
  readonly source: LearningSource;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ConnectorDiscoverResult {
  readonly items: readonly NormalizedLearningItem[];
  readonly nextCursor?: string;
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

export interface LearningConnector {
  readonly type: LearningSourceType;
  validate(
    context: RequestContext,
    source: LearningSource,
  ): Promise<readonly IngestionIssue[]>;
  discover(
    context: RequestContext,
    input: ConnectorDiscoverInput,
  ): AsyncIterable<ConnectorDiscoverResult>;
}

export type ContentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | QuoteBlock
  | CalloutBlock
  | CodeBlock
  | TableBlock
  | ImageBlock
  | DiagramBlock
  | MediaBlock
  | EmbedBlock
  | DividerBlock;

export interface BlockBase {
  readonly id: string;
  readonly metadata?: JsonObject;
}

export interface RichTextSpan {
  readonly text: string;
  readonly marks?: readonly (
    | "bold"
    | "italic"
    | "underline"
    | "strike"
    | "code"
  )[];
  readonly href?: string;
}

export interface ParagraphBlock extends BlockBase {
  readonly type: "paragraph";
  readonly content: readonly RichTextSpan[];
}

export interface HeadingBlock extends BlockBase {
  readonly type: "heading";
  readonly level: 1 | 2 | 3 | 4;
  readonly content: readonly RichTextSpan[];
}

export interface ListBlock extends BlockBase {
  readonly type: "list";
  readonly style: "bullet" | "numbered" | "checklist";
  readonly items: readonly {
    readonly id: string;
    readonly content: readonly RichTextSpan[];
    readonly checked?: boolean;
  }[];
}

export interface QuoteBlock extends BlockBase {
  readonly type: "quote";
  readonly content: readonly RichTextSpan[];
  readonly attribution?: string;
}

export interface CalloutBlock extends BlockBase {
  readonly type: "callout";
  readonly tone: "info" | "tip" | "warning" | "example";
  readonly title?: string;
  readonly content: readonly RichTextSpan[];
}

export interface CodeBlock extends BlockBase {
  readonly type: "code";
  readonly code: string;
  readonly language?: string;
  readonly caption?: string;
}

export interface TableBlock extends BlockBase {
  readonly type: "table";
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly caption?: string;
}

export interface ImageBlock extends BlockBase {
  readonly type: "image";
  readonly assetId: AssetId;
  readonly altText: string;
  readonly caption?: string;
}

export interface DiagramBlock extends BlockBase {
  readonly type: "diagram";
  readonly assetId: AssetId;
  readonly altText: string;
  readonly caption: string;
  readonly layout?: "full" | "wide" | "inline";
}

export interface MediaBlock extends BlockBase {
  readonly type: "media";
  readonly assetId: AssetId;
  readonly mediaKind: "audio" | "video";
  readonly title?: string;
  readonly transcriptDocumentId?: DocumentId;
}

export interface EmbedBlock extends BlockBase {
  readonly type: "embed";
  readonly provider: string;
  readonly url: string;
  readonly title?: string;
}

export interface DividerBlock extends BlockBase {
  readonly type: "divider";
}

export interface CourseSummary {
  readonly courseId: CourseId;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly slug: string;
  readonly status: "draft" | "published" | "archived";
  readonly version: number;
  readonly moduleCount: number;
  readonly lessonCount: number;
  readonly updatedAt: IsoTimestamp;
}

export interface CourseDraft {
  readonly courseId: CourseId;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly slug: string;
  readonly description?: string;
  readonly status: "draft" | "published" | "archived";
  readonly version: number;
  readonly modules: readonly CourseModule[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly publishedAt?: IsoTimestamp;
}

export interface CourseModule {
  readonly moduleId: ModuleId;
  readonly title: string;
  readonly description?: string;
  readonly position: number;
  readonly lessons: readonly CourseLesson[];
}

export interface CourseLesson {
  readonly lessonId: LessonId;
  readonly title: string;
  readonly slug: string;
  readonly description?: string;
  readonly position: number;
  readonly status: "draft" | "published" | "archived";
  readonly blocks: readonly ContentBlock[];
  readonly sourceDocumentIds: readonly DocumentId[];
  readonly estimatedMinutes?: number;
  readonly updatedAt: IsoTimestamp;
}

export type CourseEditOperation =
  | {
      readonly op: "course.update";
      readonly patch: {
        readonly title?: string;
        readonly slug?: string;
        readonly description?: string | null;
      };
    }
  | {
      readonly op: "module.add";
      readonly module: Omit<CourseModule, "lessons"> & {
        readonly lessons?: readonly CourseLesson[];
      };
    }
  | {
      readonly op: "module.update";
      readonly moduleId: ModuleId;
      readonly patch: {
        readonly title?: string;
        readonly description?: string | null;
      };
    }
  | {
      readonly op: "module.move";
      readonly moduleId: ModuleId;
      readonly position: number;
    }
  | { readonly op: "module.remove"; readonly moduleId: ModuleId }
  | {
      readonly op: "lesson.add";
      readonly moduleId: ModuleId;
      readonly lesson: CourseLesson;
    }
  | {
      readonly op: "lesson.update";
      readonly lessonId: LessonId;
      readonly patch: {
        readonly title?: string;
        readonly slug?: string;
        readonly description?: string | null;
        readonly status?: CourseLesson["status"];
        readonly estimatedMinutes?: number | null;
      };
    }
  | {
      readonly op: "lesson.move";
      readonly lessonId: LessonId;
      readonly moduleId: ModuleId;
      readonly position: number;
    }
  | { readonly op: "lesson.remove"; readonly lessonId: LessonId }
  | {
      readonly op: "blocks.replace";
      readonly lessonId: LessonId;
      readonly blocks: readonly ContentBlock[];
    }
  | {
      readonly op: "blocks.insert";
      readonly lessonId: LessonId;
      readonly position: number;
      readonly blocks: readonly ContentBlock[];
    }
  | {
      readonly op: "blocks.remove";
      readonly lessonId: LessonId;
      readonly blockIds: readonly string[];
    };

export interface ApplyCourseEditsInput {
  readonly courseId: CourseId;
  /** Optimistic concurrency guard; reject rather than silently overwrite. */
  readonly expectedVersion: number;
  readonly operations: readonly CourseEditOperation[];
  readonly idempotencyKey: string;
  readonly auditNote?: string;
}

export interface ApplyCourseEditsResult {
  readonly course: CourseDraft;
  readonly appliedOperationCount: number;
  readonly warnings: readonly string[];
}

export interface PublishCourseInput {
  readonly courseId: CourseId;
  readonly expectedVersion: number;
  readonly auditNote: string;
}

export interface CourseValidationResult {
  readonly valid: boolean;
  readonly issues: readonly CourseValidationIssue[];
}

export interface CourseValidationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly moduleId?: ModuleId;
  readonly lessonId?: LessonId;
  readonly blockId?: string;
}

export interface CourseEditorService {
  createCourse(
    context: RequestContext,
    input: Pick<CourseDraft, "title" | "slug" | "description">,
  ): Promise<CourseDraft>;
  getCourse(context: RequestContext, courseId: CourseId): Promise<CourseDraft>;
  applyEdits(
    context: RequestContext,
    input: ApplyCourseEditsInput,
  ): Promise<ApplyCourseEditsResult>;
  validate(
    context: RequestContext,
    courseId: CourseId,
  ): Promise<CourseValidationResult>;
  publish(
    context: RequestContext,
    input: PublishCourseInput,
  ): Promise<CourseDraft>;
}

export type IngestionJobType =
  | "source.sync"
  | "file.inspect"
  | "media.transcribe"
  | "document.extract"
  | "content.clean"
  | "hierarchy.reconcile"
  | "content.chunk"
  | "content.embed"
  | "diagram.extract"
  | "diagram.understand"
  | "diagram.recreate"
  | "diagram.embed"
  | "course.publish";

export type IngestionJobStatus =
  | "queued"
  | "leased"
  | "running"
  | "waiting_for_input"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

export interface IngestionJob<TPayload extends JsonObject = JsonObject> {
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly type: IngestionJobType;
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
  readonly payloadRef?: ProtectedObjectRef;
  readonly status: IngestionJobStatus;
  readonly priority: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly traceId: TraceId;
  readonly parentJobId?: string;
  readonly createdAt: IsoTimestamp;
  readonly availableAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
}

export interface IngestionCheckpoint {
  readonly checkpointId: string;
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly stage: IngestionJobType;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly outputRef?: ProtectedObjectRef;
  readonly counts?: Readonly<Record<string, number>>;
  readonly createdAt: IsoTimestamp;
}

export interface IngestionIssue {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly sourceId?: string;
  readonly documentId?: DocumentId;
  readonly retryable: boolean;
  readonly safeDetails?: JsonObject;
}

export interface IngestionProgress {
  readonly rootJobId: string;
  readonly tenantId: TenantId;
  readonly status: IngestionJobStatus;
  readonly completedItems: number;
  readonly totalItems?: number;
  readonly currentStage?: IngestionJobType;
  readonly issues: readonly IngestionIssue[];
  readonly updatedAt: IsoTimestamp;
}

export interface LearningDocument {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly sourceId: string;
  readonly courseId?: CourseId;
  readonly moduleId?: ModuleId;
  readonly lessonId?: LessonId;
  readonly title: string;
  readonly body: string;
  readonly language?: string;
  readonly version: number;
  readonly sourceHash: string;
  readonly rawObjectRef?: ProtectedObjectRef;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface LearningChunk {
  readonly chunkId: ChunkId;
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
  readonly text: string;
  readonly ordinal: number;
  readonly tokenCount: number;
  readonly assetIds: readonly AssetId[];
  readonly metadata: JsonObject;
}

export type LearningAssetKind =
  | "diagram"
  | "slide"
  | "photo"
  | "worksheet"
  | "screenshot"
  | "audio"
  | "video";

export type AssetCurationStatus =
  | "pending"
  | "approved"
  | "approved_as_raster"
  | "rejected";

export interface LearningAsset {
  readonly assetId: AssetId;
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
  readonly kind: LearningAssetKind;
  readonly original: ProtectedObjectRef;
  readonly recreation?: ProtectedObjectRef;
  readonly caption?: string;
  readonly altText?: string;
  readonly ocrText?: string;
  readonly sourceTimestampMs?: number;
  readonly status: AssetCurationStatus;
  readonly version: number;
  readonly createdAt: IsoTimestamp;
  readonly reviewedAt?: IsoTimestamp;
  readonly reviewedBy?: string;
}

export interface CurateAssetInput {
  readonly assetId: AssetId;
  readonly expectedVersion: number;
  readonly decision: Exclude<AssetCurationStatus, "pending">;
  readonly caption?: string;
  readonly altText?: string;
  readonly auditNote?: string;
}

export interface IngestionService {
  createSource(
    context: RequestContext,
    source: Omit<
      LearningSource,
      "sourceId" | "tenantId" | "status" | "createdAt" | "updatedAt"
    >,
  ): Promise<LearningSource>;
  startSync(
    context: RequestContext,
    sourceId: string,
    idempotencyKey: string,
  ): Promise<IngestionProgress>;
  ingestUpload(
    context: RequestContext,
    upload: UploadDescriptor,
    location: LearningLocation,
    idempotencyKey: string,
  ): Promise<IngestionProgress>;
  getProgress(
    context: RequestContext,
    rootJobId: string,
  ): Promise<IngestionProgress>;
  curateAsset(
    context: RequestContext,
    input: CurateAssetInput,
  ): Promise<LearningAsset>;
}
