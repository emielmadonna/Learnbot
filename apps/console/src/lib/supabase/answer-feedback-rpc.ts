import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";
import { AnalyticsRpcError } from "./analytics-rpc";

/**
 * "Rated helpful" — the readout half of
 * 20260731061000_answer_feedback_and_lesson_reception.sql.
 *
 * The migration shipped `public.learning_answer_feedback_summary` and nothing
 * ever called it, so the Insights card stayed on its hard-coded "Not measured"
 * placeholder even once ratings existed. This module is that missing caller.
 *
 * The envelope is deliberately NOT the `analytics_*` one: this RPC takes a
 * window in days rather than a range, and returns no `range`/`definitions`, so
 * `requireAnalyticsRpcSuccess` would reject it. It is parsed strictly here
 * instead, and it reuses `AnalyticsRpcError` only so the panel's existing error
 * mapping keeps working.
 *
 * `helpfulPercent` and `ratedPercent` are `null`, never `0`, when the
 * denominator is empty — the caller must render that as "not measured" and must
 * not print a zero that reads as a measurement.
 */
export type AnswerFeedbackSummary = {
  /** Assistant answers recorded in the window — the response-rate denominator. */
  readonly answerCount: number;
  /** Answers carrying at least one rating. One rating per rater, not per click. */
  readonly ratedCount: number;
  readonly helpfulCount: number;
  /** helpful / rated, or null when nothing has been rated. */
  readonly helpfulPercent: number | null;
  /** rated / answered, or null when nothing has been answered. */
  readonly ratedPercent: number | null;
  readonly windowDays: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return value;
}

function optionalPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return value;
}

export function parseAnswerFeedbackSummary(
  value: unknown,
): AnswerFeedbackSummary {
  if (!isRecord(value)) throw new AnalyticsRpcError("invalid_response");
  if (value.ok !== true) {
    throw new AnalyticsRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  if (value.dataMode !== "durable") {
    throw new AnalyticsRpcError("invalid_response");
  }
  const summary: AnswerFeedbackSummary = {
    answerCount: requireCount(value.answerCount),
    ratedCount: requireCount(value.ratedCount),
    helpfulCount: requireCount(value.helpfulCount),
    helpfulPercent: optionalPercent(value.helpfulPercent),
    ratedPercent: optionalPercent(value.ratedPercent),
    windowDays: requireCount(value.windowDays),
  };
  // A percentage that arrives without its denominator is not a measurement.
  if (summary.ratedCount === 0 && summary.helpfulPercent !== null) {
    throw new AnalyticsRpcError("invalid_response");
  }
  if (summary.ratedCount > summary.answerCount) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return summary;
}

/** The RPC's own bound; anything outside it is rejected rather than clamped. */
export function requireFeedbackWindowDays(value: unknown): number {
  const days = typeof value === "string" ? Number(value) : value;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 366
  ) {
    throw new AnalyticsRpcError("invalid_range");
  }
  return days;
}

export async function getAnswerFeedbackSummary(
  supabase: SupabaseClient,
  windowDays: number,
): Promise<AnswerFeedbackSummary> {
  const response = await supabase.rpc("learning_answer_feedback_summary", {
    window_days: windowDays,
  });
  if (response.error) {
    // A project without the answer-feedback migration answers with an error
    // here. That is "not available", never "nobody found it helpful".
    throw new AuthenticationBoundaryError(
      "analytics.request_failed",
      "The answer-feedback summary could not be read.",
    );
  }
  return parseAnswerFeedbackSummary(response.data);
}
