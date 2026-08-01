import { NextResponse } from "next/server";

import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import {
  MAX_VISUAL_BYTES,
  VISUAL_MEDIA_EXTENSIONS,
  VisualMediaValidationError,
  verifyVisualMedia,
} from "../../../../lib/visuals/secure-media";

export const dynamic = "force-dynamic";

const BUCKET = "tenant-private";
const VISUAL_VALIDATION_TOKEN_ENV =
  "LEARNINGBOT_VISUAL_VALIDATION_OPERATION_TOKEN";
const AUTHOR_ROLES = new Set([
  "tenant_owner",
  "tenant_admin",
  "creator",
]);
const SAFE_CODES = new Set([
  "access_denied",
  "idempotency_conflict",
  "invalid_object_key",
  "invalid_request",
  "media_signature_invalid",
  "media_size_invalid",
  "media_type_unsupported",
  "request_failed",
  "storage_signing_failed",
  "tenant_selection_required",
  "unsafe_svg",
  "upload_evidence_invalid",
  "upload_evidence_mismatch",
  "upload_incomplete",
  "upload_intent_unavailable",
  "version_conflict",
  "visual_validation_unavailable",
  "visual_not_found",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function boundedText(value: unknown, minimum: number, maximum: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < minimum || text.length > maximum) {
    throw new LearningRpcError("invalid_request");
  }
  return text;
}

function expectedVersion(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function safeObjectFilename(value: string, extension: string) {
  const stem = value
    .normalize("NFKC")
    .replace(/\.[A-Za-z0-9]+$/u, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+/u, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 150);
  return `${stem || "visual"}.${extension}`;
}

function responseForError(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      {
        status: failure.status,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  const code =
    error instanceof LearningRpcError && SAFE_CODES.has(error.code)
      ? error.code
      : "request_failed";
  const status =
    code === "access_denied"
      ? 403
      : code === "tenant_selection_required" ||
          code === "version_conflict" ||
          code === "idempotency_conflict"
        ? 409
        : code === "storage_signing_failed" ||
            code === "request_failed" ||
            code === "visual_validation_unavailable"
          ? 503
          : code === "visual_not_found"
            ? 404
            : 400;
  return NextResponse.json(
    { ok: false, code },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

async function authorContext(request: Request, mutation: boolean) {
  const supabase = await authenticatedLearningClient(request, { mutation });
  const [user, context] = await Promise.all([
    requireVerifiedUser(supabase),
    getCurrentTenantContext(supabase),
  ]);
  if (!context.selected || context.tenantId === null) {
    throw new LearningRpcError("tenant_selection_required");
  }
  if (
    context.identityRole === null ||
    !AUTHOR_ROLES.has(context.identityRole)
  ) {
    throw new LearningRpcError("access_denied");
  }
  return { supabase, user, tenantId: context.tenantId };
}

export async function GET(request: Request) {
  try {
    const { supabase } = await authorContext(request, false);
    const url = new URL(request.url);
    const rawCourseId = url.searchParams.get("courseId");
    const courseId = rawCourseId === null ? null : uuid(rawCourseId);
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const result = await executeLearningRpc(
      supabase,
      "learning_list_visual_assets",
      {
        target_course_id: courseId,
        include_archived: includeArchived,
      },
    );
    if (!Array.isArray(result.items)) {
      throw new LearningRpcError("request_failed");
    }

    const items = result.items.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const { privateObjectKey: _privateKey, ...browserSafe } = candidate;
      const visualAssetId =
        typeof candidate.visualAssetId === "string"
          ? candidate.visualAssetId
          : "";
      return [
        {
          ...browserSafe,
          previewUrl:
            candidate.status === "active" && visualAssetId.length > 0
              ? `/api/learning/visuals/${visualAssetId}/content`
              : null,
        },
      ];
    });
    return NextResponse.json(
      { ok: true, dataMode: "durable", items },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return responseForError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, user, tenantId } = await authorContext(request, true);
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const action = typeof input.action === "string" ? input.action : "";

    if (action === "prepare") {
      const courseId = uuid(input.courseId);
      const title = boundedText(input.title, 1, 160);
      const description = boundedText(input.description, 3, 2_000);
      const altText = boundedText(input.altText, 3, 500);
      const fileName = boundedText(input.fileName, 1, 255);
      const mediaType =
        typeof input.mediaType === "string"
          ? input.mediaType.trim().toLowerCase()
          : "";
      const sizeBytes = Number(input.sizeBytes);
      const extension = VISUAL_MEDIA_EXTENSIONS.get(mediaType);
      const visualKind =
        input.visualKind === "chart"
          ? "chart"
          : mediaType === "image/svg+xml"
            ? "svg"
            : mediaType === "video/mp4"
              ? "video"
              : "image";
      if (
        extension === undefined ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > MAX_VISUAL_BYTES
      ) {
        throw new LearningRpcError("invalid_request");
      }

      const visualAssetId = crypto.randomUUID();
      const objectKey = [
        tenantId,
        "visuals",
        user.id,
        visualAssetId,
        safeObjectFilename(fileName, extension),
      ].join("/");
      const expiresAt = new Date(Date.now() + 115 * 60_000).toISOString();
      const result = await executeLearningRpc(
        supabase,
        "learning_create_visual_asset",
        {
          requested_visual_asset_id: visualAssetId,
          target_course_id: courseId,
          requested_title: title,
          requested_description: description,
          requested_alt_text: altText,
          requested_show_in_answers: input.showInAnswers !== false,
          requested_file_name: fileName,
          requested_media_type: mediaType,
          requested_size_bytes: sizeBytes,
          requested_object_key: objectKey,
          requested_upload_expires_at: expiresAt,
          requested_idempotency_key: `visual-create:${visualAssetId}`,
          requested_visual_kind: visualKind,
        },
      );
      const signed = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(objectKey, { upsert: false });
      if (signed.error || signed.data === null) {
        throw new LearningRpcError("storage_signing_failed");
      }
      return NextResponse.json(
        {
          ...result,
          bucket: BUCKET,
          path: signed.data.path,
          token: signed.data.token,
          contentType: mediaType,
          maxSizeBytes: MAX_VISUAL_BYTES,
        },
        {
          status: 201,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }

    if (action === "finalize") {
      const visualAssetId = uuid(input.visualAssetId);
      const operationToken =
        process.env[VISUAL_VALIDATION_TOKEN_ENV]?.trim() ?? "";
      if (operationToken.length < 32 || operationToken.length > 512) {
        throw new LearningRpcError("visual_validation_unavailable");
      }
      const listing = await executeLearningRpc(
        supabase,
        "learning_list_visual_assets",
        { target_course_id: null, include_archived: true },
      );
      const pendingAsset = Array.isArray(listing.items)
        ? listing.items.find(
            (candidate) =>
              isRecord(candidate) &&
              candidate.visualAssetId === visualAssetId,
          )
        : null;
      if (!isRecord(pendingAsset)) {
        throw new LearningRpcError("visual_not_found");
      }
      const objectKey =
        typeof pendingAsset.privateObjectKey === "string"
          ? pendingAsset.privateObjectKey
          : "";
      const mediaType =
        typeof pendingAsset.mediaType === "string"
          ? pendingAsset.mediaType
          : "";
      const expectedSize = pendingAsset.sizeBytes;
      if (
        objectKey.length === 0 ||
        typeof expectedSize !== "number" ||
        !Number.isSafeInteger(expectedSize)
      ) {
        throw new LearningRpcError("upload_evidence_invalid");
      }
      const downloaded = await supabase.storage.from(BUCKET).download(objectKey);
      if (downloaded.error || downloaded.data === null) {
        throw new LearningRpcError("upload_incomplete");
      }
      const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
      if (bytes.length !== expectedSize) {
        throw new LearningRpcError("upload_evidence_mismatch");
      }
      let validation: Awaited<ReturnType<typeof verifyVisualMedia>>;
      try {
        validation = await verifyVisualMedia(bytes, mediaType);
      } catch (error) {
        if (error instanceof VisualMediaValidationError) {
          throw new LearningRpcError(error.code);
        }
        throw error;
      }
      const result = await executeLearningRpc(
        supabase,
        "learning_finalize_validated_visual_asset",
        {
          target_visual_asset_id: visualAssetId,
          observed_sha256: validation.sha256,
          operation_token: operationToken,
        },
      );
      return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    if (action === "update") {
      const result = await executeLearningRpc(
        supabase,
        "learning_update_visual_asset",
        {
          target_visual_asset_id: uuid(input.visualAssetId),
          target_course_id: uuid(input.courseId),
          requested_title: boundedText(input.title, 1, 160),
          requested_description: boundedText(input.description, 3, 2_000),
          requested_alt_text: boundedText(input.altText, 3, 500),
          requested_show_in_answers: input.showInAnswers === true,
          expected_version: expectedVersion(input.expectedVersion),
        },
      );
      return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    if (action === "archive") {
      const result = await executeLearningRpc(
        supabase,
        "learning_archive_visual_asset",
        {
          target_visual_asset_id: uuid(input.visualAssetId),
          expected_version: expectedVersion(input.expectedVersion),
        },
      );
      return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    throw new LearningRpcError("invalid_request");
  } catch (error) {
    return responseForError(error);
  }
}
