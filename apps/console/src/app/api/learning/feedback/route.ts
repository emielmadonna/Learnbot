import { NextResponse } from "next/server";

import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";

/**
 * POST /api/learning/feedback
 *
 * "Was that helpful?" for a signed-in learner. One rating per person per
 * answer; re-rating replaces, so the tenant's score counts people rather than
 * clicks (see 20260731061000_answer_feedback_and_lesson_reception.sql).
 *
 * The route deliberately does not accept a conversation id. The database
 * re-derives the conversation from the message under the caller's own tenant,
 * so a caller cannot attach a rating to an answer it cannot see.
 */
export const dynamic = "force-dynamic";

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["answer_not_found", 404],
  ["invalid_request", 400],
  ["tenant_selection_required", 409],
  ["request_failed", 503],
]);

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return response({ ok: false, code: failure.code }, failure.status);
  }
  if (error instanceof LearningRpcError) {
    return response(
      { ok: false, code: error.code },
      statusByCode.get(error.code) ?? 400,
    );
  }
  return response({ ok: false, code: "request_failed" }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request);
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");

    const messageId = typeof input.messageId === "string" ? input.messageId : "";
    const rating = input.rating;
    if (
      !UUID.test(messageId) ||
      (rating !== "helpful" && rating !== "not_helpful")
    ) {
      throw new LearningRpcError("invalid_request");
    }

    const result = await executeLearningRpc(
      supabase,
      "learning_record_answer_feedback",
      { target_message_id: messageId, requested_rating: rating },
    );
    return response({ ok: true, rating: result.rating });
  } catch (error) {
    return errorResponse(error);
  }
}
