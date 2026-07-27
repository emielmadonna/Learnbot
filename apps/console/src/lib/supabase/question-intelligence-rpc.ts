import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";
import {
  AnalyticsRpcError,
  requireAnalyticsRpcSuccess,
  type AnalyticsMetric,
  type AnalyticsRange,
  type AnalyticsRangeInput,
} from "./analytics-rpc";

/**
 * Question intelligence wrappers — labels and signals.
 *
 * These reuse the MetricResult envelope from `analytics-rpc`, so known,
 * partial and unknown behave identically to every other analytics surface. Two
 * things are specific to this file and matter for honesty:
 *
 *   * a question with no label is reported as `unclassifiedQuestions`, never
 *     folded into a topic; and
 *   * when nothing in a range has been classified, `topicDistribution`,
 *     `intentDistribution` and `importantQuestions` arrive as `unknown` with
 *     no `value` at all, so the console cannot draw an empty chart that would
 *     read as "no questions were asked".
 */

export type QuestionIntentName =
  | "definition"
  | "how_to"
  | "troubleshooting"
  | "scope_check"
  | "clarification"
  | "off_topic";

export type QuestionImportanceName = "routine" | "notable" | "critical";

export type QuestionGroundingOutcome =
  | "grounded"
  | "ungrounded"
  | "not_recorded"
  | "no_answer";

export type SignalKind =
  | "topic_spike"
  | "content_gap"
  | "repeated_question_cluster"
  | "post_lesson_stall"
  | "unattributed_questions"
  // Widget-aware detectors (20260726094000). They are composed onto the same
  // detection function, so they arrive through this same RPC with the same
  // evidence and the same forward-only review lifecycle.
  | "widget_page_ungrounded"
  | "widget_anonymous_spike"
  | "widget_unpublished_content";

export type SignalSeverity = "watch" | "elevated" | "critical";

export type SignalReviewStatus =
  | "new"
  | "acknowledged"
  | "actioned"
  | "dismissed";

export const SIGNAL_REVIEW_ACTIONS = [
  "acknowledged",
  "actioned",
  "dismissed",
] as const;

export type SignalReviewAction = (typeof SIGNAL_REVIEW_ACTIONS)[number];

type QuestionEnvelope = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  range: AnalyticsRange;
  definitions: Record<string, string>;
};

export type ClassificationCoverage = {
  questions: number;
  classifiedQuestions: number;
  unclassifiedQuestions: number;
  learners: number;
  coverageShare: number | null;
  lastQuestionAt: string | null;
  lastClassifiedAt: string | null;
};

export type TopicSampleQuestion = {
  messageId: string;
  question: string;
  truncatedQuestion: boolean;
  intent: QuestionIntentName;
  importance: QuestionImportanceName;
  groundingOutcome: QuestionGroundingOutcome;
  courseId: string | null;
  lessonId: string | null;
  askedAt: string;
};

export type TopicEntry = {
  topicKey: string;
  topicLabel: string;
  questions: number;
  learners: number;
  share: number | null;
  shareOfClassified: number | null;
  groundedAnswers: number;
  ungroundedAnswers: number;
  lastSeenAt: string | null;
  intents: { intent: QuestionIntentName; questions: number }[];
  sampleQuestions: TopicSampleQuestion[];
  omittedQuestions: number;
};

export type UnclassifiedRemainder = {
  questions: number;
  share: number | null;
};

export type TopicDistributionValue = {
  classifiedQuestions: number;
  topics: TopicEntry[];
  omittedTopics: number;
  omittedTopicQuestions: number;
  unclassified: UnclassifiedRemainder;
};

export type IntentEntry = {
  intent: QuestionIntentName;
  questions: number;
  learners: number;
  share: number | null;
  shareOfClassified: number | null;
  lastSeenAt: string | null;
};

export type IntentDistributionValue = {
  classifiedQuestions: number;
  intents: IntentEntry[];
  unclassified: UnclassifiedRemainder;
};

