import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import { AgentRpcError } from "../../../../lib/supabase/agent-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";

// Brand assets are small, tenant-visible raster images only. SVG is excluded
// because it can carry script that would execute from the storage origin.
const allowedMediaTypes = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const adminRoles = new Set(["tenant_owner", "tenant_admin"]);
// "avatar-source" is the consent photo behind a generated character avatar
// (PLAN.md Section 7.1) — distinct from "avatar", the plain static fallback
// image (Section 7). Both upload through this one signed-URL path.
const assetKinds = new Set(["logo", "avatar", "avatar-source"]);
const maxAssetBytes = 2_097_152;
const readTtlSeconds = 600;
const safeCodes = new Set([
  "access_denied",
  "invalid_request",
  "request_denied",
  "storage_signing_failed",
  "tenant_selection_required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeObjectFilename(kind: string, extension: string) {
  return `${kind}.${extension}`;
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const code =
    error instanceof AgentRpcError && safeCodes.has(error.code)
      ? error.code
      : "request_denied";
  const status =
    code === "access_denied"
      ? 403
      : code === "tenant_selection_required"
        ? 409
        : code === "storage_signing_failed"
          ? 503
          : 400;
  return NextResponse.json(
    { ok: false, code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function requireTenantAdmin(request: Request, mutation: boolean) {
  const supabase = await authenticatedLearningClient(request, { mutation });
  const user = await requireVerifiedUser(supabase);
  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) {
    throw new AgentRpcError("tenant_selection_required");
  }
  if (!context.identityRole || !adminRoles.has(context.identityRole)) {
    throw new AgentRpcError("access_denied");
  }
  return { supabase, user, tenantId: context.tenantId };
}

/** Issue a short-lived signed read for an already-stored brand asset. */
export async function GET(request: Request) {
  try {
    const { supabase, tenantId } = await requireTenantAdmin(request, false);
    const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
    if (
      key.length === 0 ||
      key.length > 1024 ||
      key.includes("..") ||
      !key.startsWith(`${tenantId}/branding/`)
    ) {
      throw new AgentRpcError("invalid_request");
    }
    const signed = await supabase.storage
      .from("tenant-private")
      .createSignedUrl(key, readTtlSeconds);
    if (signed.error || !signed.data) {
      throw new AgentRpcError("storage_signing_failed");
    }
    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        objectKey: key,
        url: signed.data.signedUrl,
        expiresInSeconds: readTtlSeconds,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Issue a signed upload URL for a new tenant-scoped brand asset. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { supabase, user, tenantId } = await requireTenantAdmin(
      request,
      true,
    );
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new AgentRpcError("invalid_request");
    const kind =
      typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
    const mediaType =
      typeof input.mediaType === "string"
        ? input.mediaType.trim().toLowerCase()
        : "";
    const sizeBytes = Number(input.sizeBytes);
    const extension = allowedMediaTypes.get(mediaType);
    if (
      !assetKinds.has(kind) ||
      extension === undefined ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > maxAssetBytes
    ) {
      throw new AgentRpcError("invalid_request");
    }

    // Matches the tenant-private layout enforced by storage RLS:
    // <tenant_uuid>/branding/<owner_user_uuid>/<asset_uuid>/<filename>
    const assetId = crypto.randomUUID();
    const objectKey = [
      tenantId,
      "branding",
      user.id,
      assetId,
      safeObjectFilename(kind, extension),
    ].join("/");
    const signed = await supabase.storage
      .from("tenant-private")
      .createSignedUploadUrl(objectKey, { upsert: false });
    if (signed.error || !signed.data) {
      throw new AgentRpcError("storage_signing_failed");
    }
    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        kind,
        bucket: "tenant-private",
        objectKey,
        path: signed.data.path,
        token: signed.data.token,
        contentType: mediaType,
        maxSizeBytes: maxAssetBytes,
        upload: {
          url: signed.data.signedUrl,
          method: "PUT",
          requiredHeaders: { "content-type": mediaType },
        },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
