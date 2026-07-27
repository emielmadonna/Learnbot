import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
} from "../../../../lib/supabase/auth-boundary";
import {
  AnalyticsRpcError,
  parseAnalyticsRange,
} from "../../../../lib/supabase/analytics-rpc";
import {
  SIGNAL_REVIEW_ACTIONS,
  getQuestionIntelligenceSnapshot,
  reviewAnalyticsSignal,
  type SignalReviewAction,
} from "../../../../lib/supabase/question-intelligence-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";

/**
 * Question intelligence for the insights panel.
 *
 * GET returns the label distribution and the detected signals for a range.
 * POST moves one signal through its review lifecycle; the database re-detects
 * the signal before it will persist a review, so this route never has to be
 * trusted about what was observed.
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
      error.code === "invalid_transition" ||
      error.code === "signal_not_found" ||
      error.code === "idempotency_conflict"
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
    const snapshot = await getQuestionIntelligenceSnapshot(supabase, range);
    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        range: snapshot.labels.range,
        generatedAt: snapshot.labels.generatedAt,
        labels: snapshot.labels,
        signals: snapshot.signals,
      },
      { headers: noStore },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reviewAction(value: unknown): SignalReviewAction {
  if (
    typeof value === "string" &&
    (SIGNAL_REVIEW_ACTIONS as readonly string[]).includes(value)
  ) {
    return value as SignalReviewAction;
  }
  throw new AnalyticsRpcError("invalid_request");
}

function fingerprint(value: unknown): string {
  if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) return value;
  throw new AnalyticsRpcError("invalid_request");
}

function reviewNote(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 1000) {
    throw new AnalyticsRpcError("invalid_request");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const input: unknown = await request.json().catch(() => null);
    if (!isRecord(input)) throw new AnalyticsRpcError("invalid_request");
    const range = parseAnalyticsRange(
      typeof input.start === "string" ? input.start : null,
      typeof input.end === "string" ? input.end : null,
    );
    const requestId = crypto.randomUUID();
    const result = await reviewAnalyticsSignal(supabase, {
      signalFingerprint: fingerprint(input.signalFingerprint),
      nextStatus: reviewAction(input.nextStatus),
      note: reviewNote(input.note),
      range,
      idempotencyKey: `signal-review:${crypto.randomUUID()}`,
      requestId,
      traceId: `signal-review:${requestId}`,
    });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