export type ImportantQuestion = {
  messageId: string;
  question: string;
  truncatedQuestion: boolean;
  topicKey: string;
  topicLabel: string;
  intent: QuestionIntentName;
  importance: QuestionImportanceName;
  recurrence: number;
  recurrenceLearners: number;
  groundingOutcome: QuestionGroundingOutcome;
  courseId: string | null;
  courseTitle: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  askedAt: string;
};

export type ImportantQuestionsValue = {
  questions: ImportantQuestion[];
  omittedQuestions: number;
};

export type AnalyticsQuestionLabels = QuestionEnvelope & {
  limits: {
    topics: number;
    questionsPerTopic: number;
    importantQuestions: number;
    truncated: boolean;
  };
  intentTaxonomy: QuestionIntentName[];
  metrics: {
    classificationCoverage: AnalyticsMetric<ClassificationCoverage>;
    /** `unknown` whenever nothing in the range has been classified. */
    topicDistribution: AnalyticsMetric<TopicDistributionValue>;
    intentDistribution: AnalyticsMetric<IntentDistributionValue>;
    importantQuestions: AnalyticsMetric<ImportantQuestionsValue>;
  };
};

export type DetectedSignal = {
  signalFingerprint: string;
  kind: SignalKind;
  severity: SignalSeverity;
  severityRank: number;
  headline: string;
  detail: string;
  courseId: string | null;
  moduleId: string | null;
  lessonId: string | null;
  observedValue: number | null;
  comparisonValue: number | null;
  evidence: Record<string, unknown>;
  evidenceRefs: string[];
  review: {
    status: SignalReviewStatus;
    note: string | null;
    reviewedAt: string | null;
    reviewedByRole: string | null;
    firstDetectedAt: string | null;
  };
};

export type DetectedSignalsValue = {
  signals: DetectedSignal[];
  detectedSignals: number;
  omittedSignals: number;
  bySeverity: Record<SignalSeverity, number>;
  classifiedQuestionsInRange: number;
};

export type AnalyticsSignals = QuestionEnvelope & {
  limits: { signals: number; truncated: boolean };
  reviewStatuses: SignalReviewStatus[];
  metrics: {
    detectedSignals: AnalyticsMetric<DetectedSignalsValue>;
    /** Never known: these signal kinds have no recorded input at all. */
    undetectableSignals: AnalyticsMetric<never>;
  };
};

// ------------------------------------------------------ per-learner signals

/**
 * Per-learner readout: depth, escalating specificity, stuck lessons and
 * next-offer readiness. Every learner row is derived in SQL from
 * `public.question_labels`, `public.student_progress` and
 * `app_private.user_access_accounts` by `public.analytics_learner_signals` —
 * see that migration for the exact honesty rules. Nothing here is estimated
 * client-side: a learner whose trend cannot be computed carries
 * `escalation.state === "insufficient_data"` rather than a guessed direction,
 * and `readiness.tier === "insufficient_data"` whenever no course-progress
 * record exists at all.
 */
export type EscalationState =
  | "escalating"
  | "steady"
  | "declining"
  | "insufficient_data";

export type LearnerEscalation = {
  state: EscalationState;
  sampleSize: number;
  firstHalfAvgSpecificity: number | null;
  secondHalfAvgSpecificity: number | null;
};

export type StuckCluster = {
  lessonId: string | null;
  lessonTitle: string | null;
  courseId: string | null;
  courseTitle: string | null;
  topicKey: string;
  topicLabel: string;
  repeats: number;
  lastAskedAt: string;
};

export type LearnerStuck = {
  clusterCount: number;
  clusters: StuckCluster[];
};

export type ReadinessTier =
  | "likely_ready"
  | "possible"
  | "not_yet"
  | "insufficient_data";

