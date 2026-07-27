import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../lib/supabase/auth-boundary";
import {
  AnalyticsRpcError,
  getAnalyticsAnswerQuality,
  getAnalyticsLearnerProgress,
  getAnalyticsQuestionDistribution,
  getAnalyticsSnapshot,
  getAnalyticsTenantOverview,
  parseAnalyticsRange,
} from "../../../lib/supabase/analytics-rpc";
import { authenticatedLearningClient } from "../../../lib/supabase/learning-route";

const noStore = { "Cache-Control": "private, no-store" } as const;

const sections = new Set([
  "overview",
  "distribution",
  "answer-quality",
  "learner-progress",
]);

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
    if (error.code === "invalid_range" || error.code === "invalid_request") {
      return NextResponse.json(
        { ok: false, code: error.code },
        { status: 400, headers: noStore },
      );
    }
    // The RPC answered, but not in a shape this route can vouch for. That is a
    // contract fault on the database side, never a client error.
    return NextResponse.json(
      { ok: false, code: error.code },
      { status: 502, headers: noStore },
    );
  }
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: noStore },
    );
  }
  // Fail closed without lying about the cause: an unclassified failure here is
  // not evidence that the caller is signed out.
  return NextResponse.json(
    { ok: false, code: "request_failed" },
    { status: 500, headers: noStore },
  );
}

export async function GET(request: Request) {
  try {
    assertSameOriginRead(request);
    const url = new URL(request.url);
    const section = url.searchParams.get("section");
    if (section !== null && !sections.has(section)) {
      throw new AnalyticsRpcError("invalid_request");
    }
    const range = parseAnalyticsRange(
      url.searchParams.get("start"),
      url.searchParams.get("end"),
    );

    const supabase = await authenticatedLearningClient(request);
    if (section === "overview") {
      return NextResponse.json(
        await getAnalyticsTenantOverview(supabase, range),
        { headers: noStore },
      );
    }
    if (section === "distribution") {
      return NextResponse.json(
        await getAnalyticsQuestionDistribution(supabase, range),
        { headers: noStore },
      );
    }
    if (section === "answer-quality") {
      return NextResponse.json(
        await getAnalyticsAnswerQuality(supabase, range),
        { headers: noStore },
      );
    }
    if (section === "learner-progress") {
      return NextResponse.json(
        await getAnalyticsLearnerProgress(supabase, range),
        { headers: noStore },
      );
    }

    const snapshot = await getAnalyticsSnapshot(supabase, range);
    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        range: snapshot.overview.range,
        generatedAt: snapshot.overview.generatedAt,
        overview: snapshot.overview,
        distribution: snapshot.distribution,
        answerQuality: snapshot.answerQuality,
        learnerProgress: snapshot.learnerProgress,
      },
      { headers: noStore },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
