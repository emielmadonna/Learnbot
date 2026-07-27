import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";

/**
 * Durable learning analytics wrappers.
 *
 * Every metric arrives inside the same envelope the intelligence core uses:
 * an explicit known / partial / unknown state with the limitations that make
 * the number honest. An `unknown` metric carries no `value` at all, so a
 * missing measurement can never be rendered as a measured zero.
 */

export type AnalyticsMetricState = "known" | "partial" | "unknown";

export type AnalyticsMetric<TValue> =
  | {
      state: "known" | "partial";
      value: TValue;
      dataThrough?: string;
      evidenceRefs: string[];
      limitations: string[];
    }
  | {
      state: "unknown";
      evidenceRefs: string[];
      limitations: string[];
    };

export type AnalyticsRange = {
  start: string;
  end: string;
  timeZone: "UTC";
  dayCount: number;
  bucket?: "day";
};

type AnalyticsEnvelope = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  range: AnalyticsRange;
  definitions: Record<string, string>;
};

/**
 * Surface dimension (20260726094000).
 *
 * Every field below is optional on the pre-existing envelopes, because a
 * workspace whose database has not yet taken the widget-analytics migration
 * answers exactly as it did before. The console must render that as "not
 * recorded", never as a widget that nobody used.
 */
export type AnalyticsSurfaceName = "console" | "widget" | "api";

/**
 * How much of a requested range the surface dimension covers. `none` means the
 * range ends before surface recording began — the honest answer there is
 * unknown, and a zero would be a different and unfounded claim.
 */
export type AnalyticsSurfaceCoverage = "none" | "partial" | "full";

export type AnalyticsSurfaceProvenance = {
  requested: AnalyticsSurfaceName | null;
  applied: string;
  surfaces: AnalyticsSurfaceName[];
  attributionStartedAt: string;
  coverage: AnalyticsSurfaceCoverage;
  coverageNote: string;
  recordedAttributions: number;
  inferredAttributions: number;
  attributionSources: Record<string, string>;
};

export type AnalyticsSurfaceRow = {
  surface: AnalyticsSurfaceName;
  questions: number;
  conversations: number;
  /** Distinct authenticated conversation subjects. */
  verifiedLearners: number;
  /** Distinct pseudonymous widget references. Never added to the line above. */
  anonymousVisitors: number;
  anonymousQuestions: number;
  anonymousConversationsWithoutVisitorKey?: number;
  unattributedQuestions: number;
  questionsPerConversation?: number | null;
  recordedAttributions?: number;
  inferredAttributions?: number;
  share?: number | null;
  lastQuestionAt?: string | null;
};

export type AnalyticsSurfaceDayEntry = {
  questions: number;
  verifiedLearners: number;
  anonymousVisitors: number;
};

export type AnalyticsSurfaceBucket = {
  bucketStart: string;
  questions: number;
  surfaces: Partial<Record<AnalyticsSurfaceName, AnalyticsSurfaceDayEntry>>;
};

export type AnalyticsSurfaceVolume = {
  totalQuestions: number;
  surfaces: AnalyticsSurfaceRow[];
  buckets: AnalyticsSurfaceBucket[];
  recordedAttributions: number;
  inferredAttributions: number;
};

export type AnalyticsSurfaceBreakdown = AnalyticsEnvelope & {
  surface: AnalyticsSurfaceProvenance;
  metrics: { surfaceVolume: AnalyticsMetric<AnalyticsSurfaceVolume> };
};

export type AnalyticsWidgetOrigin = {
  hostOrigin: string;
  questions: number;
  conversations: number;
  pages: number;
  anonymousVisitors: number;
  lastQuestionAt: string | null;
};

export type AnalyticsWidgetHostPage = {
  hostOrigin: string;
  hostPath: string;
  hostPageTitle: string | null;
  questions: number;
  conversations: number;
  questionsPerConversation: number | null;
  anonymousVisitors: number;
  verifiedLearners: number;
  lastQuestionAt: string | null;
};

export type AnalyticsWidgetEngagementValue = {
  conversationsStarted: number;
  verifiedConversations: number;
  anonymousConversations: number;
  anonymousVisitors: number;
  verifiedLearners: number;
  widgetKeys: number;
  hostOrigins: number;
  conversationsWithoutOrigin: number;
  origins: AnalyticsWidgetOrigin[];
};