export type LearnerReadiness = {
  tier: ReadinessTier;
  evidence: {
    maxPercentComplete: number | null;
    hasCompletedCourse: boolean;
    questions: number;
    notableOrCriticalQuestions: number;
  };
};

export type LearnerSignalRow = {
  subjectUserId: string;
  /** An account email, or `null` when the learner has no admin-provisioned account row. */
  displayName: string | null;
  questions: number;
  distinctTopics: number;
  distinctLessons: number;
  distinctCourses: number;
  notableOrCriticalQuestions: number;
  criticalQuestions: number;
  ungroundedAnswers: number;
  firstAskedAt: string;
  lastAskedAt: string;
  depth: { notableOrCriticalShare: number | null };
  escalation: LearnerEscalation;
  stuck: LearnerStuck;
  readiness: LearnerReadiness;
};

export type LearnerCoverage = {
  questions: number;
  classifiedQuestions: number;
  unclassifiedQuestions: number;
  learners: number;
  classifiedLearners: number;
};

export type LearnerRowsValue = {
  learners: LearnerSignalRow[];
  omittedLearners: number;
};

export type AnalyticsLearnerSignals = QuestionEnvelope & {
  limits: { learners: number; truncated: boolean };
  thresholds: {
    minQuestionsForTrend: number;
    stuckRepeatThreshold: number;
    escalationMargin: number;
  };
  specificityTaxonomy: Record<string, number>;
  metrics: {
    learnerCoverage: AnalyticsMetric<LearnerCoverage>;
    /** `unknown` whenever nothing in the range has been classified. */
    learnerRows: AnalyticsMetric<LearnerRowsValue>;
  };
};

