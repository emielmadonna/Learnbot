import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
} from "../../../../lib/supabase/auth-boundary";
import {
  AnalyticsRpcError,
  getAnalyticsWidgetSnapshot,
  parseAnalyticsRange,
} from "../../../../lib/supabase/analytics-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";

/**
 * Surface analytics for the insights panel: the console/widget split, widget
 * engagement by host page, and the widget deflection list.
 *
 * These three RPCs are served separately from `/api/analytics` on purpose. A
 * workspace whose database has not yet taken the widget-analytics migration
 * must still get the rest of the insights surface, and must be told that
 * surface attribution is unavailable rather than shown a widget with zero
 * traffic — those are different claims.
 */

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
      error.code === "invalid_surface"
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
    const range = parseAnalyticsRange(
      url.searchParams.get("start"),
      url.searchParams.get("end"),
    );
    const supabase = await authenticatedLearningClient(request);
    const snapshot = await getAnalyticsWidgetSnapshot(supabase, range);
    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        range: snapshot.breakdown.range,
        generatedAt: snapshot.breakdown.generatedAt,
        breakdown: snapshot.breakdown,
        engagement: snapshot.engagement,
        contentGaps: snapshot.contentGaps,
      },
      { headers: noStore },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
