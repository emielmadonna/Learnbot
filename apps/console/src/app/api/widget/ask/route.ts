import {
  answerGroundedLearningQuestion,
  LearningProviderError,
  type GroundingSource,
} from "../../../../lib/learning-provider";
import {
  createWidgetSupabaseClient,
  isConversationRef,
  isCourseRef,
  isWidgetKey,
  widgetAsk,
  WidgetRpcError,
  widgetRecordAnswer,
} from "../../../../lib/supabase/widget-rpc";
import {
  allowedOriginHeaders,
  preflightResponse,
  requestOrigin,
  widgetJson,
  widgetRefusal,
} from "../cors";

/**
 * POST /api/widget/ask
 *
 * One anonymous, grounded turn. See ../cors.ts for why this route does not use
 * `assertSameOrigin`.
 *
 * Order of operations, and why:
 *   1. `widget_ask` re-checks the (key, origin) pair, applies the SQL rate
 *      limits and durably records the visitor's question BEFORE any model call.
 *      A refused request therefore costs nothing and writes nothing.
 *   2. The persona is read back only because this process holds the server-side
 *      conversation operation token. It shapes the answer and is never returned
 *      to the page.
 *   3. `widget_record_answer` stores the assistant turn, gated by that same
 *      token, so a browser cannot forge one.
 *
 * The response is returned whole rather than streamed, matching
 * /api/learning/respond, which does not stream either.
 */
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function OPTIONS(request: Request) {
  return preflightResponse(request, "POST");
}

export async function POST(request: Request) {
  const origin = requestOrigin(request);
  if (origin === null) return widgetRefusal();

  try {
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) return widgetRefusal(400);
    const key = typeof input.key === "string" ? input.key.trim() : "";
    const conversationRef =
      typeof input.conversationRef === "string" ? input.conversationRef : "";
    const question =
      typeof input.question === "string" ? input.question.trim() : "";
    const courseRef = isCourseRef(input.courseRef) ? input.courseRef : null;
    if (
      !isWidgetKey(key) ||
      !isConversationRef(conversationRef) ||
      question.length < 2 ||
      question.length > 2_000
    ) {
      return widgetRefusal(400);
    }

    const operationToken =
      process.env.LEARNINGBOT_CONVERSATION_OPERATION_TOKEN?.trim() ?? "";
    if (operationToken.length < 32) {
      // Without the operation token the assistant turn could not be recorded,
      // so refuse before charging the tenant for a model call.
      return Response.json(
        { ok: false, code: "widget_unconfigured" },
        {
          status: 503,
          headers: {
            "Cache-Control": "private, no-store",
            ...allowedOriginHeaders(origin),
          },
        },
      );
    }

    const turnId = crypto.randomUUID();
    const traceId = `widget-response:${turnId}`;
    const supabase = createWidgetSupabaseClient();

    const asked = await widgetAsk(supabase, {
      widgetKey: key,
      origin,
      question,
      conversationRef,
      courseRef,
      idempotencyKey: `widget-turn:${turnId}`,
      traceId,
      operationToken,
    });

    const sources: GroundingSource[] = asked.matches.map((match) => ({
      // The widget never receives course, document or lesson UUIDs, so the
      // grounding record carries the opaque source ref instead. The content
      // hash still ties every cited excerpt back to an exact stored chunk.
      chunkId: match.sourceRef,
      courseId: "",
      courseTitle: match.courseTitle,
      documentId: "",
      documentTitle: match.documentTitle,
      contentHash: match.contentHash,
      excerpt: match.excerpt.replace(/<\/?b>/giu, ""),
      lessonId: null,
      lessonTitle: match.lessonTitle,
      sectionName: match.sectionName,
    }));

    const answer = await answerGroundedLearningQuestion({
      assistantName: asked.assistantName,
      // Deliberately empty: the widget path never learns the tenant id, and the
      // provider context must not become the one place it leaks.
      tenantId: "",
      actorId: "widget-anonymous",
      requestId: turnId,
      traceId,
      idempotencyKey: turnId,
      question,
      intent: "explain",
      scopeLabel: null,
      personaInstructions: asked.directive?.personaInstructions ?? null,
      tone: asked.directive?.tone ?? null,
      history: [],
      sources,
    });

    const evidence = sources.map((source) => ({
      sourceRef: source.chunkId,
      title: source.lessonTitle ?? source.documentTitle,
      courseTitle: source.courseTitle,
      sectionName: source.sectionName,
      excerpt: source.excerpt,
      contentHash: source.contentHash,
    }));

    await widgetRecordAnswer(supabase, {
      widgetKey: key,
      origin,
      conversationRef,
      answer: answer.answer,
      sources: evidence,
      providerKey: `${answer.provider}:${answer.adapterId}`.slice(0, 100),
      providerRequestRef: answer.providerRequestRef,
      idempotencyKey: `widget-turn:${turnId}`,
      traceId,
      operationToken,
    });

    return widgetJson(
      {
        ok: true,
        conversationRef,
        message: {
          role: "assistant",
          content: answer.answer,
          createdAt: new Date().toISOString(),
          sources: evidence,
        },
        retrievalMode: asked.retrievalMode,
      },
      origin,
    );
  } catch (error) {
    if (error instanceof WidgetRpcError && error.code === "rate_limited") {
      const retryAfter = error.retryAfterSeconds ?? 60;
      return Response.json(
        { ok: false, code: "rate_limited", retryAfterSeconds: retryAfter },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store",
            "Retry-After": String(retryAfter),
            ...allowedOriginHeaders(origin),
          },
        },
      );
    }
    if (error instanceof LearningProviderError) {
      return Response.json(
        { ok: false, code: "answer_unavailable", retryable: error.retryable },
        {
          status: 503,
          headers: {
            "Cache-Control": "private, no-store",
            ...allowedOriginHeaders(origin),
          },
        },
      );
    }
    // Anything else — including a disallowed origin or an unknown key — is the
    // same opaque refusal with no CORS headers at all.
    return widgetRefusal();
  }
}
