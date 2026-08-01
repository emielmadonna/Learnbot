import { POST as askWithWidgetKey } from "../../../api/widget/ask/route";
import { createWidgetSupabaseClient } from "../../../../lib/supabase/widget-rpc";
import {
  normalizeHostedSlug,
  resolveHostedAssistant,
} from "../hosted-rpc";

export const dynamic = "force-dynamic";

type HostedAskContext = {
  params: Promise<{ slug: string }>;
};

function unavailable() {
  return Response.json(
    { ok: false, code: "widget_unavailable" },
    {
      status: 404,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin",
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request, context: HostedAskContext) {
  const origin = request.headers.get("origin");
  const { slug: rawSlug } = await context.params;
  const slug = normalizeHostedSlug(rawSlug);
  const operationToken =
    process.env.LEARNINGBOT_CONVERSATION_OPERATION_TOKEN?.trim() ?? "";
  if (
    origin === null ||
    origin === "null" ||
    origin.length > 255 ||
    slug === null ||
    operationToken.length < 32
  ) {
    return unavailable();
  }

  try {
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) return unavailable();

    const resolution = await resolveHostedAssistant(
      createWidgetSupabaseClient(),
      {
        slug,
        origin,
        operationToken,
      },
    );

    // Reuse the existing, hardened answer route so validation, rate limits,
    // provider behavior, citations, answer recording and opaque errors cannot
    // drift between embedded, legacy and friendly hosted delivery.
    //
    // `accept` is forwarded, and it is the only header here that changes what
    // comes back: /api/widget/ask streams on `text/event-stream` and returns
    // JSON otherwise. Dropping it -- which this did until now -- would have
    // left the hosted full-page assistant the one customer-facing surface that
    // could not stream, no matter what its own client asked for.
    const accept = request.headers.get("accept");
    const forwarded = new Request(new URL("/api/widget/ask", request.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(accept === null || accept.length > 255 ? {} : { accept }),
      },
      body: JSON.stringify({
        ...input,
        key: resolution.deliveryKey,
      }),
      // Preserved so a visitor closing the hosted page aborts the provider
      // call behind it rather than paying for tokens nobody will read.
      signal: request.signal,
    });
    return askWithWidgetKey(forwarded);
  } catch (error) {
    // Keep the public response opaque, but leave a safe server-side diagnostic
    // so an operator can distinguish provider/database faults without logging
    // the question, widget key, operation token, or tenant identity.
    console.error("[hosted-assistant] ask unavailable", {
      slug,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : null,
    });
    return unavailable();
  }
}