export function parseAnalyticsLearnerSignals(
  value: unknown,
): AnalyticsLearnerSignals {
  const result = requireAnalyticsRpcSuccess(value);
  if (!isRecord(result.metrics) || !isRecord(result.limits)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  requireMetric(result.metrics.learnerCoverage);
  requireMetric(result.metrics.learnerRows);
  if (
    !isRecord(result.thresholds) ||
    !isRecord(result.specificityTaxonomy)
  ) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsLearnerSignals;
}

export async function getAnalyticsLearnerSignals(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsLearnerSignals> {
  return parseAnalyticsLearnerSignals(
    await executeRpc(supabase, "analytics_learner_signals", {
      range_start: range.rangeStart,
      range_end: range.rangeEnd,
    }),
  );
}

export type QuestionIntelligenceSnapshot = {
  labels: AnalyticsQuestionLabels;
  signals: AnalyticsSignals;
};

export type SignalReviewResult = {
  ok: true;
  dataMode: "durable";
  signalFingerprint: string;
  kind: SignalKind;
  severity: SignalSeverity;
  previousStatus: SignalReviewStatus;
  reviewStatus: SignalReviewStatus;
  reviewedAt: string;
  recordVersion: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    // An unknown metric that still carries a value would let the console
    // render a measurement the platform says it does not have.
    (value.state === "unknown" && value.value !== undefined)
  ) {
    throw new AnalyticsRpcError("invalid_response");
  }
}

export function parseAnalyticsQuestionLabels(
  value: unknown,
): AnalyticsQuestionLabels {
  const result = requireAnalyticsRpcSuccess(value);
  if (!isRecord(result.metrics) || !isRecord(result.limits)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  for (const name of [
    "classificationCoverage",
    "topicDistribution",
    "intentDistribution",
    "importantQuestions",
  ]) {
    requireMetric(result.metrics[name]);
  }
  if (!Array.isArray(result.intentTaxonomy)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsQuestionLabels;
}

export function parseAnalyticsSignals(value: unknown): AnalyticsSignals {
  const result = requireAnalyticsRpcSuccess(value);
  if (!isRecord(result.metrics) || !isRecord(result.limits)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  requireMetric(result.metrics.detectedSignals);
  requireMetric(result.metrics.undetectableSignals);
  if (!Array.isArray(result.reviewStatuses)) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return result as unknown as AnalyticsSignals;
}

export function parseSignalReviewResult(value: unknown): SignalReviewResult {
  if (!isRecord(value)) throw new AnalyticsRpcError("invalid_response");
  if (value.ok !== true) {
    throw new AnalyticsRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  if (
    typeof value.signalFingerprint !== "string" ||
    typeof value.reviewStatus !== "string"
  ) {
    throw new AnalyticsRpcError("invalid_response");
  }
  return value as unknown as SignalReviewResult;
}

async function executeRpc(
  supabase: SupabaseClient,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const response = await supabase.rpc(name, input);
  if (response.error) {
    throw new AuthenticationBoundaryError(
      "analytics.request_failed",
      "The durable question intelligence query could not be completed.",
    );
  }
  return response.data;
}

export async function getAnalyticsQuestionLabels(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsQuestionLabels> {
  return parseAnalyticsQuestionLabels(
    await executeRpc(supabase, "analytics_question_labels", {
      range_start: range.rangeStart,
      range_end: range.rangeEnd,
    }),
  );
}

export async function getAnalyticsSignals(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<AnalyticsSignals> {
  return parseAnalyticsSignals(
    await executeRpc(supabase, "analytics_signals", {
      range_start: range.rangeStart,
      range_end: range.rangeEnd,
    }),
  );
}

export async function getQuestionIntelligenceSnapshot(
  supabase: SupabaseClient,
  range: AnalyticsRangeInput,
): Promise<QuestionIntelligenceSnapshot> {
  const [labels, signals] = await Promise.all([
    getAnalyticsQuestionLabels(supabase, range),
    getAnalyticsSignals(supabase, range),
  ]);
  return { labels, signals };
}

export type SignalReviewCommand = {
  readonly signalFingerprint: string;
  readonly nextStatus: SignalReviewAction;
  readonly note: string | null;
  readonly range: AnalyticsRangeInput;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly traceId: string;
};

export async function reviewAnalyticsSignal(
  supabase: SupabaseClient,
  command: SignalReviewCommand,
): Promise<SignalReviewResult> {
  return parseSignalReviewResult(
    await executeRpc(supabase, "analytics_signal_review", {
      signal_fingerprint: command.signalFingerprint,
      next_status: command.nextStatus,
      review_note: command.note,
      range_start: command.range.rangeStart,
      range_end: command.range.rangeEnd,
      idempotency_key: command.idempotencyKey,
      request_id: command.requestId,
      trace_id: command.traceId,
    }),
  );
}

/**
 * Records one classification. The database resolves the grounding outcome and
 * the course context itself, so only the classifier's own judgement travels.
 */
export type RecordQuestionLabelCommand = {
  readonly messageId: string;
  readonly topicKey: string;
  readonly topicLabel: string;
  readonly intent: string;
  readonly importance: string;
  readonly classifierKey: string;
  readonly classifierVersion: string;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly operationToken: string;
};

export async function recordQuestionLabel(
  supabase: SupabaseClient,
  command: RecordQuestionLabelCommand,
): Promise<{ ok: boolean; code?: string }> {
  const response = await supabase.rpc("learning_record_question_label", {
    target_message_id: command.messageId,
    topic_key: command.topicKey,
    topic_label: command.topicLabel,
    question_intent: command.intent,
    importance: command.importance,
    classifier_key: command.classifierKey,
    classifier_version: command.classifierVersion,
    trace_id: command.traceId,
    idempotency_key: command.idempotencyKey,
    operation_token: command.operationToken,
  });
  if (response.error) return { ok: false, code: "request_failed" };
  if (!isRecord(response.data)) return { ok: false, code: "invalid_response" };
  return {
    ok: response.data.ok === true,
    ...(typeof response.data.code === "string"
      ? { code: response.data.code }
      : {}),
  };
}
