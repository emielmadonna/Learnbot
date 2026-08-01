import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
} from "../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../lib/supabase/learning-rpc";
import {
  normalizeCourseMediaContent,
  type CourseMediaBlockType,
} from "../../../lib/content/media-block";
import {
  createContentBlock,
  createLesson,
  createModule,
  deleteContentBlock,
  deleteLesson,
  deleteModule,
  getLessonReception,
  getUploadStateReport,
  listCourseRevisions,
  reorderChildren,
  rollbackCourse,
  updateContentBlock,
  updateCourse,
  updateLesson,
  updateModule,
  type AuthoringBlockType,
  type ReorderParentKind,
} from "../../../lib/supabase/authoring-rpc";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const blockTypes = new Set<AuthoringBlockType>([
  "rich_text",
  "heading",
  "callout",
  "code",
  "quote",
  "list",
  "divider",
  "image",
  "video",
  "link",
]);
const mediaBlockTypes = new Set<CourseMediaBlockType>([
  "image",
  "video",
  "link",
]);
const lifecycleStatuses = new Set(["draft", "published", "archived"]);
const cacheHeaders = { "Cache-Control": "private, no-store" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number) {
  if (
    typeof value !== "string" ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value.trim();
}

function optionalBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
) {
  if (value === null || value === undefined) return null;
  return boundedString(value, minimum, maximum);
}

function optionalStatus(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !lifecycleStatuses.has(value)) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function expectedVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new LearningRpcError("invalid_request");
  }
  return parsed;
}

function idempotencyKey(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 200 ||
    !/^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function blockType(value: unknown): AuthoringBlockType {
  if (
    typeof value !== "string" ||
    !blockTypes.has(value as AuthoringBlockType)
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value as AuthoringBlockType;
}

function blockContent(type: AuthoringBlockType, value: unknown) {
  if (!isRecord(value) || JSON.stringify(value).length > 100_000) {
    throw new LearningRpcError("invalid_request");
  }
  if (mediaBlockTypes.has(type as CourseMediaBlockType)) {
    const normalized = normalizeCourseMediaContent(
      type as CourseMediaBlockType,
      value,
    );
    if (normalized === null) throw new LearningRpcError("invalid_request");
    return normalized;
  }
  return value;
}

function orderedIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) {
    throw new LearningRpcError("invalid_request");
  }
  const ids = value.map((entry) => uuid(entry));
  if (new Set(ids).size !== ids.length) {
    throw new LearningRpcError("invalid_request");
  }
  return ids;
}

/**
 * `learning_lesson_reception` itself refuses anything outside 1–366, so this
 * validates the same bound before the RPC is ever called — a caller that
 * never sends `windowDays` gets the RPC's own 90-day default.
 */
function windowDays(value: unknown) {
  if (value === null || value === undefined) return 90;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 366) {
    throw new LearningRpcError("invalid_request");
  }
  return parsed;
}

function parentKind(value: unknown): ReorderParentKind {
  if (value !== "course" && value !== "module") {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

/**
 * The editing RPCs signal refusal two ways. Most raise a SQLSTATE that
 * `callAuthoringRpc` has already translated. `learning_list_course_revisions`
 * instead returns an `ok:false` envelope, and its codes name the same two
 * refusals in different words — so they are normalised here rather than
 * collapsed into the generic denial, which the editor renders as "course
 * editing may not be enabled on this database yet". A caller whose role cannot
 * author must not be told the migration is missing.
 */
const normalizedCodes = new Map<string, string>([
  ["access_denied", "insufficient_role"],
  ["course_not_found", "not_found"],
]);

const safeCodes = new Set([
  "insufficient_role",
  "not_found",
  "version_conflict",
  "idempotency_conflict",
  "tenant_selection_required",
  "invalid_request",
  // The RPC could not be executed at all. Reported as an unavailable
  // dependency (503) rather than as a rejected request.
  "request_failed",
]);

const authoringStatusByCode = new Map<string, number>([
  ["insufficient_role", 403],
  ["not_found", 404],
  ["version_conflict", 409],
  ["idempotency_conflict", 409],
  ["tenant_selection_required", 409],
  ["invalid_request", 400],
  ["request_failed", 503],
]);

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: cacheHeaders },
    );
  }
  const raw = error instanceof LearningRpcError ? error.code : "request_failed";
  if (raw.startsWith("invalid_response")) {
    // The RPC answered in a shape this route cannot vouch for. That is an
    // upstream contract fault, not something the caller sent wrong.
    return NextResponse.json(
      { ok: false, code: "invalid_response" },
      { status: 502, headers: cacheHeaders },
    );
  }
  const code = normalizedCodes.get(raw) ?? raw;
  if (!safeCodes.has(code)) {
    return NextResponse.json(
      { ok: false, code: "authoring_request_denied" },
      { status: 400, headers: cacheHeaders },
    );
  }
  return NextResponse.json(
    { ok: false, code },
    { status: authoringStatusByCode.get(code) ?? 400, headers: cacheHeaders },
  );
}

