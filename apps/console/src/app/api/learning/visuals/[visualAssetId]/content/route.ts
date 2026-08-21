import { NextResponse } from "next/server";

import {
  classifyAuthBoundaryError,
  AuthenticationBoundaryError,
} from "../../../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../../../lib/supabase/learning-rpc";
import { VISUAL_MEDIA_EXTENSIONS } from "../../../../../../lib/visuals/secure-media";

const BUCKET = "tenant-private";

function rangeFor(value: string | null, size: number) {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) return false;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return false;
  }
  return { start, end: Math.min(end, size - 1) };
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

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const code =
    error instanceof LearningRpcError ? error.code : "request_failed";
  const status =
    code === "visual_not_found"
      ? 404
      : code === "tenant_selection_required"
        ? 409
        : code === "request_failed" || code === "storage_signing_failed"
          ? 503
          : 400;
  return NextResponse.json(
    { ok: false, code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ visualAssetId: string }> },
) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const { visualAssetId } = await context.params;
    const result = await executeLearningRpc(
      supabase,
      "learning_get_visual_asset_for_read",
      { target_visual_asset_id: uuid(visualAssetId) },
    );
    const objectKey =
      typeof result.privateObjectKey === "string"
        ? result.privateObjectKey
        : "";
    if (objectKey.length === 0 || objectKey.includes("..")) {
      throw new LearningRpcError("request_failed");
    }
    const mediaType =
      typeof result.mediaType === "string" &&
      VISUAL_MEDIA_EXTENSIONS.has(result.mediaType)
        ? result.mediaType
        : "";
    if (mediaType.length === 0) {
      throw new LearningRpcError("request_failed");
    }
    const sizeBytes = result.sizeBytes;
    if (
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > 20_971_520
    ) {
      throw new LearningRpcError("request_failed");
    }
    const requestedRange = rangeFor(request.headers.get("range"), sizeBytes);
    const signed = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(objectKey, 60);
    if (signed.error || signed.data === null) {
      throw new LearningRpcError("storage_signing_failed");
    }
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="visual.${VISUAL_MEDIA_EXTENSIONS.get(mediaType)}"`,
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox",
      "Content-Type": mediaType,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (requestedRange === false) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${sizeBytes}`,
        },
      });
    }
    const upstream = await fetch(signed.data.signedUrl, {
      cache: "no-store",
      headers:
        requestedRange === null
          ? {}
          : {
              Range: `bytes=${requestedRange.start}-${requestedRange.end}`,
            },
    });
    if (
      upstream.body === null ||
      (requestedRange === null
        ? upstream.status !== 200
        : upstream.status !== 206)
    ) {
      throw new LearningRpcError("storage_signing_failed");
    }
    if (requestedRange !== null) {
      return new NextResponse(upstream.body, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(
            requestedRange.end - requestedRange.start + 1,
          ),
          "Content-Range": `bytes ${requestedRange.start}-${requestedRange.end}/${sizeBytes}`,
        },
      });
    }
    return new NextResponse(upstream.body, {
      headers: {
        ...baseHeaders,
        "Content-Length": String(sizeBytes),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