export type AnalyticsWidgetEngagement = AnalyticsEnvelope & {
  surface: AnalyticsSurfaceProvenance;
  limits: { hostPages: number; hostOrigins: number; truncated: boolean };
  metrics: {
    widgetEngagement: AnalyticsMetric<AnalyticsWidgetEngagementValue>;
    hostPageQuestions: AnalyticsMetric<{
      pages: AnalyticsWidgetHostPage[];
      omittedPages: number;
    }>;
  };
};

export type AnalyticsWidgetDeflectionCluster = {
  hostOrigin: string;
  hostPath: string;
  hostPageTitle: string | null;
  courseId: string | null;
  courseTitle: string | null;
  moduleId: string | null;
  moduleTitle: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  questions: number;
  deflectedQuestions: number;
  ungroundedQuestions: number;
  unansweredQuestions: number;
  unattributedQuestions: number;
  conversations: number;
  anonymousVisitors: number;
  verifiedLearners: number;
  deflectionShare: number | null;
  lastDeflectedAt: string | null;
};

export type AnalyticsWidgetContentGaps = AnalyticsEnvelope & {
  surface: AnalyticsSurfaceProvenance;
  limits: { clusters: number; truncated: boolean };
  metrics: {
    widgetGroundingCoverage: AnalyticsMetric<{
      answers: number;
      groundedAnswers: number;
      ungroundedAnswers: number;
      answersWithoutSourceRecord: number;
      ungroundedShare: number | null;
      averageSourceCount: number | null;
      lastAnswerAt: string | null;
    }>;
    widgetDeflections: AnalyticsMetric<{
      questions: number;
      deflectedQuestions: number;
      ungroundedQuestions: number;
      unansweredQuestions: number;
      unattributedQuestions: number;
      anonymousVisitors: number;
      deflectionShare: number | null;
      lastDeflectedAt: string | null;
      clusters: AnalyticsWidgetDeflectionCluster[];
      omittedClusters: number;
    }>;
  };
};

export type AnalyticsWidgetSnapshot = {
  breakdown: AnalyticsSurfaceBreakdown;
  engagement: AnalyticsWidgetEngagement;
  contentGaps: AnalyticsWidgetContentGaps;
};

export type AnalyticsVolumeBucket = {
  bucketStart: string;
  questions: number;
  textQuestions: number;
  voiceQuestions: number;
  activeLearners: number;
};

export type AnalyticsQuestionVolume = {
  totalQuestions: number;
  studentQuestions: number;
  staffQuestions: number;
  unattributedQuestions: number;
  activeConversations: number;
  lastQuestionAt: string | null;
  buckets: AnalyticsVolumeBucket[];
};

export type AnalyticsTenantOverview = AnalyticsEnvelope & {
  /** Present only once the widget-analytics migration is applied. */
  surface?: AnalyticsSurfaceProvenance;
  metrics: {
    questionVolume: AnalyticsMetric<AnalyticsQuestionVolume>;
    activeLearners: AnalyticsMetric<{ learners: number }>;
    channelSplit: AnalyticsMetric<{
      textQuestions: number;
      voiceQuestions: number;
      voiceShare: number | null;
    }>;
    /** Never known today: no request-start timestamp is persisted. */
    answerLatencyMs: AnalyticsMetric<never>;
    turnRecordingIntervalMs: AnalyticsMetric<{
      observations: number;
      averageMs: number | null;
      medianMs: number | null;
      p90Ms: number | null;
    }>;
    /** Present only once the widget-analytics migration is applied. */
    surfaceSplit?: AnalyticsMetric<{
      surfaces: AnalyticsSurfaceRow[];
      recordedAttributions: number;
      inferredAttributions: number;
    }>;
  };
};

export type AnalyticsLessonQuestions = {
  lessonId: string;
  lessonTitle: string;
  lessonStatus: string;
  position: number;
  questions: number;
  learners: number;
  share: number | null;
  lastQuestionAt: string | null;
};

