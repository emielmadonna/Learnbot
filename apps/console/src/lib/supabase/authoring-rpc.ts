import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";
import { LearningRpcError, requireLearningRpcSuccess } from "./learning-rpc";

/**
 * Durable course editing. Migration 20260725122000_course_editing.sql makes the
 * authored hierarchy correctable: every mutation carries the owning course
 * `recordVersion` as its `expectedVersion`, and every accepted mutation returns
 * the advanced version plus the immutable revision it appended.
 */
export type AuthoringRevision = {
  revisionId: string;
  revisionNumber: number;
  revisionKind: "created" | "edited" | "published" | "rolled_back";
  contentHash: string;
  beforeHash: string | null;
};

export type AuthoringResult = {
  ok: true;
  dataMode: "durable";
  recordVersion: number;
  revision: AuthoringRevision;
  courseId: string;
  moduleId?: string;
  lessonId?: string;
  contentBlockId?: string;
  position?: number;
  status?: string;
  deleted?: boolean;
  parentKind?: "course" | "module";
  parentId?: string;
  orderedIds?: string[];
  restoredRevisionId?: string;
  restoredRevisionNumber?: number;
};

export type CourseRevisionSummary = {
  revisionId: string;
  revisionNumber: number;
  revisionKind: "created" | "edited" | "published" | "rolled_back";
  auditNote: string | null;
  contentHash: string;
  rollbackTargetRevisionNumber: number | null;
  createdAt: string;
};

export type CourseRevisionHistory = {
  ok: true;
  dataMode: "durable";
  courseId: string;
  headRevisionId: string | null;
  headRevisionNumber: number;
  revisions: CourseRevisionSummary[];
};

export type AuthoringBlockType =
  | "rich_text"
  | "heading"
  | "callout"
  | "code"
  | "quote"
  | "list"
  | "divider";

export type ReorderParentKind = "course" | "module";

/**
 * Honest upload reporting. `services/learning/` contains no worker, so nothing
 * promotes a quarantined object into learning content. `processingState` never
 * claims more than the database can prove.
 */
export type UploadProcessingState =
  | "awaiting_upload"
  | "awaiting_processing"
  | "processing"
  | "blocked"
  | "ready";

export type UploadState = {
  intentId: string;
  filename: string;
  mediaType: string;
  declaredSizeBytes: number;
  uploadStatus: string;
  expiresAt: string;
  createdAt: string;
  ingestionJobId: string | null;
  ingestionStatus: string | null;
  nextCheckpoint: string | null;
  processingState: UploadProcessingState;
  becameLearningContent: boolean;
};

