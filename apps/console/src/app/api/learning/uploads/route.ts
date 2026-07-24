import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

const allowedMediaTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const authorRoles = new Set([
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function safeObjectFilename(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+/u, "")
    .replace(/-{2,}/gu, "-")
    .slice(-180);
  return normalized || "learning-source";
}

function errorResponse(error: unknown) {
  const status =
    error instanceof AuthenticationBoundaryError
      ? 401
      : error instanceof LearningRpcError &&
          error.code === "insufficient_role"
        ? 403
      : error instanceof LearningRpcError &&
          error.code === "tenant_selection_required"
        ? 409
        : 400;
  return NextResponse.json(
    {
      ok: false,
      code:
        status === 401
          ? "authentication_required"
          : status === 403
            ? "insufficient_role"
          : status === 409
            ? "tenant_selection_required"
            : "upload_request_denied",
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const result = await executeLearningRpc(
      supabase,
      "learning_list_quarantine_uploads",
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const user = await requireVerifiedUser(supabase);
    const context = await getCurrentTenantContext(supabase);
    if (!context.selected || !context.tenantId) {
      throw new LearningRpcError("tenant_selection_required");
    }
    if (!context.identityRole || !authorRoles.has(context.identityRole)) {
      throw new LearningRpcError("insufficient_role");
    }
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const courseId = uuid(input.courseId);
    const filename =
      typeof input.filename === "string" ? input.filename.trim() : "";
    const mediaType =
      typeof input.mediaType === "string"
        ? input.mediaType.toLowerCase()
        : "";
    const sizeBytes = Number(input.sizeBytes);
    if (
      filename.length < 1 ||
      filename.length > 255 ||
      !allowedMediaTypes.has(mediaType) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > 26_214_400
    ) {
      throw new LearningRpcError("invalid_request");
    }

    const intentId = crypto.randomUUID();
    const objectKey = [
      context.tenantId,
      "quarantine",
      user.id,
      intentId,
      safeObjectFilename(filename),
    ].join("/");
    const expiresAt = new Date(Date.now() + 115 * 60_000).toISOString();
    const signed = await supabase.storage
      .from("tenant-private")
      .createSignedUploadUrl(objectKey, { upsert: false });
    if (signed.error || !signed.data) {
      throw new LearningRpcError("storage_signing_failed");
    }
    const result = await executeLearningRpc(
      supabase,
      "learning_create_upload_intent",
      {
        requested_intent_id: intentId,
        target_course_id: courseId,
        requested_filename: filename,
        requested_media_type: mediaType,
        requested_size_bytes: sizeBytes,
        requested_object_key: objectKey,
        requested_expires_at: expiresAt,
        requested_signed_upload: {
          url: signed.data.signedUrl,
          method: "PUT",
          expiresAt,
          requiredHeaders: { "content-type": mediaType },
          courseId,
        },
      },
    );
    return NextResponse.json(
      {
        ...result,
        bucket: "tenant-private",
        path: signed.data.path,
        token: signed.data.token,
        contentType: mediaType,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
