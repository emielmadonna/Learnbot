import {
  createWidgetSupabaseClient,
  isConversationRef,
  isWidgetKey,
  widgetGetVisualAsset,
  WidgetRpcError,
} from "../../../../../../lib/supabase/widget-rpc";
import { VISUAL_MEDIA_EXTENSIONS } from "../../../../../../lib/visuals/secure-media";
import {
  allowedOriginHeaders,
  preflightResponse,
  requestOrigin,
  widgetRefusal,
} from "../../../cors";

/**
 * GET /api/widget/visuals/:visualAssetId/content?key=…&conversationRef=…
 *
 * The public counterpart of
 * /api/learning/visuals/[visualAssetId]/content. Same shape, same range
 * handling, same private streaming — a different authority.
 *
 * WHY THE CREDENTIALS ARE IN THE QUERY STRING
 *
 * Because this URL goes in an `<img src>` / `<video src>`, and those cannot
 * carry headers. The alternative — minting a short-lived signed URL per asset
 * and handing it to the page — leaks the storage origin and the object key to
 * the browser, which is exactly what the authenticated route already refuses
 * to do. So the reference stays a same-origin app URL and the secret stays a
 * conversation ref the visitor already holds.
 *
 * The consequence is accepted deliberately and mitigated: `Cache-Control` is
 * `private, no-store` and `Referrer-Policy` is `no-referrer`, so the URL is
 * not cached by shared proxies and is not leaked onward in a Referer header.
 * The conversation ref identifies a conversation, not a person; a widget
 * visitor is anonymous by construction and no auth session exists to steal.
 *
 * WHAT ACTUALLY AUTHORISES THE READ
 *
 * Not the widget key on its own — that is public, it ships in the customer's
 * page source. The database requires all of: a live key, an origin that key
 * allows, the visitor's own conversation ref, AND a recorded disclosure saying
 * this asset was already shown in that conversation. Walking asset ids gains
 * nothing, and revoking "show in answers" or un-publishing the course cuts
 * access off at the next read even for a visitor who saw it a minute ago.
 */
export const dynamic = "force-dynamic";

/** Byte range, `null` for a whole-object request, `false` when unsatisfiable. */
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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export function OPTIONS(request: Request) {
  return preflightResponse(request, "GET");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ visualAssetId: string }> },
) {
  const origin = requestOrigin(request);
  if (origin === null) return widgetRefusal();

  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key")?.trim() ?? "";
    const conversationRef = url.searchParams.get("conversationRef") ?? "";
    const { visualAssetId } = await context.params;
    if (
      !isWidgetKey(key) ||
      !isConversationRef(conversationRef) ||
      !isUuid(visualAssetId)
    ) {
      return widgetRefusal(400);
    }

    const supabase = createWidgetSupabaseClient();
    const asset = await widgetGetVisualAsset(supabase, {
      widgetKey: key,
      origin,
      conversationRef,
      visualAssetId,
    });

    // Re-validate what the database returned rather than trusting it. The same
    // defence the authenticated route applies: an object key that could escape
    // its prefix, or a media type outside the validated allowlist, is refused
    // here even though the pipeline should never produce one.
    if (
      asset.privateObjectKey.length === 0 ||
      asset.privateObjectKey.includes("..") ||
      !VISUAL_MEDIA_EXTENSIONS.has(asset.mediaType) ||
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes < 1 ||
      asset.sizeBytes > 20_971_520
    ) {
      return widgetRefusal(404);
    }

    const requestedRange = rangeFor(
      request.headers.get("range"),
      asset.sizeBytes,
    );
    const signed = await supabase.storage
      .from("tenant-private")
      .createSignedUrl(asset.privateObjectKey, 60);
    if (signed.error || signed.data === null) return widgetRefusal(503);

    const baseHeaders: Record<string, string> = {
      ...allowedOriginHeaders(origin),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="visual.${VISUAL_MEDIA_EXTENSIONS.get(asset.mediaType)}"`,
      // The bytes are media, never a document: no script, no plugin, no frame.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox",
      "Content-Type": asset.mediaType,
      // Cross-origin by design — this is embedded on the customer's page — but
      // only for the origin the database already approved above.
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };

    if (requestedRange === false) {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${asset.sizeBytes}`,
        },
      });
    }

    const upstream = await fetch(signed.data.signedUrl, {
      cache: "no-store",
      headers:
        requestedRange === null
          ? {}
          : { Range: `bytes=${requestedRange.start}-${requestedRange.end}` },
    });
    if (
      upstream.body === null ||
      (requestedRange === null
        ? upstream.status !== 200
        : upstream.status !== 206)
    ) {
      return widgetRefusal(503);
    }

    if (requestedRange !== null) {
      return new Response(upstream.body, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(
            requestedRange.end - requestedRange.start + 1,
          ),
          "Content-Range": `bytes ${requestedRange.start}-${requestedRange.end}/${asset.sizeBytes}`,
        },
      });
    }
    return new Response(upstream.body, {
      headers: {
        ...baseHeaders,
        "Content-Length": String(asset.sizeBytes),
      },
    });
  } catch (error) {
    if (error instanceof WidgetRpcError) {
      return widgetRefusal(
        error.code === "rate_limited"
          ? 429
          : error.code === "invalid_request"
            ? 400
            : 404,
      );
    }
    return widgetRefusal(503);
  }
}