export type AnalyticsModuleQuestions = {
  moduleId: string;
  moduleTitle: string;
  moduleStatus: string;
  position: number;
  questions: number;
  learners: number;
  share: number | null;
  shareOfCourse: number | null;
  moduleOnlyQuestions: number;
  lastQuestionAt: string | null;
  lessons: AnalyticsLessonQuestions[];
  omittedLessons: number;
  omittedLessonQuestions: number;
};

export type AnalyticsCourseQuestions = {
  courseId: string;
  courseTitle: string;
  courseStatus: string;
  questions: number;
  learners: number;
  share: number | null;
  courseOnlyQuestions: number;
  lastQuestionAt: string | null;
  modules: AnalyticsModuleQuestions[];
  omittedModules: number;
  omittedModuleQuestions: number;
};

export type AnalyticsQuestionDistributionValue = {
  totalQuestions: number;
  attributedQuestions: number;
  lastQuestionAt: string | null;
  courses: AnalyticsCourseQuestions[];
  unattributed: {
    questions: number;
    learners: number;
    share: number | null;
  };
  omittedCourses: number;
  omittedCourseQuestions: number;
  /** Present only once the widget-analytics migration is applied. */
  bySurface?: AnalyticsSurfaceRow[] | null;
};

export type AnalyticsQuestionDistribution = AnalyticsEnvelope & {
  /** Present only once the widget-analytics migration is applied. */
  surface?: AnalyticsSurfaceProvenance;
  limits: {
    courses: number;
    modulesPerCourse: number;
    lessonsPerModule: number;
    truncated: boolean;
  };
  distribution: AnalyticsMetric<AnalyticsQuestionDistributionValue>;
};

export type AnalyticsSourceCountBucket = {
  label: string;
  minSources: number;
  maxSources: number | null;
  answers: number;
};

export type AnalyticsGroundingCoverage = {
  answers: number;
  groundedAnswers: number;
  ungroundedAnswers: number;
  answersWithoutSourceRecord: number;
  ungroundedShare: number | null;
  averageSourceCount: number | null;
  lastAnswerAt: string | null;
  sourceCountBuckets: AnalyticsSourceCountBucket[];
};

export type AnalyticsContentGapCluster = {
  courseId: string | null;
  courseTitle: string | null;
  moduleId: string | null;
  moduleTitle: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  ungroundedAnswers: number;
  answers: number;
  ungroundedShare: number | null;
  lastUngroundedAt: string | null;
};

export type AnalyticsAnswerQuality = AnalyticsEnvelope & {
  /** Present only once the widget-analytics migration is applied. */
  surface?: AnalyticsSurfaceProvenance;
  limits: { clusters: number; truncated: boolean };
  metrics: {
    groundingCoverage: AnalyticsMetric<AnalyticsGroundingCoverage>;
    /** Never known today: no retrieval score is persisted per answer. */
    retrievalConfidence: AnalyticsMetric<never>;
    contentGapSignals: AnalyticsMetric<{
      clusters: AnalyticsContentGapCluster[];
      omittedClusters: number;
    }>;
    /** Present only once the widget-analytics migration is applied. */
    surfaceGrounding?: AnalyticsMetric<{
      surfaces: {
        surface: AnalyticsSurfaceName;
        answers: number;
        groundedAnswers: number;
        ungroundedAnswers: number;
        answersWithoutSourceRecord: number;
        ungroundedShare: number | null;
        averageSourceCount: number | null;
        lastAnswerAt: string | null;
      }[];
    }>;
  };
};

export type AnalyticsCourseFunnelEntry = {
  courseId: string;
  courseTitle: string;
  courseStatus: string;
  learnersWithProgress: number;
  learnersStarted: number;
  learnersInProgress: number;
  learnersBlocked: number;
  learnersCompleted: number;
  completionRateOfStarted: number | null;
  averagePercentComplete: number | null;
  stalledLearners: number;
  learnersWithUnknownActivity: number;
  lessonsCompletedInRange: number;
  activeLearnersInRange: number;
  lastActivityAt: string | null;
};

export type AnalyticsLearnerProgress = AnalyticsEnvelope & {
  limits: { courses: number; truncated: boolean };
  stalledThresholdDays: number;
  metrics: {
    courseFunnel: AnalyticsMetric<{
      courses: AnalyticsCourseFunnelEntry[];
      omittedCourses: number;
      learnersWithUnknownActivity: number;
    }>;
    /** Never known today: no course completion timestamp is recorded. */
    courseCompletionTiming: AnalyticsMetric<never>;
  };
};