export type UploadStateReport = {
  ok: true;
  dataMode: "durable";
  items: UploadState[];
  /**
   * True only when an ingestion worker has actually advanced a job past its
   * quarantine checkpoint. Today no worker is deployed, so this stays false and
   * the UI must say the upload has not been processed yet.
   */
  ingestionObserved: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new LearningRpcError(`invalid_response:${field}`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireNumber(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LearningRpcError(`invalid_response:${field}`);
  }
  return parsed;
}

export function parseAuthoringResult(value: unknown): AuthoringResult {
  const result = requireLearningRpcSuccess(value);
  if (result.dataMode !== "durable" || !isRecord(result.revision)) {
    throw new LearningRpcError("invalid_response");
  }
  requireNumber(result.recordVersion, "recordVersion");
  requireString(result.revision.revisionId, "revisionId");
  requireNumber(result.revision.revisionNumber, "revisionNumber");
  return result as unknown as AuthoringResult;
}

export function parseCourseRevisionHistory(
  value: unknown,
): CourseRevisionHistory {
  const result = requireLearningRpcSuccess(value);
  if (result.dataMode !== "durable" || !Array.isArray(result.revisions)) {
    throw new LearningRpcError("invalid_response");
  }
  return result as unknown as CourseRevisionHistory;
}

/**
 * Derives the truthful processing state of a quarantined upload. A file that
 * has only been signed and stored has not become learning content, and an
 * ingestion job that exists but has never been claimed has not either.
 */
export function deriveUploadProcessingState(
  uploadStatus: string,
  ingestionStatus: string | null,
): UploadProcessingState {
  if (uploadStatus === "blocked" || ingestionStatus === "failed") {
    return "blocked";
  }
  if (ingestionStatus === null) {
    return uploadStatus === "quarantined" ? "awaiting_upload" : "blocked";
  }
  if (ingestionStatus === "waiting" || ingestionStatus === "queued") {
    return "awaiting_processing";
  }
  if (ingestionStatus === "running" || ingestionStatus === "retrying") {
    return "processing";
  }
  if (ingestionStatus === "succeeded" || ingestionStatus === "completed") {
    return "ready";
  }
  return "awaiting_processing";
}

export function parseUploadStateReport(value: unknown): UploadStateReport {
  const result = requireLearningRpcSuccess(value);
  if (result.dataMode !== "durable" || !Array.isArray(result.items)) {
    throw new LearningRpcError("invalid_response");
  }
  const items = result.items.map((entry) => {
    if (!isRecord(entry)) throw new LearningRpcError("invalid_response");
    const uploadStatus = requireString(entry.uploadStatus, "uploadStatus");
    const ingestionStatus = optionalString(entry.ingestionStatus);
    const processingState = deriveUploadProcessingState(
      uploadStatus,
      ingestionStatus,
    );
    return {
      intentId: requireString(entry.intentId, "intentId"),
      filename: requireString(entry.filename, "filename"),
      mediaType: requireString(entry.mediaType, "mediaType"),
      declaredSizeBytes: requireNumber(
        entry.declaredSizeBytes,
        "declaredSizeBytes",
      ),
      uploadStatus,
      expiresAt: requireString(entry.expiresAt, "expiresAt"),
      createdAt: requireString(entry.createdAt, "createdAt"),
      ingestionJobId: optionalString(entry.ingestionJobId),
      ingestionStatus,
      nextCheckpoint: optionalString(entry.nextCheckpoint),
      processingState,
      becameLearningContent: processingState === "ready",
    } satisfies UploadState;
  });
  return {
    ok: true,
    dataMode: "durable",
    items,
    ingestionObserved: items.some(
      (item) =>
        item.processingState === "processing" ||
        item.processingState === "ready",
    ),
  };
}

/**
 * The editing RPCs signal refusal through SQLSTATE only. Translating the fixed
 * set of expected states keeps the editor able to distinguish "reload, someone
 * else edited this" from a generic failure without leaking database detail.
 */
const rpcStateCodes = new Map<string, string>([
  ["40001", "version_conflict"],
  ["42501", "insufficient_role"],
  ["P0002", "not_found"],
  ["02000", "not_found"],
  ["22023", "invalid_request"],
  ["23505", "idempotency_conflict"],
  ["23514", "invalid_request"],
]);

async function callAuthoringRpc(
  supabase: SupabaseClient,
  name: string,
  input: Record<string, unknown>,
) {
  const response = await supabase.rpc(name, input);
  if (response.error) {
    const code =
      typeof response.error.code === "string"
        ? rpcStateCodes.get(response.error.code)
        : undefined;
    throw new LearningRpcError(code ?? "request_failed");
  }
  return response.data;
}

export async function updateCourse(
  supabase: SupabaseClient,
  input: {
    courseId: string;
    title: string | null;
    description: string | null;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_update_course", {
      target_course_id: input.courseId,
      requested_title: input.title,
      requested_description: input.description,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function createModule(
  supabase: SupabaseClient,
  input: {
    courseId: string;
    title: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_create_module", {
      target_course_id: input.courseId,
      requested_title: input.title,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function updateModule(
  supabase: SupabaseClient,
  input: {
    moduleId: string;
    title: string | null;
    status: string | null;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_update_module", {
      target_module_id: input.moduleId,
      requested_title: input.title,
      requested_status: input.status,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function deleteModule(
  supabase: SupabaseClient,
  input: {
    moduleId: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_delete_module", {
      target_module_id: input.moduleId,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function createLesson(
  supabase: SupabaseClient,
  input: {
    moduleId: string;
    title: string;
    content: string | null;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_create_lesson", {
      target_module_id: input.moduleId,
      requested_title: input.title,
      requested_content: input.content,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function updateLesson(
  supabase: SupabaseClient,
  input: {
    lessonId: string;
    title: string | null;
    status: string | null;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_update_lesson", {
      target_lesson_id: input.lessonId,
      requested_title: input.title,
      requested_status: input.status,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function deleteLesson(
  supabase: SupabaseClient,
  input: {
    lessonId: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_delete_lesson", {
      target_lesson_id: input.lessonId,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function createContentBlock(
  supabase: SupabaseClient,
  input: {
    lessonId: string;
    blockType: AuthoringBlockType;
    content: Record<string, unknown>;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_create_content_block", {
      target_lesson_id: input.lessonId,
      requested_block_type: input.blockType,
      requested_content: input.content,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function updateContentBlock(
  supabase: SupabaseClient,
  input: {
    contentBlockId: string;
    blockType: AuthoringBlockType;
    content: Record<string, unknown>;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_update_content_block", {
      target_content_block_id: input.contentBlockId,
      requested_block_type: input.blockType,
      requested_content: input.content,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function deleteContentBlock(
  supabase: SupabaseClient,
  input: {
    contentBlockId: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_delete_content_block", {
      target_content_block_id: input.contentBlockId,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function reorderChildren(
  supabase: SupabaseClient,
  input: {
    parentKind: ReorderParentKind;
    parentId: string;
    orderedIds: string[];
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_reorder", {
      parent_kind: input.parentKind,
      target_parent_id: input.parentId,
      ordered_ids: input.orderedIds,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function listCourseRevisions(
  supabase: SupabaseClient,
  input: { courseId: string },
): Promise<CourseRevisionHistory> {
  return parseCourseRevisionHistory(
    await callAuthoringRpc(supabase, "learning_list_course_revisions", {
      target_course_id: input.courseId,
    }),
  );
}

export async function rollbackCourse(
  supabase: SupabaseClient,
  input: {
    courseId: string;
    targetRevisionId: string;
    expectedVersion: number;
    idempotencyKey: string;
  },
): Promise<AuthoringResult> {
  return parseAuthoringResult(
    await callAuthoringRpc(supabase, "learning_rollback_course", {
      target_course_id: input.courseId,
      target_revision_id: input.targetRevisionId,
      expected_version: input.expectedVersion,
      idempotency_key: input.idempotencyKey,
    }),
  );
}

export async function getUploadStateReport(
  supabase: SupabaseClient,
): Promise<UploadStateReport> {
  const response = await supabase.rpc("learning_list_quarantine_uploads");
  if (response.error) {
    throw new AuthenticationBoundaryError(
      "learning.uploads_failed",
      "The durable upload state could not be loaded.",
    );
  }
  return parseUploadStateReport(response.data);
}

export function authoringOperationKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}