export async function POST(request: Request) {
  try {
    // Every action is treated as a mutation so the cookie-authenticated
    // browser path always passes the same-origin check in
    // authenticatedLearningClient. Unknown actions fail closed below.
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const input = (await request.json()) as unknown;
    if (!isRecord(input) || typeof input.action !== "string") {
      throw new LearningRpcError("invalid_request");
    }

    switch (input.action) {
      case "course.update":
        return NextResponse.json(
          await updateCourse(supabase, {
            courseId: uuid(input.courseId),
            title: optionalBoundedString(input.title, 3, 160),
            description: optionalBoundedString(input.description, 0, 2_000),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "module.create":
        return NextResponse.json(
          await createModule(supabase, {
            courseId: uuid(input.courseId),
            title: boundedString(input.title, 3, 160),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { status: 201, headers: cacheHeaders },
        );
      case "module.update":
        return NextResponse.json(
          await updateModule(supabase, {
            moduleId: uuid(input.moduleId),
            title: optionalBoundedString(input.title, 3, 160),
            status: optionalStatus(input.status),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "module.delete":
        return NextResponse.json(
          await deleteModule(supabase, {
            moduleId: uuid(input.moduleId),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "lesson.create":
        return NextResponse.json(
          await createLesson(supabase, {
            moduleId: uuid(input.moduleId),
            title: boundedString(input.title, 3, 160),
            content: optionalBoundedString(input.content, 1, 50_000),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { status: 201, headers: cacheHeaders },
        );
      case "lesson.update":
        return NextResponse.json(
          await updateLesson(supabase, {
            lessonId: uuid(input.lessonId),
            title: optionalBoundedString(input.title, 3, 160),
            status: optionalStatus(input.status),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "lesson.delete":
        return NextResponse.json(
          await deleteLesson(supabase, {
            lessonId: uuid(input.lessonId),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "block.create": {
        const createBlockType = blockType(input.blockType);
        return NextResponse.json(
          await createContentBlock(supabase, {
            lessonId: uuid(input.lessonId),
            blockType: createBlockType,
            content: blockContent(createBlockType, input.content),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { status: 201, headers: cacheHeaders },
        );
      }
      case "block.update": {
        const updateBlockType = blockType(input.blockType);
        return NextResponse.json(
          await updateContentBlock(supabase, {
            contentBlockId: uuid(input.contentBlockId),
            blockType: updateBlockType,
            content: blockContent(updateBlockType, input.content),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      }
      case "block.delete":
        return NextResponse.json(
          await deleteContentBlock(supabase, {
            contentBlockId: uuid(input.contentBlockId),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "reorder":
        return NextResponse.json(
          await reorderChildren(supabase, {
            parentKind: parentKind(input.parentKind),
            parentId: uuid(input.parentId),
            orderedIds: orderedIds(input.orderedIds),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "course.revisions":
        return NextResponse.json(
          await listCourseRevisions(supabase, {
            courseId: uuid(input.courseId),
          }),
          { headers: cacheHeaders },
        );
      case "course.rollback":
        return NextResponse.json(
          await rollbackCourse(supabase, {
            courseId: uuid(input.courseId),
            targetRevisionId: boundedString(input.targetRevisionId, 1, 200),
            expectedVersion: expectedVersion(input.expectedVersion),
            idempotencyKey: idempotencyKey(input.idempotencyKey),
          }),
          { headers: cacheHeaders },
        );
      case "lesson.reception":
        // A pure read, like course.revisions above — no expectedVersion, and
        // an unapplied migration surfaces as the ordinary request_failed code
        // rather than a broken response.
        return NextResponse.json(
          await getLessonReception(supabase, {
            courseId: uuid(input.courseId),
            windowDays: windowDays(input.windowDays),
          }),
          { headers: cacheHeaders },
        );
      case "uploads.state":
        // Honest reporting only. No ingestion worker exists in services/learning,
        // so quarantined uploads report awaiting_processing and never claim to
        // have become learning content.
        return NextResponse.json(await getUploadStateReport(supabase), {
          headers: cacheHeaders,
        });
      default:
        throw new LearningRpcError("invalid_request");
    }
  } catch (error) {
    return errorResponse(error);
  }
}