export type AnalyticsSnapshot = {
  overview: AnalyticsTenantOverview;
  distribution: AnalyticsQuestionDistribution;
  answerQuality: AnalyticsAnswerQuality;
  learnerProgress: AnalyticsLearnerProgress;
};

export class AnalyticsRpcError extends Error {
  constructor(readonly code: string) {
    super(`Analytics request denied: ${code}`);
    this.name = "AnalyticsRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireAnalyticsRpcSuccess(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new AnalyticsRpcError("invalid_response");
  if (value.ok !== true) {
    throw new AnalyticsRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  if (value.dataMode !== "durable" || !isRecord(value.range)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return value;
}

function requireMetric(value: unknown): void {
  if (
    !isRecord(value) ||
    (value.state !== "known" &&
      value.state !== "partial" &&
      value.state !== "unknown") ||
    !Array.isArray(value.limitations) ||
    !Array.isArray(value.evidenceRefs) ||
    (value.state !== "unknown" && value.value === undefined) ||
    (value.state === "unknown" && value.value !== undefined)
  ) {
    throw new AnalyticsRpcError("invalid_response");
  }
}

function requireMetrics(result: Record<string, unknown>, names: string[]) {
  const metrics = result.metrics;
  if (!isRecord(metrics)) throw new AnalyticsRpcError("invalid_response");
  for (const name of names) requireMetric(metrics[name]);
}

export function parseAnalyticsTenantOverview(
  value: unknown,
): AnalyticsTenantOverview {
  const result = requireAnalyticsRpcSuccess(value);
  requireMetrics(result, [
    "questionVolume",
    "activeLearners",
    "channelSplit",
    "answerLatencyMs",
    "turnRecordingIntervalMs",
  ]);
  return result as unknown as AnalyticsTenantOverview;
}

export function parseAnalyticsQuestionDistribution(
  value: unknown,
): AnalyticsQuestionDistribution {
  const result = requireAnalyticsRpcSuccess(value);
  requireMetric(result.distribution);
  if (!isRecord(result.limits)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsQuestionDistribution;
}

export function parseAnalyticsAnswerQuality(
  value: unknown,
): AnalyticsAnswerQuality {
  const result = requireAnalyticsRpcSuccess(value);
  requireMetrics(result, [
    "groundingCoverage",
    "retrievalConfidence",
    "contentGapSignals",
  ]);
  return result as unknown as AnalyticsAnswerQuality;
}

export function parseAnalyticsLearnerProgress(
  value: unknown,
): AnalyticsLearnerProgress {
  const result = requireAnalyticsRpcSuccess(value);
  requireMetrics(result, ["courseFunnel", "courseCompletionTiming"]);
  if (typeof result.stalledThresholdDays !== "number") {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsLearnerProgress;
}

function requireSurface(result: Record<string, unknown>): void {
  const surface = result.surface;
  if (
    !isRecord(surface) ||
    typeof surface.coverage !== "string" ||
    typeof surface.coverageNote !== "string"
  ) {
    throw new AnalyticsRpcError("invalid_response");
  }
}

export function parseAnalyticsSurfaceBreakdown(
  value: unknown,
): AnalyticsSurfaceBreakdown {
  const result = requireAnalyticsRpcSuccess(value);
  requireSurface(result);
  requireMetrics(result, ["surfaceVolume"]);
  return result as unknown as AnalyticsSurfaceBreakdown;
}

export function parseAnalyticsWidgetEngagement(
  value: unknown,
): AnalyticsWidgetEngagement {
  const result = requireAnalyticsRpcSuccess(value);
  requireSurface(result);
  requireMetrics(result, ["widgetEngagement", "hostPageQuestions"]);
  if (!isRecord(result.limits)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsWidgetEngagement;
}

export function parseAnalyticsWidgetContentGaps(
  value: unknown,
): AnalyticsWidgetContentGaps {
  const result = requireAnalyticsRpcSuccess(value);
  requireSurface(result);
  requireMetrics(result, ["widgetGroundingCoverage", "widgetDeflections"]);
  if (!isRecord(result.limits)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsWidgetContentGaps;
}

export type AnalyticsRangeInput = {
  rangeStart: string | null;
  rangeEnd: string | null;
};

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Resolves caller-supplied range parameters without silently repairing them.
 * An unparseable, reversed or oversized range is rejected here so the RPC is
 * never asked to guess what the operator meant.
 */
export function parseAnalyticsRange(
  start: string | null,
  end: string | null,
): AnalyticsRangeInput {
  const startMs = start === null ? null : Date.parse(start);
  const endMs = end === null ? null : Date.parse(end);
  if (
    (startMs !== null && Number.isNaN(startMs)) ||
    (endMs !== null && Number.isNaN(endMs))
  ) {
    throw new AnalyticsRpcError("invalid_range");
  }
  if (startMs !== null && endMs !== null) {
    if (endMs <= startMs || endMs - startMs > MAX_RANGE_MS) {
      throw new AnalyticsRpcError("invalid_range");
    }
  }
  return {
    rangeStart: startMs === null ? null : new Date(startMs).toISOString(),
    rangeEnd: endMs === null ? null : new Date(endMs).toISOString(),
  };
}

async function executeAnalyticsRpc(
  supabase: SupabaseClient,
  name: string,
  range: AnalyticsRangeInput,
): Promise<unknown> {
  const response = await supabase.rpc(name, {
    range_start: range.rangeStart,
    range_end: range.rangeEnd,
  });
  if (response.error) {
    throw new AuthenticationBoundaryError(
      "analytics.request_failed",
      "The durable analytics query could not be completed.",
    );
  }
  return response.data;
}

export async function getAnalyticsTenantOverview(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsTenantOverview> {
  return parseAnalyticsTenantOverview(
    await executeAnalyticsRpc(supabase, "analytics_tenant_overview", range),
  );
}

export async function getAnalyticsQuestionDistribution(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsQuestionDistribution> {
  return parseAnalyticsQuestionDistribution(
    await executeAnalyticsRpc(
      supabase,
      "analytics_question_distribution",
      range,
    ),
  );
}

export async function getAnalyticsAnswerQuality(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsAnswerQuality> {
  return parseAnalyticsAnswerQuality(
    await executeAnalyticsRpc(supabase, "analytics_answer_quality", range),
  );
}

export async function getAnalyticsLearnerProgress(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsLearnerProgress> {
  return parseAnalyticsLearnerProgress(
    await executeAnalyticsRpc(supabase, "analytics_learner_progress", range),
  );
}

export async function getAnalyticsSurfaceBreakdown(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsSurfaceBreakdown> {
  return parseAnalyticsSurfaceBreakdown(
    await executeAnalyticsRpc(supabase, "analytics_surface_breakdown", range),
  );
}

export async function getAnalyticsWidgetEngagement(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsWidgetEngagement> {
  return parseAnalyticsWidgetEngagement(
    await executeAnalyticsRpc(supabase, "analytics_widget_engagement", range),
  );
}

export async function getAnalyticsWidgetContentGaps(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsWidgetContentGaps> {
  return parseAnalyticsWidgetContentGaps(
    await executeAnalyticsRpc(
      supabase,
      "analytics_widget_content_gaps",
      range,
    ),
  );
}

/**
 * The three surface RPCs load as one unit and separately from the four
 * original ones, so a workspace without the widget-analytics migration still
 * gets the rest of the insights surface and is told plainly that surface
 * attribution is not available rather than shown zero widget activity.
 */
export async function getAnalyticsWidgetSnapshot(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsWidgetSnapshot> {
  const [breakdown, engagement, contentGaps] = await Promise.all([
    getAnalyticsSurfaceBreakdown(supabase, range),
    getAnalyticsWidgetEngagement(supabase, range),
    getAnalyticsWidgetContentGaps(supabase, range),
  ]);
  return { breakdown, contentGaps, engagement };
}

export async function getAnalyticsSnapshot(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsSnapshot> {
  const [overview, distribution, answerQuality, learnerProgress] =
    await Promise.all([
      getAnalyticsTenantOverview(supabase, range),
      getAnalyticsQuestionDistribution(supabase, range),
      getAnalyticsAnswerQuality(supabase, range),
      getAnalyticsLearnerProgress(supabase, range),
    ]);
  return { overview, distribution, answerQuality, learnerProgress };
}
