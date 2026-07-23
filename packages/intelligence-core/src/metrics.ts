import type {
  ActivityObservation,
  ConfusionMetric,
  ContentGapMetric,
  DataHealthSnapshot,
  DataSource,
  IsoTimestamp,
  LessonCompletionObservation,
  MetricResult,
  ModuleVelocityMetric,
  QuestionObservation,
  SourceCoverage,
  StallMetric,
  TenantId,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const CONTENT_GAP_WINDOW_MS = 30 * DAY_MS;
const CONTENT_GAP_CONFIDENCE_THRESHOLD = 0.55;

interface Readiness {
  readonly state: "known" | "partial" | "unknown";
  readonly dataThrough?: IsoTimestamp;
  readonly limitations: readonly string[];
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function sourceMap(health: DataHealthSnapshot): Map<DataSource, SourceCoverage> {
  return new Map(health.sources.map((source) => [source.source, source]));
}

function readiness(
  health: DataHealthSnapshot,
  tenantId: TenantId,
  requiredSources: readonly DataSource[],
): Readiness {
  if (health.tenantId !== tenantId) {
    return {
      state: "unknown",
      limitations: ["data_health_tenant_mismatch"],
    };
  }
  const sources = sourceMap(health);
  const limitations: string[] = [];
  let state: Readiness["state"] = "known";
  const through: string[] = [];
  for (const required of requiredSources) {
    const source = sources.get(required);
    if (source === undefined || source.state === "missing") {
      limitations.push(`missing_source:${required}`);
      state = "unknown";
      continue;
    }
    if (source.state === "degraded") {
      limitations.push(`degraded_source:${required}`);
      if (state !== "unknown") state = "partial";
    } else if (source.state === "partial") {
      limitations.push(`partial_source:${required}`);
      if (state !== "unknown") state = "partial";
    }
    if (source.dataThrough !== undefined && validTimestamp(source.dataThrough)) {
      through.push(source.dataThrough);
    } else {
      limitations.push(`missing_data_through:${required}`);
      if (state === "known") state = "partial";
    }
  }
  const dataThrough =
    through.length === 0
      ? undefined
      : through.reduce((earliest, timestamp) =>
          Date.parse(timestamp) < Date.parse(earliest) ? timestamp : earliest,
        );
  return {
    state,
    ...(dataThrough === undefined ? {} : { dataThrough }),
    limitations,
  };
}

function unknown<T>(
  ready: Readiness,
  limitations: readonly string[],
  evidenceRefs: readonly string[] = [],
): MetricResult<T> {
  return {
    state: "unknown",
    ...(ready.dataThrough === undefined ? {} : { dataThrough: ready.dataThrough }),
    evidenceRefs,
    limitations: [...new Set([...ready.limitations, ...limitations])],
  };
}

function result<T>(
  ready: Readiness,
  value: T,
  evidenceRefs: readonly string[],
  additionalLimitations: readonly string[] = [],
): MetricResult<T> {
  const limitations = [...new Set([...ready.limitations, ...additionalLimitations])];
  if (ready.state === "known" && limitations.length === 0 && ready.dataThrough !== undefined) {
    return {
      state: "known",
      value,
      dataThrough: ready.dataThrough,
      evidenceRefs,
      limitations: [],
    };
  }
  return {
    state: "partial",
    value,
    ...(ready.dataThrough === undefined ? {} : { dataThrough: ready.dataThrough }),
    evidenceRefs,
    limitations:
      limitations.length === 0 ? ["coverage_not_proven_complete"] : limitations,
  };
}

export interface ComputeConfusionInput {
  readonly tenantId: TenantId;
  readonly lessonId: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly attributedQuestionEventIds: readonly string[];
  readonly activeStudentIds: readonly string[];
  readonly health: DataHealthSnapshot;
}

export function computeConfusion(
  input: ComputeConfusionInput,
): MetricResult<ConfusionMetric> {
  const ready = readiness(input.health, input.tenantId, ["events", "identity"]);
  const evidenceRefs = [...new Set(input.attributedQuestionEventIds)];
  if (ready.state === "unknown") return unknown(ready, [], evidenceRefs);
  const activeStudents = new Set(input.activeStudentIds).size;
  if (activeStudents === 0) {
    return unknown(
      ready,
      ["active_student_denominator_unavailable"],
      evidenceRefs,
    );
  }
  const questionsAttributed = evidenceRefs.length;
  return result(
    ready,
    {
      lessonId: input.lessonId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      questionsAttributed,
      activeStudents,
      questionsPerActiveStudent: questionsAttributed / activeStudents,
    },
    evidenceRefs,
  );
}

export interface ComputeContentGapInput {
  readonly tenantId: TenantId;
  readonly clusterId: string;
  readonly asOf: IsoTimestamp;
  readonly questions: readonly QuestionObservation[];
  readonly health: DataHealthSnapshot;
}

export function computeContentGap(
  input: ComputeContentGapInput,
): MetricResult<ContentGapMetric> {
  const ready = readiness(input.health, input.tenantId, ["messages", "retrieval"]);
  if (ready.state === "unknown") return unknown(ready, []);
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) return unknown(ready, ["invalid_as_of"]);
  const foreign = input.questions.some((question) => question.tenantId !== input.tenantId);
  if (foreign) return unknown(ready, ["cross_tenant_input"]);

  const windowStartMs = asOfMs - CONTENT_GAP_WINDOW_MS;
  const questions = input.questions.filter((question) => {
    const occurredAt = Date.parse(question.occurredAt);
    return (
      question.clusterId === input.clusterId &&
      Number.isFinite(occurredAt) &&
      occurredAt >= windowStartMs &&
      occurredAt <= asOfMs
    );
  });
  const confidence = questions
    .map((question) => question.retrievalConfidence)
    .filter(
      (value): value is number =>
        value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1,
    );
  const missingConfidence = confidence.length !== questions.length;
  const average =
    confidence.length === 0
      ? undefined
      : confidence.reduce((sum, value) => sum + value, 0) / confidence.length;
  const value: ContentGapMetric = {
    clusterId: input.clusterId,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(asOfMs).toISOString(),
    questionCount: questions.length,
    confidenceObservationCount: confidence.length,
    ...(average === undefined ? {} : { averageRetrievalConfidence: average }),
    ...(average === undefined
      ? questions.length === 0
        ? { isContentGap: false }
        : {}
      : { isContentGap: average < CONTENT_GAP_CONFIDENCE_THRESHOLD }),
  };
  return result(
    ready,
    value,
    questions.map((question) => question.id),
    missingConfidence ? ["retrieval_confidence_incomplete"] : [],
  );
}

function utcDay(timestamp: string): string | undefined {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

export interface ComputeStallInput {
  readonly tenantId: TenantId;
  readonly subjectUserId: string;
  readonly asOf: IsoTimestamp;
  readonly completionRatio?: number;
  readonly activity: readonly ActivityObservation[];
  readonly health: DataHealthSnapshot;
}

export function computeStall(input: ComputeStallInput): MetricResult<StallMetric> {
  const ready = readiness(input.health, input.tenantId, ["events", "progress"]);
  if (ready.state === "unknown") return unknown(ready, []);
  if (
    input.completionRatio === undefined ||
    !Number.isFinite(input.completionRatio) ||
    input.completionRatio < 0 ||
    input.completionRatio > 1
  ) {
    return unknown(ready, ["completion_ratio_unavailable"]);
  }
  if (input.activity.some((item) => item.tenantId !== input.tenantId)) {
    return unknown(ready, ["cross_tenant_input"]);
  }
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) return unknown(ready, ["invalid_as_of"]);
  const relevant = input.activity
    .filter((item) => item.subjectUserId === input.subjectUserId)
    .map((item) => ({ item, occurredAt: Date.parse(item.occurredAt) }))
    .filter(
      (entry) =>
        Number.isFinite(entry.occurredAt) &&
        entry.occurredAt <= asOfMs,
    )
    .sort((left, right) => left.occurredAt - right.occurredAt);
  if (relevant.length === 0) {
    return result(
      ready,
      {
        subjectUserId: input.subjectUserId,
        activeDaysInFourteenDayWindow: 0,
        inactiveDays: 0,
        completionRatio: input.completionRatio,
        stalled: false,
      },
      [],
    );
  }
  const latest = relevant[relevant.length - 1]!.occurredAt;
  const fourteenDayWindowStart = latest - 13 * DAY_MS;
  const activeDays = new Set(
    relevant
      .filter((entry) => entry.occurredAt >= fourteenDayWindowStart)
      .map((entry) => utcDay(entry.item.occurredAt))
      .filter((day): day is string => day !== undefined),
  ).size;
  const inactiveDays = Math.floor((asOfMs - latest) / DAY_MS);
  return result(
    ready,
    {
      subjectUserId: input.subjectUserId,
      activeDaysInFourteenDayWindow: activeDays,
      inactiveDays,
      completionRatio: input.completionRatio,
      stalled:
        activeDays >= 3 && inactiveDays >= 14 && input.completionRatio < 0.8,
    },
    relevant.map((entry) => entry.item.id),
  );
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface ComputeModuleVelocityInput {
  readonly tenantId: TenantId;
  readonly subjectUserId: string;
  readonly cohortSubjectUserIds: readonly string[];
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly completions: readonly LessonCompletionObservation[];
  readonly health: DataHealthSnapshot;
}

export function computeModuleVelocity(
  input: ComputeModuleVelocityInput,
): MetricResult<ModuleVelocityMetric> {
  const ready = readiness(input.health, input.tenantId, ["progress", "identity"]);
  if (ready.state === "unknown") return unknown(ready, []);
  if (input.completions.some((item) => item.tenantId !== input.tenantId)) {
    return unknown(ready, ["cross_tenant_input"]);
  }
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return unknown(ready, ["invalid_velocity_window"]);
  }
  const cohortIds = [...new Set(input.cohortSubjectUserIds)];
  if (cohortIds.length === 0) return unknown(ready, ["cohort_unavailable"]);
  const weeks = (end - start) / WEEK_MS;
  const inWindow = input.completions.filter((item) => {
    const completedAt = Date.parse(item.completedAt);
    return Number.isFinite(completedAt) && completedAt >= start && completedAt <= end;
  });
  const rateFor = (subjectUserId: string): number =>
    new Set(
      inWindow
        .filter((item) => item.subjectUserId === subjectUserId)
        .map((item) => item.lessonId),
    ).size / weeks;
  const subjectRate = rateFor(input.subjectUserId);
  const cohortMedian = median(cohortIds.map(rateFor));
  if (cohortMedian === undefined) return unknown(ready, ["cohort_unavailable"]);
  const difference = subjectRate - cohortMedian;
  return result(
    ready,
    {
      subjectUserId: input.subjectUserId,
      lessonsPerWeek: subjectRate,
      sameTenantCohortMedian: cohortMedian,
      differenceFromMedian: difference,
      comparison: difference < 0 ? "slower" : difference > 0 ? "faster" : "same",
    },
    inWindow.map((item) => item.id),
  );
}
