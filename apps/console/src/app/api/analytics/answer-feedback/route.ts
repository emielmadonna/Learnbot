import { NextResponse } from "next/server";

import {
  AuthenticationBoundaryError,
  assertSameOrigin,
} from "../../../../lib/supabase/auth-boundary";
import { AnalyticsRpcError } from "../../../../lib/supabase/analytics-rpc";
import {
  getAnswerFeedbackSummary,
  requireFeedbackWindowDays,
} from "../../../../lib/supabase/answer-feedback-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";

/**
 * GET /api/analytics/answer-feedback?days=30
 *
 * The Insights "Rated helpful" card. Loads separately from `/api/analytics`
 * for the same reason widget analytics and learner signals do: a project that
 * has not taken 20260731061000 must lose this one card and nothing else.
 *
 * The response never invents a percentage. `helpfulPercent` is null until
 * something has been rated, and `answerCount` travels with it so the card can
 * state the response rate the score is drawn from.
 */
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store" } as const;

/**
 * Browsers omit `Origin` on a same-origin GET, so an unconditional
 * `assertSameOrigin` would reject every legitimate console read. Any request
 * that does declare an origin, or that the browser labels as cross-site, is
 * still verified against the exact request origin and rejected on mismatch.
 */
function assertSameOriginRead(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite !== null &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_origin",
      "The request origin could not be verified.",
    );
  }
  if (request.headers.get("origin") !== null) assertSameOrigin(request);
}

function errorResponse(error: unknown) {
  if (error instanceof AnalyticsRpcError) {
    if (error.code === "access_denied") {
      return NextResponse.json(
        { ok: false, code: "access_denied" },
        { status: 403, headers: noStore },
      );
    }
    if (
      error.code === "invalid_range" ||
      error.code === "invalid_request" ||
      error.code === "tenant_selection_required"
    ) {
      return NextResponse.json(
        { ok: false, code: error.code },
        { status: 400, headers: noStore },
      );
    }
    return NextResponse.json(
      { ok: false, code: "request_denied" },
      { status: 400, headers: noStore },
    );
  }
  if (
    error instanceof AuthenticationBoundaryError &&
    error.code === "analytics.request_failed"
  ) {
    return NextResponse.json(
      { ok: false, code: "request_failed" },
      { status: 503, headers: noStore },
    );
  }
  return NextResponse.json(
    { ok: false, code: "authentication_required" },
    { status: 401, headers: noStore },
  );
}

export async function GET(request: Request) {
  try {
    assertSameOriginRead(request);
    const url = new URL(request.url);
    const days = requireFeedbackWindowDays(
      url.searchParams.get("days") ?? "30",
    );
    const supabase = await authenticatedLearningClient(request);
    const feedback = await getAnswerFeedbackSummary(supabase, days);
    return NextResponse.json(
      { ok: true, dataMode: "durable", feedback },
      { headers: noStore },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
