import {
  createWidgetSupabaseClient,
  isConversationRef,
  isWidgetKey,
  requireWidgetRpcSuccess,
  WidgetRpcError,
} from "../../../../lib/supabase/widget-rpc";
import {
  preflightResponse,
  requestOrigin,
  widgetJson,
  widgetRefusal,
} from "../cors";

/**
 * POST /api/widget/feedback
 *
 * "Did that help? Yes / Not really" for an anonymous widget visitor.
 *
 * Unlike recording an ANSWER, this needs no server operation token: an opinion
 * about an answer is something the visitor is entitled to submit directly. What
 * stops it being abused is the unique index — one rating per conversation per
 * answer, re-rating updates in place — plus the fact that the message must
 * belong to the conversation the caller proved it holds. A message id from
 * someone else's conversation matches nothing.
 *
 * See ../cors.ts for why this route does not use `assertSameOrigin`.
 */
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
    const messageId = typeof input.messageId === "string" ? input.messageId : "";
    const rating = input.rating;
    if (
      !isWidgetKey(key) ||
      !isConversationRef(conversationRef) ||
      !UUID.test(messageId) ||
      (rating !== "helpful" && rating !== "not_helpful")
    ) {
      return widgetRefusal(400);
    }

    const supabase = createWidgetSupabaseClient();
    const response = await supabase.rpc("widget_record_answer_feedback", {
      widget_key: key,
      origin,
      conversation_ref: conversationRef,
      target_message_id: messageId,
      requested_rating: rating,
    });
    if (response.error) throw new WidgetRpcError("request_failed");
    const result = requireWidgetRpcSuccess(response.data);

    return widgetJson({ ok: true, rating: result.rating }, origin);
  } catch (error) {
    if (error instanceof WidgetRpcError) {
      return widgetRefusal(error.code === "invalid_request" ? 400 : 404);
    }
    return widgetRefusal(503);
  }
}
