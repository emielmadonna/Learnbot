"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PanelProps } from "../app-shell/contract";
import { useDataVersion } from "../app-shell/shell-data";
import {
  AnalyticsRpcError,
  parseAnalyticsAnswerQuality,
  parseAnalyticsLearnerProgress,
  parseAnalyticsQuestionDistribution,
  parseAnalyticsTenantOverview,
  type AnalyticsAnswerQuality,
  type AnalyticsLearnerProgress,
  type AnalyticsMetric,
  type AnalyticsQuestionDistribution,
  parseAnalyticsSurfaceBreakdown,
  parseAnalyticsWidgetContentGaps,
  parseAnalyticsWidgetEngagement,
  type AnalyticsSnapshot,
  type AnalyticsSurfaceName,
  type AnalyticsTenantOverview,
  type AnalyticsWidgetSnapshot,
} from "../../lib/supabase/analytics-rpc";
import {
  parseAnalyticsLearnerSignals,
  parseAnalyticsQuestionLabels,
  parseAnalyticsSignals,
  type AnalyticsLearnerSignals,
  type AnalyticsQuestionLabels,
  type AnalyticsSignals,
  type DetectedSignal,
  type EscalationState,
  type LearnerSignalRow,
  type QuestionGroundingOutcome,
  type QuestionImportanceName,
  type QuestionIntentName,
  type ReadinessTier,
  type SignalKind,
  type SignalReviewAction,
  type StuckCluster,
} from "../../lib/supabase/question-intelligence-rpc";
import {
  Button,
  DistributionBar,
  EmptyState,
  SelectField,
  StateBadge,
  StatTile,
  TrendChart,
  type DistributionItem,
  type TrendPoint,
} from "../ui";
import styles from "./insights-panel.module.css";
import learnerStyles from "./learner-signals-panel.module.css";

/*
 * Insights — durable learning analytics.
 *
 * Every number on this surface comes from one of the four analytics RPCs
 * through `/api/analytics`. Nothing is estimated in the browser: a metric the
 * platform reports as `unknown` renders as "Not known" with the reason the RPC
 * gave, a `partial` metric carries its badge and limitations, and a truncated
 * list always states what was left out. A range with no questions renders an
 * empty state rather than a flat line at zero.
 *
 * The shell already owns the dialog chrome for this panel, so no PanelFrame is
 * nested here — a second `role="dialog"` inside the shell's dialog would be an
 * accessibility regression. Everything else is a shared UI primitive.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

function isRangeValue(value: string): value is RangeValue {
  return RANGE_OPTIONS.some((option) => option.value === value);
}

/** Joins defined class names; a CSS module lookup can be undefined at type level. */
function cx(...values: readonly (string | false | undefined)[]) {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}

function count(value: number) {
  return value.toLocaleString();
}

function plural(value: number, singular: string, pluralForm?: string) {
  return value === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** Share is 0–1 from the RPC; `null` means the denominator was empty. */
function sharePercent(share: number | null | undefined): string | null {
  if (share === null || share === undefined || !Number.isFinite(share)) {
    return null;
  }
  const pct = share * 100;
  const rounded = pct >= 10 || pct === 0 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded}%`;
}

function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function formatDay(value: string | null | undefined): string | null {
  const ms = parseMs(value);
  if (ms === null) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function formatMoment(value: string | null | undefined): string | null {
  const ms = parseMs(value);
  if (ms === null) return null;
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** The reason string a StatTile must carry when there is no honest value. */
function reasonFrom(
  limitations: readonly string[],
  fallback: string,
): string {
  return limitations.length > 0 ? limitations.join(" ") : fallback;
}

// ---------------------------------------------------------------- fragments

type TileProps = {
  readonly label: string;
  readonly metricState: AnalyticsMetric<unknown>["state"];
  /** `undefined` means the platform has no honest value — never rendered as 0. */
  readonly value: string | undefined;
  /** Required: why the value is absent, or how a present value was measured. */
  readonly reason: string;
  readonly eyebrow?: string | undefined;
  readonly sublabel?: string | undefined;
  readonly footnote?: string | undefined;
  readonly asOf?: string | undefined;
};

/**
 * A StatTile that cannot lie: whenever the metric is unknown, or the value it
 * carries is genuinely absent, the tile renders the unknown state with the
 * reason instead of substituting a zero or a dash.
 */
function Tile({
  label,
  metricState,
  value,
  reason,
  eyebrow,
  sublabel,
  footnote,
  asOf,
}: TileProps) {
  if (metricState === "unknown" || value === undefined) {
    return (
      <StatTile
        asOf={asOf}
        eyebrow={eyebrow}
        footnote={footnote}
        label={label}
        reason={reason}
        state="unknown"
      />
    );
  }
  return (
    <StatTile
      asOf={asOf}
      eyebrow={eyebrow}
      footnote={footnote}
      label={label}
      reason={reason}
      state={metricState}
      sublabel={sublabel}
      value={value}
    />
  );
}

function Limitations({
  items,
  label,
}: {
  readonly items: readonly string[];
  readonly label: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className={styles.limitations}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Truncation({ children }: { readonly children: string }) {
  return <p className={styles.truncation}>{children}</p>;
}

function Facts({
  items,
}: {
  readonly items: readonly { label: string; value: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.facts}>
      {items.map((item) => (
        <li className={styles.fact} key={item.label}>
          <span className={styles.factLabel}>{item.label}</span>
          <span className={styles.factValue}>{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

function SectionHead({
  eyebrow,
  title,
  lede,
  state,
  stateLabel,
  large = false,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede?: string | undefined;
  readonly state?: AnalyticsMetric<unknown>["state"] | undefined;
  readonly stateLabel?: string | undefined;
  readonly large?: boolean | undefined;
}) {
  return (
    <div className={styles.sectionHead}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h3
          className={cx(styles.sectionTitle, large && styles.sectionTitleLarge)}
        >
          {title}
        </h3>
        {lede !== undefined && <p className={styles.sectionLede}>{lede}</p>}
      </div>
      {state !== undefined && (
        <div className={styles.badges}>
          <StateBadge state={state}>{stateLabel}</StateBadge>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------- question distribution

function DistributionSection({
  distribution,
}: {
  readonly distribution: AnalyticsQuestionDistribution;
}) {
  const metric = distribution.distribution;
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  const [showAllCourses, setShowAllCourses] = useState(false);

  if (metric.state === "unknown") {
    return (
      <section className={cx(styles.section, styles.sectionHeadline)}>
        <SectionHead
          eyebrow="Question distribution"
          large
          state="unknown"
          title="Where learners are asking"
        />
        <Tile
          label="Questions by course"
          metricState="unknown"
          reason={reasonFrom(
            metric.limitations,
            "The platform did not report a question distribution for this range.",
          )}
          value={undefined}
        />
      </section>
    );
  }

  const value = metric.value;
  const total = value.totalQuestions;
  const openCourse =
    value.courses.find((course) => course.courseId === openCourseId) ?? null;
  const openModule =
    openCourse?.modules.find((entry) => entry.moduleId === openModuleId) ?? null;

  const courseItems: DistributionItem[] = value.courses.map((course) => ({
    id: course.courseId,
    label: course.courseTitle,
    value: course.questions,
    sublabel: [
      `${count(course.learners)} ${plural(course.learners, "learner")}`,
      course.courseStatus === "published" ? null : course.courseStatus,
      course.courseOnlyQuestions > 0
        ? `${count(course.courseOnlyQuestions)} without a lesson`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    emphasis: course.courseId === openCourseId,
  }));

  return (
    <section className={cx(styles.section, styles.sectionHeadline)}>
      <SectionHead
        eyebrow="Question distribution"
        large
        lede="Every question asked in this range, attributed to the course, module and lesson recorded on its conversation. Select a course to drill into its modules and lessons."
        state={metric.state}
        title="Where learners are asking"
      />

      {total === 0 ? (
        <EmptyState
          description="No learner asked the assistant a question in this range. Widen the range, or check that the assistant is live on a published lesson."
          headline="No questions in this range"
        />
      ) : (
        <div className={styles.stack}>
          <Facts
            items={[
              { label: "Questions", value: count(total) },
              {
                label: "Attributed to a course",
                value: `${count(value.attributedQuestions)} · ${
                  sharePercent(
                    total === 0 ? null : value.attributedQuestions / total,
                  ) ?? "not known"
                }`,
              },
              {
                label: "Courses with questions",
                value: count(value.courses.length),
              },
              {
                label: "Last question",
                value: formatMoment(value.lastQuestionAt) ?? "not recorded",
              },
            ]}
          />

          <DistributionBar
            ariaLabel="Questions by course, share of all questions in range"
            caption="Questions by course"
            items={courseItems}
            maxItems={showAllCourses ? undefined : 8}
            onSelect={(item) => {
              setOpenModuleId(null);
              setOpenCourseId((current) =>
                current === item.id ? null : item.id,
              );
            }}
            total={total}
          />

          {courseItems.length > 8 && (
            <div className={styles.actions}>
              <Button
                onClick={() => setShowAllCourses((current) => !current)}
                size="sm"
              >
                {showAllCourses
                  ? "Show top 8 courses"
                  : `Show all ${count(courseItems.length)} courses`}
              </Button>
            </div>
          )}

          {value.unattributed.questions > 0 && (
            <p className={styles.unattributed}>
              <span>
                <strong>Outside any course</strong> ·{" "}
                {count(value.unattributed.questions)}{" "}
                {plural(value.unattributed.questions, "question")} from{" "}
                {count(value.unattributed.learners)}{" "}
                {plural(value.unattributed.learners, "learner")}. These
                conversations carry no course context, so they cannot be
                attributed to a course, module or lesson.
              </span>
              <strong>{sharePercent(value.unattributed.share) ?? "—"}</strong>
            </p>
          )}

          {value.omittedCourses > 0 && (
            <Truncation>
              {`This list is truncated: ${count(value.omittedCourses)} further ${plural(
                value.omittedCourses,
                "course",
              )} holding ${count(value.omittedCourseQuestions)} ${plural(
                value.omittedCourseQuestions,
                "question",
              )} are not returned by the query, which caps at the top ${count(
                distribution.limits.courses,
              )} courses by volume.`}
            </Truncation>
          )}

          {openCourse !== null && (
            <div className={styles.drill}>
              <div className={styles.drillHead}>
                <div>
                  <p className={styles.drillEyebrow}>Course drill-down</p>
                  <h4 className={styles.drillTitle}>
                    {openCourse.courseTitle}
                  </h4>
                </div>
                <Button onClick={() => setOpenCourseId(null)} size="sm">
                  Collapse
                </Button>
              </div>

              <Facts
                items={[
                  { label: "Questions", value: count(openCourse.questions) },
                  {
                    label: "Share of all questions",
                    value: sharePercent(openCourse.share) ?? "not known",
                  },
                  { label: "Learners", value: count(openCourse.learners) },
                  {
                    label: "Asked without a lesson",
                    value: count(openCourse.courseOnlyQuestions),
                  },
                  {
                    label: "Last question",
                    value:
                      formatMoment(openCourse.lastQuestionAt) ?? "not recorded",
                  },
                ]}
              />

              {openCourse.modules.length === 0 ? (
                <EmptyState
                  compact
                  description={`No question in this course was attributed to a module. ${count(
                    openCourse.courseOnlyQuestions,
                  )} ${plural(
                    openCourse.courseOnlyQuestions,
                    "question was",
                    "questions were",
                  )} asked in a conversation opened without a lesson.`}
                  headline="No module-level attribution"
                />
              ) : (
                <DistributionBar
                  ariaLabel={`Questions by module in ${openCourse.courseTitle}, share of all questions in range`}
                  caption="Questions by module"
                  items={openCourse.modules.map((entry) => ({
                    id: entry.moduleId,
                    label: entry.moduleTitle,
                    value: entry.questions,
                    sublabel: [
                      `${sharePercent(entry.shareOfCourse) ?? "—"} of this course`,
                      entry.moduleOnlyQuestions > 0
                        ? `${count(entry.moduleOnlyQuestions)} without a lesson`
                        : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" · "),
                    emphasis: entry.moduleId === openModuleId,
                  }))}
                  onSelect={(item) =>
                    setOpenModuleId((current) =>
                      current === item.id ? null : item.id,
                    )
                  }
                  total={total}
                />
              )}

              {openCourse.omittedModules > 0 && (
                <Truncation>
                  {`${count(openCourse.omittedModules)} further ${plural(
                    openCourse.omittedModules,
                    "module",
                  )} in this course holding ${count(
                    openCourse.omittedModuleQuestions,
                  )} ${plural(
                    openCourse.omittedModuleQuestions,
                    "question",
                  )} are not shown; the query returns the top ${count(
                    distribution.limits.modulesPerCourse,
                  )} modules per course.`}
                </Truncation>
              )}

              {openModule !== null && (
                <div className={cx(styles.drill, styles.drillNested)}>
                  <div className={styles.drillHead}>
                    <div>
                      <p className={styles.drillEyebrow}>Module drill-down</p>
                      <h5 className={styles.drillTitle}>
                        {openModule.moduleTitle}
                      </h5>
                    </div>
                    <Button onClick={() => setOpenModuleId(null)} size="sm">
                      Collapse
                    </Button>
                  </div>

                  {openModule.lessons.length === 0 ? (
                    <EmptyState
                      compact
                      description={`No question in this module was attributed to a lesson. ${count(
                        openModule.moduleOnlyQuestions,
                      )} ${plural(
                        openModule.moduleOnlyQuestions,
                        "question was",
                        "questions were",
                      )} asked with the module but no lesson recorded.`}
                      headline="No lesson-level attribution"
                    />
                  ) : (
                    <DistributionBar
                      ariaLabel={`Questions by lesson in ${openModule.moduleTitle}, share of all questions in range`}
                      caption="Questions by lesson"
                      items={openModule.lessons.map((lesson) => ({
                        id: lesson.lessonId,
                        label: lesson.lessonTitle,
                        value: lesson.questions,
                        sublabel: `${count(lesson.learners)} ${plural(
                          lesson.learners,
                          "learner",
                        )}${
                          lesson.lessonStatus === "published"
                            ? ""
                            : ` · ${lesson.lessonStatus}`
                        }`,
                      }))}
                      total={total}
                    />
                  )}

                  {openModule.omittedLessons > 0 && (
                    <Truncation>
                      {`${count(openModule.omittedLessons)} further ${plural(
                        openModule.omittedLessons,
                        "lesson",
                      )} holding ${count(
                        openModule.omittedLessonQuestions,
                      )} ${plural(
                        openModule.omittedLessonQuestions,
                        "question",
                      )} are not shown; the query returns the top ${count(
                        distribution.limits.lessonsPerModule,
                      )} lessons per module.`}
                    </Truncation>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Limitations
        items={metric.limitations}
        label="Question distribution limitations"
      />
    </section>
  );
}

// ------------------------------------------------------------ volume

function VolumeSection({
  overview,
}: {
  readonly overview: AnalyticsTenantOverview;
}) {
  const volume = overview.metrics.questionVolume;
  const learners = overview.metrics.activeLearners;
  const channel = overview.metrics.channelSplit;
  const latency = overview.metrics.answerLatencyMs;
  const interval = overview.metrics.turnRecordingIntervalMs;

  const dataThroughMs =
    volume.state === "unknown" ? null : parseMs(volume.dataThrough);

  const buckets = volume.state === "unknown" ? [] : volume.value.buckets;
  const observed = (bucketStart: string) => {
    const startMs = parseMs(bucketStart);
    if (startMs === null) return false;
    return dataThroughMs === null || startMs <= dataThroughMs;
  };

  const questionPoints: TrendPoint[] = buckets.map((bucket) => ({
    label: formatDay(bucket.bucketStart) ?? bucket.bucketStart,
    value: observed(bucket.bucketStart) ? bucket.questions : null,
  }));
  const learnerPoints: TrendPoint[] = buckets.map((bucket) => ({
    label: formatDay(bucket.bucketStart) ?? bucket.bucketStart,
    value: observed(bucket.bucketStart) ? bucket.activeLearners : null,
  }));

  const totalQuestions =
    volume.state === "unknown" ? null : volume.value.totalQuestions;
  const asOf = formatMoment(
    volume.state === "unknown" ? null : (volume.dataThrough ?? null),
  );

  const voiceShare =
    channel.state === "unknown" ? null : channel.value.voiceShare;
  const channelItems: DistributionItem[] =
    channel.state === "unknown"
      ? []
      : [
          {
            id: "text",
            label: "Typed",
            value: channel.value.textQuestions,
          },
          {
            id: "voice",
            label: "Voice",
            value: channel.value.voiceQuestions,
          },
        ];
  const channelTotal =
    channel.state === "unknown"
      ? 0
      : channel.value.textQuestions + channel.value.voiceQuestions;

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Volume and reach"
        lede="Questions per day, who was active, and how they asked. A day with no recorded activity is a real zero; a day beyond the measured window is drawn as a gap, never as a zero."
        state={volume.state}
        title="Question volume over time"
      />

      <div className={styles.tiles}>
        <Tile
          asOf={asOf ?? undefined}
          eyebrow="Range total"
          label="Questions asked"
          metricState={volume.state}
          reason={
            volume.state === "unknown"
              ? reasonFrom(
                  volume.limitations,
                  "The platform did not report question volume for this range.",
                )
              : "Final learner messages with a text or voice transcript modality."
          }
          sublabel={
            volume.state === "unknown"
              ? undefined
              : `${count(volume.value.studentQuestions)} from students · ${count(
                  volume.value.staffQuestions,
                )} from staff · ${count(
                  volume.value.activeConversations,
                )} ${plural(volume.value.activeConversations, "conversation")}`
          }
          value={totalQuestions === null ? undefined : count(totalQuestions)}
        />

        <Tile
          eyebrow="Range total"
          label="Active learners"
          metricState={learners.state}
          reason={
            learners.state === "unknown"
              ? reasonFrom(
                  learners.limitations,
                  "The platform did not report active learners for this range.",
                )
              : "Distinct conversation subjects who asked at least one question."
          }
          value={
            learners.state === "unknown"
              ? undefined
              : count(learners.value.learners)
          }
        />

        <Tile
          eyebrow="Channel"
          label="Asked by voice"
          metricState={channel.state}
          reason={
            channel.state === "unknown"
              ? reasonFrom(
                  channel.limitations,
                  "The platform did not report a channel split for this range.",
                )
              : voiceShare === null
                ? "No question was recorded in this range, so there is no split to divide."
                : "Recorded per turn from the message modality."
          }
          sublabel={
            channel.state === "unknown"
              ? undefined
              : `${count(channel.value.voiceQuestions)} voice · ${count(
                  channel.value.textQuestions,
                )} typed`
          }
          value={sharePercent(voiceShare) ?? undefined}
        />

        <Tile
          eyebrow="Not instrumented"
          label="Answer latency"
          metricState="unknown"
          reason={reasonFrom(
            latency.limitations,
            "Answer latency is not recorded anywhere in the durable schema.",
          )}
          value={undefined}
        />

        <Tile
          eyebrow="Nearest durable proxy"
          label="Turn recording interval"
          metricState={interval.state}
          reason={reasonFrom(
            interval.limitations,
            "This is the gap between two stored message rows, not an instrumented latency.",
          )}
          sublabel={
            interval.state === "unknown"
              ? undefined
              : `${count(interval.value.observations)} ${plural(
                  interval.value.observations,
                  "observation",
                )}${
                  interval.value.p90Ms === null
                    ? ""
                    : ` · p90 ${formatDuration(interval.value.p90Ms)}`
                }`
          }
          value={
            interval.state === "unknown"
              ? undefined
              : (formatDuration(interval.value.medianMs) ?? undefined)
          }
        />
      </div>

      {totalQuestions === null || totalQuestions === 0 ? (
        <EmptyState
          description="No question was recorded in this range, so there is no trend to draw. The chart returns as soon as a learner asks something."
          headline="No volume to chart"
        />
      ) : (
        <div className={styles.charts}>
          <TrendChart
            ariaLabel={`Questions per day across the selected range of ${count(
              overview.range.dayCount,
            )} days`}
            caption="Questions per day"
            points={questionPoints}
          />
          <TrendChart
            ariaLabel={`Active learners per day across the selected range of ${count(
              overview.range.dayCount,
            )} days`}
            caption="Active learners per day"
            points={learnerPoints}
          />
        </div>
      )}

      {channelTotal > 0 && (
        <DistributionBar
          ariaLabel="Questions by channel"
          caption="Voice and text split"
          items={channelItems}
          rank={false}
          total={channelTotal}
        />
      )}

      <Limitations
        items={volume.limitations}
        label="Question volume limitations"
      />
      <Limitations
        items={interval.limitations}
        label="Turn interval limitations"
      />
    </section>
  );
}

// ---------------------------------------------------------- answer quality

function QualitySection({
  quality,
}: {
  readonly quality: AnalyticsAnswerQuality;
}) {
  const coverage = quality.metrics.groundingCoverage;
  const confidence = quality.metrics.retrievalConfidence;
  const gaps = quality.metrics.contentGapSignals;

  const classified =
    coverage.state === "unknown"
      ? 0
      : coverage.value.groundedAnswers + coverage.value.ungroundedAnswers;
  const groundedShare =
    coverage.state === "unknown" || coverage.value.ungroundedShare === null
      ? null
      : 1 - coverage.value.ungroundedShare;

  const sourceItems: DistributionItem[] =
    coverage.state === "unknown"
      ? []
      : coverage.value.sourceCountBuckets.map((bucket) => ({
          id: bucket.label,
          label:
            bucket.label === "0"
              ? "No citation"
              : `${bucket.label} ${plural(bucket.maxSources ?? 6, "citation")}`,
          value: bucket.answers,
          emphasis: bucket.label === "0",
        }));

  const clusters = gaps.state === "unknown" ? [] : gaps.value.clusters;
  const clusterItems: DistributionItem[] = clusters.map((cluster, index) => ({
    id:
      cluster.lessonId ??
      cluster.moduleId ??
      cluster.courseId ??
      `cluster-${index}`,
    label:
      cluster.lessonTitle ??
      cluster.moduleTitle ??
      cluster.courseTitle ??
      "Outside any course",
    value: cluster.ungroundedAnswers,
    sublabel: [
      cluster.courseTitle,
      cluster.moduleTitle,
      `${sharePercent(cluster.ungroundedShare) ?? "—"} of ${count(
        cluster.answers,
      )} ${plural(cluster.answers, "answer")} here`,
    ]
      .filter((part): part is string => part !== null && part !== undefined)
      .join(" · "),
  }));

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Answer quality"
        lede="Grounding coverage is the honest content-gap signal: an ungrounded answer is one where zero citations were attached to the recorded turn."
        state={coverage.state}
        title="Grounding and content gaps"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Coverage"
          label="Grounded answers"
          metricState={coverage.state}
          reason={
            coverage.state === "unknown"
              ? reasonFrom(
                  coverage.limitations,
                  "The platform did not report grounding coverage for this range.",
                )
              : groundedShare === null
                ? "No assistant answer in this range carries a recorded sources array, so there is nothing to divide."
                : `${count(classified)} ${plural(
                    classified,
                    "answer",
                  )} carried a recorded sources array.`
          }
          sublabel={
            coverage.state === "unknown"
              ? undefined
              : `${count(coverage.value.groundedAnswers)} grounded · ${count(
                  coverage.value.ungroundedAnswers,
                )} ungrounded`
          }
          value={sharePercent(groundedShare) ?? undefined}
        />

        <Tile
          eyebrow="Content gap signal"
          label="Ungrounded answers"
          metricState={coverage.state}
          reason={
            coverage.state === "unknown"
              ? reasonFrom(
                  coverage.limitations,
                  "The platform did not report grounding coverage for this range.",
                )
              : "Answers where zero citations were attached to the recorded turn."
          }
          sublabel={
            coverage.state === "unknown"
              ? undefined
              : `${
                  sharePercent(coverage.value.ungroundedShare) ?? "share unknown"
                } of classified answers`
          }
          value={
            coverage.state === "unknown"
              ? undefined
              : count(coverage.value.ungroundedAnswers)
          }
        />

        <Tile
          eyebrow="Citations"
          label="Average sources per answer"
          metricState={coverage.state}
          reason={
            coverage.state === "unknown"
              ? reasonFrom(
                  coverage.limitations,
                  "The platform did not report grounding coverage for this range.",
                )
              : coverage.value.averageSourceCount === null
                ? "No answer in this range carries a recorded sources array to average."
                : "Mean citation count across answers with a recorded sources array."
          }
          value={
            coverage.state === "unknown" ||
            coverage.value.averageSourceCount === null
              ? undefined
              : (Math.round(coverage.value.averageSourceCount * 10) / 10).toLocaleString()
          }
        />

        <Tile
          eyebrow="Not instrumented"
          label="Retrieval confidence"
          metricState="unknown"
          reason={reasonFrom(
            confidence.limitations,
            "No retrieval score is persisted per answer, so no confidence distribution can be aggregated.",
          )}
          value={undefined}
        />
      </div>

      {coverage.state !== "unknown" &&
        coverage.value.answersWithoutSourceRecord > 0 && (
          <Truncation>
            {`${count(
              coverage.value.answersWithoutSourceRecord,
            )} assistant ${plural(
              coverage.value.answersWithoutSourceRecord,
              "answer",
            )} carry no sources array at all and are counted neither as grounded nor as ungrounded, so they are excluded from every share above.`}
          </Truncation>
        )}

      {classified > 0 && (
        <DistributionBar
          ariaLabel="Answers by number of citations"
          caption="Citations per answer"
          items={sourceItems}
          rank={false}
          total={classified}
        />
      )}

      <div className={styles.stackTight}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>Where ungrounded answers cluster</p>
          </div>
          <div className={styles.badges}>
            <StateBadge state={gaps.state} />
          </div>
        </div>
        {clusterItems.length === 0 ? (
          <EmptyState
            compact
            description="No lesson, module or course accumulated an ungrounded answer in this range."
            headline="No content-gap cluster recorded"
          />
        ) : (
          <DistributionBar
            ariaLabel="Ungrounded answers by lesson"
            caption="Ungrounded answers by lesson"
            items={clusterItems}
            total={
              coverage.state === "unknown"
                ? undefined
                : coverage.value.ungroundedAnswers
            }
          />
        )}
        {gaps.state !== "unknown" && gaps.value.omittedClusters > 0 && (
          <Truncation>
            {`This list is truncated: ${count(
              gaps.value.omittedClusters,
            )} further ${plural(
              gaps.value.omittedClusters,
              "cluster",
            )} are not returned; the query caps at the top ${count(
              quality.limits.clusters,
            )} clusters.`}
          </Truncation>
        )}
      </div>

      <Limitations
        items={coverage.limitations}
        label="Grounding coverage limitations"
      />
      <Limitations items={gaps.limitations} label="Content gap limitations" />
    </section>
  );
}

// ------------------------------------------------ labelled questions

const INTENT_LABELS: Record<QuestionIntentName, string> = {
  clarification: "Clarification",
  definition: "Definition",
  how_to: "How to",
  off_topic: "Off topic",
  scope_check: "Scope check",
  troubleshooting: "Troubleshooting",
};

const IMPORTANCE_LABELS: Record<QuestionImportanceName, string> = {
  critical: "Critical",
  notable: "Notable",
  routine: "Routine",
};

const GROUNDING_LABELS: Record<QuestionGroundingOutcome, string> = {
  grounded: "Answered from published material",
  no_answer: "No answer recorded",
  not_recorded: "Citations not recorded",
  ungrounded: "Answered without a citation",
};

function Tag({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone?: "grounded" | "ungrounded" | undefined;
}) {
  return (
    <span
      className={cx(
        styles.tag,
        tone === "grounded" && styles.tagGrounded,
        tone === "ungrounded" && styles.tagUngrounded,
      )}
    >
      {children}
    </span>
  );
}

function groundingTone(
  outcome: QuestionGroundingOutcome,
): "grounded" | "ungrounded" | undefined {
  if (outcome === "grounded") return "grounded";
  if (outcome === "ungrounded") return "ungrounded";
  return undefined;
}

/**
 * Topics, intents and the questions that recurred.
 *
 * The one rule this section exists to keep: a question with no recorded label
 * is shown as unclassified. It is never assigned a plausible topic, and when
 * nothing in the range has been classified the platform returns `unknown` — so
 * this renders the reason instead of an empty chart that would read as "no
 * learner asked anything".
 */
function LabelsSection({
  labels,
}: {
  readonly labels: AnalyticsQuestionLabels;
}) {
  const coverage = labels.metrics.classificationCoverage;
  const topics = labels.metrics.topicDistribution;
  const intents = labels.metrics.intentDistribution;
  const important = labels.metrics.importantQuestions;
  const [showAllTopics, setShowAllTopics] = useState(false);

  const questions = coverage.state === "unknown" ? null : coverage.value.questions;
  const classified =
    coverage.state === "unknown" ? null : coverage.value.classifiedQuestions;
  const unclassified =
    coverage.state === "unknown" ? null : coverage.value.unclassifiedQuestions;

  const topicItems: DistributionItem[] =
    topics.state === "unknown"
      ? []
      : topics.value.topics.map((topic) => ({
          id: topic.topicKey,
          label: topic.topicLabel,
          value: topic.questions,
          sublabel: [
            `${count(topic.learners)} ${plural(topic.learners, "learner")}`,
            topic.ungroundedAnswers > 0
              ? `${count(topic.ungroundedAnswers)} answered without a citation`
              : null,
            formatMoment(topic.lastSeenAt) === null
              ? null
              : `last ${formatMoment(topic.lastSeenAt)}`,
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
        }));

  const intentItems: DistributionItem[] =
    intents.state === "unknown"
      ? []
      : intents.value.intents.map((entry) => ({
          id: entry.intent,
          label: INTENT_LABELS[entry.intent] ?? entry.intent,
          value: entry.questions,
          sublabel:
            entry.questions === 0
              ? "None recorded in this range"
              : `${count(entry.learners)} ${plural(entry.learners, "learner")}`,
        }));

  const importantQuestions =
    important.state === "unknown" ? [] : important.value.questions;

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Question labels"
        lede="Every classified question carries a topic, an intent and a priority produced after the answer was recorded. A question the classifier did not label is reported as unclassified — it is never placed in a topic to make the chart look complete."
        state={topics.state}
        title="Topics, intents and the questions worth reading"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Coverage"
          label="Classified questions"
          metricState={coverage.state}
          reason={
            coverage.state === "unknown"
              ? reasonFrom(
                  coverage.limitations,
                  "The platform did not report classification coverage for this range.",
                )
              : "Questions with a label row written by the answer path."
          }
          sublabel={
            classified === null || questions === null
              ? undefined
              : `${count(classified)} of ${count(questions)} ${plural(
                  questions,
                  "question",
                )}`
          }
          value={
            coverage.state === "unknown"
              ? undefined
              : (sharePercent(coverage.value.coverageShare) ?? undefined)
          }
        />
        <Tile
          eyebrow="Never bucketed"
          label="Unclassified questions"
          metricState={coverage.state}
          reason="Recorded questions with no label. They are counted in the totals and excluded from every topic and intent below."
          value={unclassified === null ? undefined : count(unclassified)}
        />
        <Tile
          eyebrow="Themes"
          label="Topics found"
          metricState={topics.state}
          reason={
            topics.state === "unknown"
              ? reasonFrom(
                  topics.limitations,
                  "No question in this range carries a recorded classification.",
                )
              : "Distinct classifier-produced topics across the classified questions."
          }
          value={
            topics.state === "unknown"
              ? undefined
              : count(topics.value.topics.length)
          }
        />
        <Tile
          eyebrow="Last label"
          label="Classified through"
          metricState={coverage.state}
          reason={
            coverage.state === "unknown"
              ? reasonFrom(
                  coverage.limitations,
                  "The platform did not report classification coverage for this range.",
                )
              : coverage.value.lastClassifiedAt === null
                ? "No question in this range has been classified yet."
                : "The most recent moment a label was written."
          }
          value={
            coverage.state === "unknown"
              ? undefined
              : (formatMoment(coverage.value.lastClassifiedAt) ?? undefined)
          }
        />
      </div>

      {topics.state === "unknown" ? (
        <EmptyState
          description={reasonFrom(
            topics.limitations,
            "No question in this range carries a recorded classification, so there is no topic or intent distribution to draw. Nothing is substituted for it.",
          )}
          headline="Nothing in this range has been classified"
          tone="neutral"
        />
      ) : (
        <div className={styles.stack}>
          {topicItems.length === 0 ? (
            <EmptyState
              compact
              description="No learner question was recorded in this range, so there is no topic to rank."
              headline="No questions to label"
            />
          ) : (
            <DistributionBar
              ariaLabel="Classified questions by topic, share of all questions in range"
              caption="Questions by topic"
              items={topicItems}
              maxItems={showAllTopics ? undefined : 8}
              total={questions ?? undefined}
            />
          )}

          {topicItems.length > 8 && (
            <div className={styles.actions}>
              <Button
                onClick={() => setShowAllTopics((current) => !current)}
                size="sm"
              >
                {showAllTopics
                  ? "Show top 8 topics"
                  : `Show all ${count(topicItems.length)} topics`}
              </Button>
            </div>
          )}

          {topics.value.unclassified.questions > 0 && (
            <p className={styles.unattributed}>
              <span>
                <strong>Unclassified</strong> ·{" "}
                {count(topics.value.unclassified.questions)}{" "}
                {plural(topics.value.unclassified.questions, "question")} carry
                no recorded label. They are excluded from every topic and
                intent above rather than assigned to a plausible one.
              </span>
              <strong>
                {sharePercent(topics.value.unclassified.share) ?? "—"}
              </strong>
            </p>
          )}

          {topics.value.omittedTopics > 0 && (
            <Truncation>
              {`This list is truncated: ${count(
                topics.value.omittedTopics,
              )} further ${plural(
                topics.value.omittedTopics,
                "topic",
              )} holding ${count(
                topics.value.omittedTopicQuestions,
              )} classified ${plural(
                topics.value.omittedTopicQuestions,
                "question",
              )} are not returned; the query caps at the top ${count(
                labels.limits.topics,
              )} topics by volume.`}
            </Truncation>
          )}

          <div className={styles.stackTight}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionHeading}>
                <p className={styles.eyebrow}>What learners are asking for</p>
              </div>
              <div className={styles.badges}>
                <StateBadge state={intents.state} />
              </div>
            </div>
            <DistributionBar
              ariaLabel="Classified questions by intent"
              caption="Questions by intent"
              items={intentItems}
              rank={false}
              total={questions ?? undefined}
            />
          </div>
        </div>
      )}

      <div className={styles.stackTight}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>Important questions</p>
          </div>
          <div className={styles.badges}>
            <StateBadge state={important.state} />
          </div>
        </div>

        {important.state === "unknown" ? (
          <EmptyState
            compact
            description={reasonFrom(
              important.limitations,
              "No question in this range carries a recorded classification, so none can be ranked by importance.",
            )}
            headline="No classified question to rank"
          />
        ) : importantQuestions.length === 0 ? (
          <EmptyState
            compact
            description="No classified question was recorded in this range."
            headline="Nothing to show yet"
          />
        ) : (
          <ul className={styles.questionList}>
            {importantQuestions.map((entry) => (
              <li className={styles.questionItem} key={entry.messageId}>
                <p className={styles.questionText}>
                  “{entry.question}
                  {entry.truncatedQuestion ? "…" : ""}”
                </p>
                <div className={styles.tagRow}>
                  <Tag>{entry.topicLabel}</Tag>
                  <Tag>{INTENT_LABELS[entry.intent] ?? entry.intent}</Tag>
                  <Tag>
                    {IMPORTANCE_LABELS[entry.importance] ?? entry.importance}
                  </Tag>
                  <Tag tone={groundingTone(entry.groundingOutcome)}>
                    {GROUNDING_LABELS[entry.groundingOutcome]}
                  </Tag>
                </div>
                <Facts
                  items={[
                    {
                      label: "Asked in this shape",
                      value: `${count(entry.recurrence)} ${plural(
                        entry.recurrence,
                        "time",
                      )} · ${count(entry.recurrenceLearners)} ${plural(
                        entry.recurrenceLearners,
                        "learner",
                      )}`,
                    },
                    {
                      label: "Lesson",
                      value:
                        entry.lessonTitle ??
                        entry.courseTitle ??
                        "no course context",
                    },
                    {
                      label: "Asked",
                      value: formatMoment(entry.askedAt) ?? "not recorded",
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}

        {important.state !== "unknown" &&
          important.value.omittedQuestions > 0 && (
            <Truncation>
              {`This list is truncated: ${count(
                important.value.omittedQuestions,
              )} further classified ${plural(
                important.value.omittedQuestions,
                "question",
              )} are not returned; the query caps at the top ${count(
                labels.limits.importantQuestions,
              )} by importance and recurrence.`}
            </Truncation>
          )}
      </div>

      <Limitations
        items={coverage.limitations}
        label="Classification coverage limitations"
      />
      <Limitations items={topics.limitations} label="Topic limitations" />
      <Limitations
        items={important.limitations}
        label="Important question limitations"
      />
    </section>
  );
}


// ------------------------------------------------------- surface breakdown

const SURFACE_LABELS: Record<AnalyticsSurfaceName, string> = {
  api: "API",
  console: "Console",
  widget: "Embedded widget",
};

function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface as AnalyticsSurfaceName] ?? surface;
}

/**
 * Console versus widget, and who was asking.
 *
 * The two "people" figures on this surface are deliberately never added
 * together. A verified learner is someone the platform authenticated. An
 * anonymous visitor is a pseudonymous key derived from the widget's own
 * conversation reference — a returning browser, not a person, and not
 * resolvable to one. They are rendered as separate rows for exactly that
 * reason.
 */
function SurfaceSection({ widget }: { readonly widget: AnalyticsWidgetSnapshot }) {
  const volume = widget.breakdown.metrics.surfaceVolume;
  const provenance = widget.breakdown.surface;
  const attributionStarted = formatMoment(provenance.attributionStartedAt);

  if (volume.state === "unknown") {
    return (
      <section className={styles.section}>
        <SectionHead
          eyebrow="Where questions arrive"
          lede="Every question is attributed to the surface its conversation was opened on."
          state="unknown"
          title="Console and widget"
        />
        <EmptyState
          description={reasonFrom(
            volume.limitations,
            "The platform did not report a surface split for this range.",
          )}
          headline="Surface attribution does not cover this range"
          tone="neutral"
        />
        <Limitations
          items={volume.limitations}
          label="Surface attribution limitations"
        />
      </section>
    );
  }

  const rows = volume.value.surfaces;
  const widgetRow = rows.find((row) => row.surface === "widget") ?? null;
  const total = volume.value.totalQuestions;

  const surfaceItems: DistributionItem[] = rows.map((row) => ({
    id: row.surface,
    label: surfaceLabel(row.surface),
    value: row.questions,
    sublabel: [
      `${count(row.conversations)} ${plural(row.conversations, "conversation")}`,
      row.verifiedLearners > 0
        ? `${count(row.verifiedLearners)} verified ${plural(
            row.verifiedLearners,
            "learner",
          )}`
        : null,
      row.anonymousVisitors > 0
        ? `${count(row.anonymousVisitors)} anonymous ${plural(
            row.anonymousVisitors,
            "visitor",
          )}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    emphasis: row.surface === "widget",
  }));

  // A day past the measured window is a gap, never a zero.
  const dataThroughMs = parseMs(volume.dataThrough);
  const observed = (bucketStart: string) => {
    const startMs = parseMs(bucketStart);
    if (startMs === null) return false;
    return dataThroughMs === null || startMs <= dataThroughMs;
  };
  const pointsFor = (surface: AnalyticsSurfaceName): TrendPoint[] =>
    volume.value.buckets.map((bucket) => ({
      label: formatDay(bucket.bucketStart) ?? bucket.bucketStart,
      value: observed(bucket.bucketStart)
        ? (bucket.surfaces[surface]?.questions ?? 0)
        : null,
    }));
  const widgetPoints = pointsFor("widget");
  const consolePoints = pointsFor("console");

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Where questions arrive"
        lede="Every question is attributed to the surface its conversation was opened on: the signed-in console, the embedded widget, or the API."
        state={volume.state}
        title="Console and widget"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Range total"
          label="Widget questions"
          metricState={volume.state}
          reason={
            widgetRow === null
              ? "No question in this range was attributed to the embedded widget."
              : "Questions asked in a conversation the widget opened."
          }
          sublabel={
            widgetRow === null
              ? undefined
              : `${count(widgetRow.conversations)} ${plural(
                  widgetRow.conversations,
                  "conversation",
                )} · ${sharePercent(
                  total === 0 ? null : widgetRow.questions / total,
                ) ?? "share unknown"} of all questions`
          }
          value={count(widgetRow?.questions ?? 0)}
        />
        <Tile
          eyebrow="Widget · not verified"
          label="Anonymous visitors"
          metricState={volume.state}
          reason="Distinct pseudonymous widget references. This counts returning browsers, not people, and is never added to the verified-learner figure."
          sublabel={
            widgetRow === null
              ? undefined
              : `${count(widgetRow.anonymousQuestions)} ${plural(
                  widgetRow.anonymousQuestions,
                  "question",
                )} from visitors who were never signed in`
          }
          value={count(widgetRow?.anonymousVisitors ?? 0)}
        />
        <Tile
          eyebrow="Widget · authenticated"
          label="Verified learners"
          metricState={volume.state}
          reason="Distinct conversation subjects the platform authenticated. A separate count from anonymous visitors on purpose."
          value={count(widgetRow?.verifiedLearners ?? 0)}
        />
        <Tile
          eyebrow="Provenance"
          label="Recorded attribution"
          metricState={volume.state}
          reason={
            attributionStarted === null
              ? "Surfaces are recorded per conversation when it is opened."
              : `Surfaces have been recorded since ${attributionStarted}. Earlier conversations are attributed to the console because the console was the only surface that existed, not because one was observed.`
          }
          sublabel={`${count(volume.value.inferredAttributions)} inferred`}
          value={count(volume.value.recordedAttributions)}
        />
      </div>

      {total === 0 ? (
        <EmptyState
          description="No question was recorded on any surface in this range."
          headline="Nothing to split"
        />
      ) : (
        <div className={styles.stack}>
          <DistributionBar
            ariaLabel="Questions by surface, share of all questions in range"
            caption="Questions by surface"
            items={surfaceItems}
            rank={false}
            total={total}
          />
          <div className={styles.charts}>
            <TrendChart
              ariaLabel={`Widget questions per day across the selected range of ${count(
                widget.breakdown.range.dayCount,
              )} days`}
              caption="Widget questions per day"
              points={widgetPoints}
            />
            <TrendChart
              ariaLabel={`Console questions per day across the selected range of ${count(
                widget.breakdown.range.dayCount,
              )} days`}
              caption="Console questions per day"
              points={consolePoints}
            />
          </div>
        </div>
      )}

      {provenance.coverage !== "full" && (
        <p className={styles.surfaceNote}>{provenance.coverageNote}</p>
      )}

      <Limitations
        items={volume.limitations}
        label="Surface attribution limitations"
      />
    </section>
  );
}

// ------------------------------------------------------- widget engagement

/**
 * What the embedded widget is actually doing on the client's own pages.
 *
 * The deflection list is the actionable half: widget questions whose recorded
 * answer carried no citation, that were never answered, or that had no course
 * context to answer from. It states what the platform failed to ground — never
 * what the visitor wanted, which nothing here records.
 */
function WidgetSection({ widget }: { readonly widget: AnalyticsWidgetSnapshot }) {
  const engagement = widget.engagement.metrics.widgetEngagement;
  const hostPages = widget.engagement.metrics.hostPageQuestions;
  const grounding = widget.contentGaps.metrics.widgetGroundingCoverage;
  const deflections = widget.contentGaps.metrics.widgetDeflections;
  const [showAllPages, setShowAllPages] = useState(false);

  if (engagement.state === "unknown") {
    return (
      <section className={styles.section}>
        <SectionHead
          eyebrow="Embedded widget"
          lede="Conversations the widget opened on the client's own pages."
          state="unknown"
          title="Widget engagement"
        />
        <EmptyState
          description={reasonFrom(
            engagement.limitations,
            "The platform did not report widget engagement for this range.",
          )}
          headline="Widget activity is not measured for this range"
          tone="neutral"
        />
        <Limitations
          items={engagement.limitations}
          label="Widget engagement limitations"
        />
      </section>
    );
  }

  const value = engagement.value;
  const pages = hostPages.state === "unknown" ? [] : hostPages.value.pages;
  const clusters =
    deflections.state === "unknown" ? [] : deflections.value.clusters;
  // Taken from the RPC, where questions and conversations share one range.
  // Dividing questions-in-range by conversations-started-in-range in the
  // browser would mix two different denominators.
  const surfaceRow =
    widget.breakdown.metrics.surfaceVolume.state === "unknown"
      ? null
      : (widget.breakdown.metrics.surfaceVolume.value.surfaces.find(
          (row) => row.surface === "widget",
        ) ?? null);
  const questionsPerConversation =
    surfaceRow?.questionsPerConversation ?? null;
  const groundedShare =
    grounding.state === "unknown" || grounding.value.ungroundedShare === null
      ? null
      : 1 - grounding.value.ungroundedShare;

  const pageItems: DistributionItem[] = pages.map((page) => ({
    id: `${page.hostOrigin}${page.hostPath}`,
    label: page.hostPageTitle ?? page.hostPath,
    value: page.questions,
    sublabel: [
      `${page.hostOrigin}${page.hostPath}`,
      `${count(page.conversations)} ${plural(page.conversations, "conversation")}`,
      page.anonymousVisitors > 0
        ? `${count(page.anonymousVisitors)} anonymous ${plural(
            page.anonymousVisitors,
            "visitor",
          )}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  }));

  const originItems: DistributionItem[] = value.origins.map((origin) => ({
    id: origin.hostOrigin,
    label: origin.hostOrigin,
    value: origin.questions,
    sublabel: `${count(origin.pages)} ${plural(origin.pages, "page")} · ${count(
      origin.conversations,
    )} ${plural(origin.conversations, "conversation")}`,
  }));

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Embedded widget"
        lede="Conversations the widget opened on the client's own pages, and the questions those pages generated. Only the origin and path of a host page are recorded — the query string is discarded before storage."
        state={engagement.state}
        title="Widget engagement and deflections"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Range total"
          label="Conversations started"
          metricState={engagement.state}
          reason="Widget conversations opened inside this range."
          sublabel={`${count(value.verifiedConversations)} signed in · ${count(
            value.anonymousConversations,
          )} anonymous`}
          value={count(value.conversationsStarted)}
        />
        <Tile
          eyebrow="Depth"
          label="Questions per conversation"
          metricState={hostPages.state}
          reason={
            questionsPerConversation === null
              ? "No widget conversation carried a question in this range, so there is nothing to divide."
              : "Widget questions in this range divided by the widget conversations that carried them."
          }
          value={
            questionsPerConversation === null
              ? undefined
              : (Math.round(questionsPerConversation * 10) / 10).toLocaleString()
          }
        />
        <Tile
          eyebrow="Reach"
          label="Host origins"
          metricState={engagement.state}
          reason="Distinct sites the widget answered questions on."
          sublabel={
            value.conversationsWithoutOrigin > 0
              ? `${count(value.conversationsWithoutOrigin)} ${plural(
                  value.conversationsWithoutOrigin,
                  "conversation",
                )} with no recorded origin`
              : undefined
          }
          value={count(value.hostOrigins)}
        />
        <Tile
          eyebrow="Coverage"
          label="Grounded widget answers"
          metricState={grounding.state}
          reason={
            grounding.state === "unknown"
              ? reasonFrom(
                  grounding.limitations,
                  "The platform did not report widget grounding for this range.",
                )
              : groundedShare === null
                ? "No widget answer in this range carries a recorded sources array, so there is nothing to divide."
                : `${count(grounding.value.answers)} widget ${plural(
                    grounding.value.answers,
                    "answer",
                  )} recorded.`
          }
          sublabel={
            grounding.state === "unknown"
              ? undefined
              : `${count(grounding.value.ungroundedAnswers)} answered without a citation`
          }
          value={sharePercent(groundedShare) ?? undefined}
        />
      </div>

      {originItems.length > 0 && (
        <DistributionBar
          ariaLabel="Widget questions by host origin"
          caption="Questions by site"
          items={originItems}
          rank={false}
          total={originItems.reduce((running, item) => running + item.value, 0)}
        />
      )}

      <div className={styles.stackTight}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>Host pages driving questions</p>
          </div>
          <div className={styles.badges}>
            <StateBadge state={hostPages.state} />
          </div>
        </div>
        {pageItems.length === 0 ? (
          <EmptyState
            compact
            description="No host page recorded a widget question in this range."
            headline="No host page activity"
          />
        ) : (
          <DistributionBar
            ariaLabel="Widget questions by host page"
            caption="Questions by host page"
            items={pageItems}
            maxItems={showAllPages ? undefined : 8}
            total={pageItems.reduce((running, item) => running + item.value, 0)}
          />
        )}
        {pageItems.length > 8 && (
          <div className={styles.actions}>
            <Button onClick={() => setShowAllPages((current) => !current)} size="sm">
              {showAllPages
                ? "Show top 8 pages"
                : `Show all ${count(pageItems.length)} pages`}
            </Button>
          </div>
        )}
        {hostPages.state !== "unknown" && hostPages.value.omittedPages > 0 && (
          <Truncation>
            {`This list is truncated: ${count(
              hostPages.value.omittedPages,
            )} further ${plural(
              hostPages.value.omittedPages,
              "page",
            )} are not returned; the query caps at the top ${count(
              widget.engagement.limits.hostPages,
            )} pages by volume.`}
          </Truncation>
        )}
      </div>

      <div className={styles.stackTight}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>
              What the widget could not answer — write this next
            </p>
          </div>
          <div className={styles.badges}>
            <StateBadge state={deflections.state} />
          </div>
        </div>

        {deflections.state === "unknown" ? (
          <EmptyState
            compact
            description={reasonFrom(
              deflections.limitations,
              "The platform did not report widget deflections for this range.",
            )}
            headline="Deflections are not measured for this range"
          />
        ) : clusters.length === 0 ? (
          <EmptyState
            compact
            description="Every widget question in this range was answered from published material with at least one citation."
            headline="No deflection recorded"
          />
        ) : (
          <ul className={styles.deflectionList}>
            {clusters.map((cluster) => (
              <li
                className={styles.deflectionItem}
                key={`${cluster.hostOrigin}${cluster.hostPath}:${
                  cluster.lessonId ?? cluster.courseId ?? "none"
                }`}
              >
                <p className={styles.deflectionTitle}>
                  {cluster.hostPageTitle ?? cluster.hostPath}
                </p>
                <p className={styles.deflectionPath}>
                  {cluster.hostOrigin}
                  {cluster.hostPath}
                </p>
                <div className={styles.tagRow}>
                  {cluster.ungroundedQuestions > 0 && (
                    <Tag tone="ungrounded">
                      {`${count(cluster.ungroundedQuestions)} answered without a citation`}
                    </Tag>
                  )}
                  {cluster.unansweredQuestions > 0 && (
                    <Tag>
                      {`${count(cluster.unansweredQuestions)} with no recorded answer`}
                    </Tag>
                  )}
                  {cluster.unattributedQuestions > 0 && (
                    <Tag>
                      {`${count(cluster.unattributedQuestions)} with no course context`}
                    </Tag>
                  )}
                </div>
                <Facts
                  items={[
                    {
                      label: "Questions here",
                      value: `${count(cluster.questions)} · ${
                        sharePercent(cluster.deflectionShare) ?? "share unknown"
                      } deflected`,
                    },
                    {
                      label: "Lesson",
                      value:
                        cluster.lessonTitle ??
                        cluster.courseTitle ??
                        "no course context",
                    },
                    {
                      label: "Who asked",
                      value: `${count(
                        cluster.anonymousVisitors,
                      )} anonymous · ${count(cluster.verifiedLearners)} verified`,
                    },
                    {
                      label: "Last seen",
                      value:
                        formatMoment(cluster.lastDeflectedAt) ?? "not recorded",
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}

        {deflections.state !== "unknown" &&
          deflections.value.omittedClusters > 0 && (
            <Truncation>
              {`This list is truncated: ${count(
                deflections.value.omittedClusters,
              )} further ${plural(
                deflections.value.omittedClusters,
                "cluster",
              )} are not returned; the query caps at the top ${count(
                widget.contentGaps.limits.clusters,
              )} clusters.`}
            </Truncation>
          )}
      </div>

      <Limitations
        items={engagement.limitations}
        label="Widget engagement limitations"
      />
      <Limitations
        items={grounding.limitations}
        label="Widget grounding limitations"
      />
      <Limitations
        items={deflections.limitations}
        label="Widget deflection limitations"
      />
    </section>
  );
}

// ------------------------------------------------------------------ signals

const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  content_gap: "Content gap",
  post_lesson_stall: "Stall after a lesson",
  repeated_question_cluster: "Repeated questions",
  topic_spike: "Topic spike",
  unattributed_questions: "No course context",
  widget_anonymous_spike: "Anonymous widget spike",
  widget_page_ungrounded: "Widget page without answers",
  widget_unpublished_content: "Widget on unpublished content",
};

const REVIEW_STATUS_LABELS: Record<string, string> = {
  acknowledged: "Acknowledged",
  actioned: "Actioned",
  dismissed: "Dismissed",
  new: "Not reviewed",
};

const NEXT_REVIEW_ACTIONS: Record<string, readonly SignalReviewAction[]> = {
  acknowledged: ["actioned", "dismissed"],
  actioned: ["dismissed"],
  dismissed: [],
  new: ["acknowledged", "actioned", "dismissed"],
};

const REVIEW_ACTION_LABELS: Record<SignalReviewAction, string> = {
  acknowledged: "Acknowledge",
  actioned: "Mark actioned",
  dismissed: "Dismiss",
};

/** Renders the recorded evidence as plain label/value facts, never a summary. */
function evidenceFacts(
  evidence: Record<string, unknown>,
): { label: string; value: string }[] {
  const readable: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null || value === undefined || typeof value === "object") {
      continue;
    }
    if (key.endsWith("Id")) continue;
    const label = key
      .replace(/([A-Z])/gu, " $1")
      .replace(/^./u, (character) => character.toUpperCase());
    const text =
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value)
        ? (formatMoment(value) ?? value)
        : String(value);
    readable.push({ label, value: text });
    if (readable.length >= 6) break;
  }
  return readable;
}

function SignalCard({
  signal,
  onReview,
  busy,
}: {
  readonly signal: DetectedSignal;
  readonly onReview: (
    signal: DetectedSignal,
    action: SignalReviewAction,
  ) => void;
  readonly busy: boolean;
}) {
  const status = signal.review.status;
  const actions = NEXT_REVIEW_ACTIONS[status] ?? [];
  return (
    <li
      className={cx(
        styles.signalItem,
        signal.severity === "critical" && styles.signalCritical,
        signal.severity === "elevated" && styles.signalElevated,
        signal.severity === "watch" && styles.signalWatch,
        status !== "new" && styles.signalReviewed,
      )}
    >
      <div className={styles.signalHead}>
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>
            {SIGNAL_KIND_LABELS[signal.kind] ?? signal.kind} ·{" "}
            {signal.severity}
          </p>
          <h4 className={styles.signalHeadline}>{signal.headline}</h4>
        </div>
        <div className={styles.badges}>
          <StateBadge state={status === "new" ? "partial" : "known"}>
            {REVIEW_STATUS_LABELS[status] ?? status}
          </StateBadge>
        </div>
      </div>

      <p className={styles.signalDetail}>{signal.detail}</p>

      <Facts items={evidenceFacts(signal.evidence)} />

      {signal.review.note !== null && (
        <p className={styles.signalDetail}>
          <strong>Review note.</strong> {signal.review.note}
          {signal.review.reviewedAt === null
            ? ""
            : ` · ${formatMoment(signal.review.reviewedAt) ?? ""}`}
        </p>
      )}

      <ul aria-label="Evidence this signal was read from" className={styles.evidenceRefs}>
        {signal.evidenceRefs.slice(0, 8).map((reference) => (
          <li className={styles.evidenceRef} key={reference}>
            {reference}
          </li>
        ))}
      </ul>

      {actions.length === 0 ? (
        <p className={styles.signalDetail}>
          This signal was dismissed. The lifecycle is forward-only, so it cannot
          be reopened from here.
        </p>
      ) : (
        <div className={styles.signalActions}>
          {actions.map((action) => (
            <Button
              key={action}
              loading={busy}
              onClick={() => onReview(signal, action)}
              size="sm"
              variant={action === "dismissed" ? "ghost" : "secondary"}
            >
              {REVIEW_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Detected signals, severity first.
 *
 * Each card states the threshold comparison that produced it and lists the
 * tables and rows it was read from. The kinds the platform cannot detect at
 * all are printed underneath rather than left as a silence.
 */
function SignalsSection({
  signals,
  onReview,
  reviewing,
  reviewError,
}: {
  readonly signals: AnalyticsSignals;
  readonly onReview: (
    signal: DetectedSignal,
    action: SignalReviewAction,
  ) => void;
  readonly reviewing: string | null;
  readonly reviewError: string | null;
}) {
  const detected = signals.metrics.detectedSignals;
  const undetectable = signals.metrics.undetectableSignals;
  const rows = detected.state === "unknown" ? [] : detected.value.signals;
  const bySeverity =
    detected.state === "unknown" ? null : detected.value.bySeverity;

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Signals"
        lede="Threshold comparisons over recorded rows, ordered by severity. A signal says what was counted and shows the evidence; it never explains why, and it never acts on its own."
        state={detected.state}
        title="Signals worth acting on"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Detected"
          label="Open signals"
          metricState={detected.state}
          reason="Signals produced by the deterministic detectors for this range."
          sublabel={
            bySeverity === null
              ? undefined
              : `${count(bySeverity.critical)} critical · ${count(
                  bySeverity.elevated,
                )} elevated · ${count(bySeverity.watch)} watch`
          }
          value={
            detected.state === "unknown"
              ? undefined
              : count(detected.value.detectedSignals)
          }
        />
        <Tile
          eyebrow="Classifier input"
          label="Classified questions in range"
          metricState={detected.state}
          reason="The topic-spike detector needs labels. The other detectors read messages and progress rows and run regardless."
          value={
            detected.state === "unknown"
              ? undefined
              : count(detected.value.classifiedQuestionsInRange)
          }
        />
        <Tile
          eyebrow="Not detectable"
          label="Sentiment and correctness"
          metricState="unknown"
          reason={reasonFrom(
            undetectable.limitations,
            "Several signal kinds have no recorded input at all and are not approximated.",
          )}
          value={undefined}
        />
      </div>

      {reviewError !== null && (
        <Truncation>{reviewError}</Truncation>
      )}

      {rows.length === 0 ? (
        <EmptyState
          description="No detector crossed its threshold in this range. That is a real absence of signals, not a missing measurement — the thresholds are listed below."
          headline="No signal detected"
        />
      ) : (
        <ul className={styles.signalList}>
          {rows.map((signal) => (
            <SignalCard
              busy={reviewing === signal.signalFingerprint}
              key={signal.signalFingerprint}
              onReview={onReview}
              signal={signal}
            />
          ))}
        </ul>
      )}

      {detected.state !== "unknown" && detected.value.omittedSignals > 0 && (
        <Truncation>
          {`This list is truncated: ${count(
            detected.value.omittedSignals,
          )} further ${plural(
            detected.value.omittedSignals,
            "signal",
          )} are not returned; the query caps at the top ${count(
            signals.limits.signals,
          )} by severity.`}
        </Truncation>
      )}

      <Limitations items={detected.limitations} label="Signal limitations" />
      <Limitations
        items={undetectable.limitations}
        label="Signals this platform cannot detect"
      />
    </section>
  );
}

// -------------------------------------------------------- learner signals

const ESCALATION_LABELS: Record<EscalationState, string> = {
  declining: "Declining",
  escalating: "Escalating",
  insufficient_data: "Not enough data yet",
  steady: "Steady",
};

const ESCALATION_BADGE_STATE: Record<
  EscalationState,
  AnalyticsMetric<unknown>["state"]
> = {
  declining: "partial",
  escalating: "known",
  insufficient_data: "unknown",
  steady: "partial",
};

const READINESS_LABELS: Record<ReadinessTier, string> = {
  insufficient_data: "Not enough data yet",
  likely_ready: "Looks ready for a next offer",
  not_yet: "Not yet",
  possible: "Possible",
};

const READINESS_BADGE_STATE: Record<
  ReadinessTier,
  AnalyticsMetric<unknown>["state"]
> = {
  insufficient_data: "unknown",
  likely_ready: "known",
  not_yet: "partial",
  possible: "partial",
};

function learnerLabel(row: LearnerSignalRow): string {
  if (row.displayName !== null && row.displayName.trim() !== "") {
    return row.displayName;
  }
  return `Learner ${row.subjectUserId.slice(0, 8)}`;
}

function StuckClusterList({
  clusters,
}: {
  readonly clusters: readonly StuckCluster[];
}) {
  if (clusters.length === 0) return null;
  return (
    <ul className={learnerStyles.stuckList}>
      {clusters.map((cluster) => (
        <li
          className={learnerStyles.stuckItem}
          key={`${cluster.lessonId ?? "none"}:${cluster.topicKey}`}
        >
          <span className={learnerStyles.stuckLesson}>
            {cluster.lessonTitle ?? cluster.courseTitle ?? "No course context"}
          </span>
          <span className={learnerStyles.stuckDetail}>
            {`"${cluster.topicLabel}" asked ${count(cluster.repeats)} times · last ${
              formatMoment(cluster.lastAskedAt) ?? "not recorded"
            }`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LearnerRow({ row }: { readonly row: LearnerSignalRow }) {
  const depthShare = sharePercent(row.depth.notableOrCriticalShare);
  return (
    <li className={cx(styles.questionItem, learnerStyles.learnerItem)}>
      <div className={learnerStyles.learnerHead}>
        <p className={styles.questionText}>{learnerLabel(row)}</p>
        <span className={learnerStyles.learnerMeta}>
          {`${count(row.questions)} ${plural(row.questions, "question")} · last ${
            formatMoment(row.lastAskedAt) ?? "not recorded"
          }`}
        </span>
      </div>

      <div className={styles.tagRow}>
        <StateBadge state={depthShare === null ? "unknown" : "known"}>
          {depthShare === null
            ? "Depth: not enough data"
            : `Depth: ${depthShare} notable/critical`}
        </StateBadge>
        <StateBadge state={ESCALATION_BADGE_STATE[row.escalation.state]}>
          {ESCALATION_LABELS[row.escalation.state]}
        </StateBadge>
        {row.stuck.clusterCount > 0 && (
          <StateBadge state="partial">
            {`Stuck on ${count(row.stuck.clusterCount)} ${plural(
              row.stuck.clusterCount,
              "lesson",
            )}`}
          </StateBadge>
        )}
        <StateBadge state={READINESS_BADGE_STATE[row.readiness.tier]}>
          {READINESS_LABELS[row.readiness.tier]}
        </StateBadge>
      </div>

      <Facts
        items={[
          { label: "Topics", value: count(row.distinctTopics) },
          { label: "Lessons", value: count(row.distinctLessons) },
          {
            label: "Notable or critical",
            value: `${count(row.notableOrCriticalQuestions)} of ${count(
              row.questions,
            )}`,
          },
          {
            label: "Escalation basis",
            value:
              row.escalation.state === "insufficient_data"
                ? `${count(row.escalation.sampleSize)} ranked question(s) so far`
                : `${row.escalation.firstHalfAvgSpecificity ?? "—"} → ${
                    row.escalation.secondHalfAvgSpecificity ?? "—"
                  } avg specificity`,
          },
          {
            label: "Readiness basis",
            value: [
              row.readiness.evidence.hasCompletedCourse
                ? "completed a course"
                : row.readiness.evidence.maxPercentComplete === null
                  ? "no recorded course progress"
                  : `${Math.round(
                      row.readiness.evidence.maxPercentComplete,
                    )}% through a course`,
              `${count(row.readiness.evidence.notableOrCriticalQuestions)} notable/critical`,
            ].join(" · "),
          },
        ]}
      />

      <StuckClusterList clusters={row.stuck.clusters} />
    </li>
  );
}

/**
 * Per-learner signals: depth, escalating specificity, stuck lessons and
 * next-offer readiness.
 *
 * Depth and stuck counts are direct aggregates over recorded rows. Escalation
 * and readiness are explicitly labelled heuristics: a learner with too few
 * classified questions to compute a trend, or no recorded course-progress row
 * at all, is shown as "not enough data" rather than assigned a guessed
 * direction or tier.
 */
function LearnerSignalsSection({
  learnerSignals,
}: {
  readonly learnerSignals: AnalyticsLearnerSignals;
}) {
  const coverage = learnerSignals.metrics.learnerCoverage;
  const rows = learnerSignals.metrics.learnerRows;
  const learners = rows.state === "unknown" ? [] : rows.value.learners;

  const escalatingCount = learners.filter(
    (row) => row.escalation.state === "escalating",
  ).length;
  const stuckCount = learners.filter(
    (row) => row.stuck.clusterCount > 0,
  ).length;
  const readyCount = learners.filter(
    (row) => row.readiness.tier === "likely_ready",
  ).length;

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Learner signals"
        lede="Depth and stuck lessons are direct counts over classified questions. Escalation and readiness are explicitly labelled heuristics, ranked so the learners most worth a look come first — never a certainty and never rounded into a false precision."
        state={coverage.state}
        title="Who is worth your attention"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Coverage"
          label="Learners with a classified question"
          metricState={coverage.state}
          reason={
            coverage.state === "unknown"
              ? reasonFrom(
                  coverage.limitations,
                  "The platform did not report learner coverage for this range.",
                )
              : `${count(coverage.value.classifiedQuestions)} of ${count(
                  coverage.value.questions,
                )} questions carry a recorded label.`
          }
          value={
            coverage.state === "unknown"
              ? undefined
              : count(coverage.value.classifiedLearners)
          }
        />
        <Tile
          eyebrow="Escalating"
          label="Trending toward applied questions"
          metricState={rows.state}
          reason="Learners whose second half of classified questions in range ranks more specific, on average, than their first half. Requires at least a handful of classified questions; a thin history is excluded, never guessed."
          value={rows.state === "unknown" ? undefined : count(escalatingCount)}
        />
        <Tile
          eyebrow="Repeated on one lesson"
          label="Stuck"
          metricState={rows.state}
          reason={`The same topic asked ${count(
            learnerSignals.thresholds.stuckRepeatThreshold,
          )} or more times within one lesson in this range — a direct count, not an inference about confusion.`}
          value={rows.state === "unknown" ? undefined : count(stuckCount)}
        />
        <Tile
          eyebrow="Heuristic"
          label="Looks ready for a next offer"
          metricState={rows.state}
          reason="Course completion combined with recent notable or critical questions. A prioritised list to review, never a certainty — and never shown for a learner with no recorded course-progress row."
          value={rows.state === "unknown" ? undefined : count(readyCount)}
        />
      </div>

      {rows.state === "unknown" ? (
        <EmptyState
          description={reasonFrom(
            rows.limitations,
            "No question in this range carries a recorded classification, so no learner can be profiled. Nothing is substituted for it.",
          )}
          headline="Nothing to profile yet"
          tone="neutral"
        />
      ) : learners.length === 0 ? (
        <EmptyState
          description="No learner in this range has a classified question, so there is no row to show."
          headline="No learner rows yet"
        />
      ) : (
        <div className={styles.stack}>
          <ul className={styles.questionList}>
            {learners.map((row) => (
              <LearnerRow key={row.subjectUserId} row={row} />
            ))}
          </ul>
          {rows.value.omittedLearners > 0 && (
            <Truncation>
              {`This list is truncated: ${count(
                rows.value.omittedLearners,
              )} further ${plural(
                rows.value.omittedLearners,
                "learner",
              )} are not returned; the query caps at the top ${count(
                learnerSignals.limits.learners,
              )} ranked by critical and notable questions, stuck clusters and volume.`}
            </Truncation>
          )}
        </div>
      )}

      <Limitations
        items={coverage.limitations}
        label="Learner coverage limitations"
      />
      <Limitations items={rows.limitations} label="Learner row limitations" />
    </section>
  );
}

// --------------------------------------------------------- learner progress

function ProgressSection({
  progress,
}: {
  readonly progress: AnalyticsLearnerProgress;
}) {
  const funnel = progress.metrics.courseFunnel;
  const timing = progress.metrics.courseCompletionTiming;
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);

  if (funnel.state === "unknown") {
    return (
      <section className={styles.section}>
        <SectionHead
          eyebrow="Learner progress"
          state="unknown"
          title="Completion funnel"
        />
        <Tile
          label="Completion funnel"
          metricState="unknown"
          reason={reasonFrom(
            funnel.limitations,
            "The platform did not report a course funnel for this range.",
          )}
          value={undefined}
        />
      </section>
    );
  }

  const courses = funnel.value.courses;
  const openCourse =
    courses.find((course) => course.courseId === openCourseId) ?? null;
  const totalWithProgress = courses.reduce(
    (running, course) => running + course.learnersWithProgress,
    0,
  );
  const totalStalled = courses.reduce(
    (running, course) => running + course.stalledLearners,
    0,
  );
  const totalCompleted = courses.reduce(
    (running, course) => running + course.learnersCompleted,
    0,
  );
  const totalStarted = courses.reduce(
    (running, course) => running + course.learnersStarted,
    0,
  );

  const funnelItems: DistributionItem[] = courses.map((course) => ({
    id: course.courseId,
    label: course.courseTitle,
    value: course.learnersStarted,
    sublabel: [
      `${count(course.learnersCompleted)} completed`,
      `${count(course.learnersInProgress)} in progress`,
      course.learnersBlocked > 0
        ? `${count(course.learnersBlocked)} blocked`
        : null,
      course.stalledLearners > 0
        ? `${count(course.stalledLearners)} stalled`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    emphasis: course.courseId === openCourseId,
  }));

  const stalledItems: DistributionItem[] = courses
    .filter((course) => course.stalledLearners > 0)
    .map((course) => ({
      id: course.courseId,
      label: course.courseTitle,
      value: course.stalledLearners,
      sublabel: `${count(course.learnersInProgress + course.learnersBlocked)} not yet complete`,
    }));

  return (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Learner progress"
        lede={`Counts describe the recorded state at query time. A learner counts as stalled when the last recorded activity is more than ${count(
          progress.stalledThresholdDays,
        )} days before the end of the range.`}
        state={funnel.state}
        title="Completion funnel and stalled learners"
      />

      <div className={styles.tiles}>
        <Tile
          eyebrow="Across all courses"
          label="Learners with progress"
          metricState={funnel.state}
          reason="One row per learner and course in the recorded progress table."
          sublabel={`${count(totalStarted)} started · ${count(
            totalCompleted,
          )} completed`}
          value={count(totalWithProgress)}
        />
        <Tile
          eyebrow="Needs attention"
          label="Stalled learners"
          metricState={funnel.state}
          reason={`In progress or blocked with no recorded activity for over ${count(
            progress.stalledThresholdDays,
          )} days.`}
          value={count(totalStalled)}
        />
        <Tile
          eyebrow="Coverage gap"
          label="Unknown last activity"
          metricState={funnel.state}
          reason="Incomplete progress records with no last-activity timestamp. They are never counted as stalled."
          value={count(funnel.value.learnersWithUnknownActivity)}
        />
        <Tile
          eyebrow="Not instrumented"
          label="Completion timing"
          metricState="unknown"
          reason={reasonFrom(
            timing.limitations,
            "No course completion timestamp is recorded, so completions cannot be placed in a time bucket.",
          )}
          value={undefined}
        />
      </div>

      {courses.length === 0 ? (
        <EmptyState
          description="No learner has a recorded progress row for any course in this workspace."
          headline="No progress recorded"
        />
      ) : (
        <DistributionBar
          ariaLabel="Learners started by course"
          caption="Learners started, by course"
          items={funnelItems}
          onSelect={(item) =>
            setOpenCourseId((current) => (current === item.id ? null : item.id))
          }
          total={totalStarted}
        />
      )}

      {funnel.value.omittedCourses > 0 && (
        <Truncation>
          {`This list is truncated: ${count(
            funnel.value.omittedCourses,
          )} further ${plural(
            funnel.value.omittedCourses,
            "course",
          )} are not returned; the query caps at the top ${count(
            progress.limits.courses,
          )} courses by learners with a progress record.`}
        </Truncation>
      )}

      {openCourse !== null && (
        <div className={styles.drill}>
          <div className={styles.drillHead}>
            <div>
              <p className={styles.drillEyebrow}>Course funnel</p>
              <h4 className={styles.drillTitle}>{openCourse.courseTitle}</h4>
            </div>
            <Button onClick={() => setOpenCourseId(null)} size="sm">
              Collapse
            </Button>
          </div>

          <DistributionBar
            ariaLabel={`Funnel stages for ${openCourse.courseTitle}`}
            caption="Learners by stage"
            items={[
              {
                id: "started",
                label: "Started",
                value: openCourse.learnersStarted,
              },
              {
                id: "in-progress",
                label: "In progress",
                value: openCourse.learnersInProgress,
              },
              {
                id: "blocked",
                label: "Blocked",
                value: openCourse.learnersBlocked,
              },
              {
                id: "completed",
                label: "Completed",
                value: openCourse.learnersCompleted,
              },
            ]}
            rank={false}
            total={openCourse.learnersWithProgress}
          />

          <div className={styles.tiles}>
            <Tile
              label="Completion rate of started"
              metricState={funnel.state}
              reason={
                openCourse.completionRateOfStarted === null
                  ? "No learner has started this course, so there is no denominator to divide."
                  : "Completed learners divided by learners who started."
              }
              value={sharePercent(openCourse.completionRateOfStarted) ?? undefined}
            />
            <Tile
              label="Average progress"
              metricState={funnel.state}
              reason={
                openCourse.averagePercentComplete === null
                  ? "No progress record for this course carries a percentage."
                  : "Mean recorded percent complete across learners with a progress row."
              }
              value={
                openCourse.averagePercentComplete === null
                  ? undefined
                  : `${Math.round(openCourse.averagePercentComplete)}%`
              }
            />
          </div>

          <Facts
            items={[
              {
                label: "Lessons completed in range",
                value: count(openCourse.lessonsCompletedInRange),
              },
              {
                label: "Active learners in range",
                value: count(openCourse.activeLearnersInRange),
              },
              {
                label: "Stalled",
                value: count(openCourse.stalledLearners),
              },
              {
                label: "Unknown activity",
                value: count(openCourse.learnersWithUnknownActivity),
              },
              {
                label: "Last activity",
                value:
                  formatMoment(openCourse.lastActivityAt) ?? "not recorded",
              },
            ]}
          />
        </div>
      )}

      <div className={styles.stackTight}>
        <p className={styles.eyebrow}>Stalled learners by course</p>
        {stalledItems.length === 0 ? (
          <EmptyState
            compact
            description={`No in-progress or blocked learner has been inactive for more than ${count(
              progress.stalledThresholdDays,
            )} days.`}
            headline="No stalled learners recorded"
          />
        ) : (
          <DistributionBar
            ariaLabel="Stalled learners by course"
            items={stalledItems}
            total={totalStalled}
          />
        )}
      </div>

      <Limitations items={funnel.limitations} label="Course funnel limitations" />
    </section>
  );
}

// ------------------------------------------------------------------ loading

type LoadError =
  | "unavailable"
  | "denied"
  | "authentication"
  | "invalid_range"
  | "unverifiable";

const errorCopy: Record<LoadError, { headline: string; description: string }> = {
  unavailable: {
    headline: "Analytics are not available yet",
    description:
      "The durable analytics functions did not answer. This is expected until the learning analytics migration has been applied to this project's database. No sample or estimated figures are shown in their place.",
  },
  denied: {
    headline: "Analytics are restricted for this role",
    description:
      "Your current role is not permitted to read tenant analytics. Nothing is substituted for the figures you cannot see.",
  },
  authentication: {
    headline: "Sign in again to read analytics",
    description:
      "The session could not be verified for this request. Reload the console and sign in to continue.",
  },
  invalid_range: {
    headline: "That range could not be used",
    description:
      "The analytics service rejected the requested range. Choose one of the preset ranges and try again.",
  },
  unverifiable: {
    headline: "The analytics response could not be verified",
    description:
      "The service replied with a payload this console cannot confirm is a durable analytics envelope, so none of it is displayed.",
  },
};

function mapErrorCode(status: number, code: unknown): LoadError {
  if (status === 403 || code === "access_denied") return "denied";
  if (status === 401 || code === "authentication_required") {
    return "authentication";
  }
  if (code === "invalid_range" || code === "invalid_request") {
    return "invalid_range";
  }
  return "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadAnalytics(days: number): Promise<AnalyticsSnapshot> {
  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);
  const query = new URLSearchParams({
    end: end.toISOString(),
    start: start.toISOString(),
  });

  let response: Response;
  try {
    response = await fetch(`/api/analytics?${query.toString()}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new AnalyticsRpcError("request_failed");
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AnalyticsRpcError(
      mapErrorCode(response.status, isRecord(body) ? body.code : undefined),
    );
  }
  if (!isRecord(body) || body.ok !== true) {
    throw new AnalyticsRpcError("unverifiable");
  }

  return {
    answerQuality: parseAnalyticsAnswerQuality(body.answerQuality),
    distribution: parseAnalyticsQuestionDistribution(body.distribution),
    learnerProgress: parseAnalyticsLearnerProgress(body.learnerProgress),
    overview: parseAnalyticsTenantOverview(body.overview),
  };
}

type QuestionIntelligence = {
  readonly labels: AnalyticsQuestionLabels;
  readonly signals: AnalyticsSignals;
};

function rangeQuery(days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);
  return { end: end.toISOString(), start: start.toISOString() };
}

async function loadQuestionIntelligence(
  days: number,
): Promise<QuestionIntelligence> {
  const { end, start } = rangeQuery(days);
  const query = new URLSearchParams({ end, start });

  let response: Response;
  try {
    response = await fetch(
      `/api/analytics/question-intelligence?${query.toString()}`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );
  } catch {
    throw new AnalyticsRpcError("request_failed");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AnalyticsRpcError(
      mapErrorCode(response.status, isRecord(body) ? body.code : undefined),
    );
  }
  if (!isRecord(body) || body.ok !== true) {
    throw new AnalyticsRpcError("unverifiable");
  }
  return {
    labels: parseAnalyticsQuestionLabels(body.labels),
    signals: parseAnalyticsSignals(body.signals),
  };
}

/**
 * Surface analytics load on their own so a workspace without the
 * widget-analytics migration still gets the rest of this surface, and is told
 * that surface attribution is unavailable rather than shown a widget with zero
 * traffic. Those are different claims and only one of them is true.
 */
async function loadWidgetAnalytics(
  days: number,
): Promise<AnalyticsWidgetSnapshot> {
  const { end, start } = rangeQuery(days);
  const query = new URLSearchParams({ end, start });

  let response: Response;
  try {
    response = await fetch(`/api/analytics/widget?${query.toString()}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new AnalyticsRpcError("request_failed");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AnalyticsRpcError(
      mapErrorCode(response.status, isRecord(body) ? body.code : undefined),
    );
  }
  if (!isRecord(body) || body.ok !== true) {
    throw new AnalyticsRpcError("unverifiable");
  }
  return {
    breakdown: parseAnalyticsSurfaceBreakdown(body.breakdown),
    contentGaps: parseAnalyticsWidgetContentGaps(body.contentGaps),
    engagement: parseAnalyticsWidgetEngagement(body.engagement),
  };
}

/**
 * Per-learner signals load on their own, same reason as the widget snapshot
 * above: a workspace whose database has not yet taken the
 * learner-signal-readout migration must still get the rest of this surface.
 */
async function loadLearnerSignals(
  days: number,
): Promise<AnalyticsLearnerSignals> {
  const { end, start } = rangeQuery(days);
  const query = new URLSearchParams({ end, start });

  let response: Response;
  try {
    response = await fetch(
      `/api/analytics/learner-signals?${query.toString()}`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );
  } catch {
    throw new AnalyticsRpcError("request_failed");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AnalyticsRpcError(
      mapErrorCode(response.status, isRecord(body) ? body.code : undefined),
    );
  }
  if (!isRecord(body) || body.ok !== true) {
    throw new AnalyticsRpcError("unverifiable");
  }
  return parseAnalyticsLearnerSignals(body.learnerSignals);
}

function toLoadError(error: unknown): LoadError {
  if (error instanceof AnalyticsRpcError) {
    if (
      error.code === "denied" ||
      error.code === "authentication" ||
      error.code === "invalid_range" ||
      error.code === "unverifiable" ||
      error.code === "unavailable"
    ) {
      return error.code;
    }
    if (error.code === "invalid_response") return "unverifiable";
  }
  return "unavailable";
}

// -------------------------------------------------------------------- panel

/**
 * Insights panel — durable learning analytics for this tenant.
 *
 * Question distribution leads the surface, followed by volume over time,
 * answer grounding and the learner progress funnel. Range changes re-query the
 * analytics API; the previously loaded range stays on screen, labelled, while
 * the new one is fetched.
 */
export function InsightsPanel({ payload, refresh }: PanelProps) {
  const dataVersion = useDataVersion();
  const [range, setRange] = useState<RangeValue>("30");
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [failure, setFailure] = useState<LoadError | null>(null);
  const [loading, setLoading] = useState(true);
  const [intelligence, setIntelligence] = useState<QuestionIntelligence | null>(
    null,
  );
  const [intelligenceFailure, setIntelligenceFailure] =
    useState<LoadError | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [intelligenceVersion, setIntelligenceVersion] = useState(0);
  const [widget, setWidget] = useState<AnalyticsWidgetSnapshot | null>(null);
  const [widgetFailure, setWidgetFailure] = useState<LoadError | null>(null);
  const [learnerSignals, setLearnerSignals] =
    useState<AnalyticsLearnerSignals | null>(null);
  const [learnerSignalsFailure, setLearnerSignalsFailure] =
    useState<LoadError | null>(null);

  const days = Number(range);

  const load = useCallback(async () => loadAnalytics(days), [days]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSnapshot(null);
        setFailure(toLoadError(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, dataVersion]);

  // Question intelligence loads on its own so that a workspace without the
  // question-intelligence migration still gets the rest of this surface, and
  // says plainly that labels and signals are unavailable.
  useEffect(() => {
    let active = true;
    loadQuestionIntelligence(days)
      .then((next) => {
        if (!active) return;
        setIntelligence(next);
        setIntelligenceFailure(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setIntelligence(null);
        setIntelligenceFailure(toLoadError(error));
      });
    return () => {
      active = false;
    };
  }, [days, dataVersion, intelligenceVersion]);

  // Surface analytics load independently of the four original RPCs.
  useEffect(() => {
    let active = true;
    loadWidgetAnalytics(days)
      .then((next) => {
        if (!active) return;
        setWidget(next);
        setWidgetFailure(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setWidget(null);
        setWidgetFailure(toLoadError(error));
      });
    return () => {
      active = false;
    };
  }, [days, dataVersion]);

  // Per-learner signals load independently for the same reason: a database
  // without the learner-signal-readout migration must not take the rest of
  // the panel down with it.
  useEffect(() => {
    let active = true;
    loadLearnerSignals(days)
      .then((next) => {
        if (!active) return;
        setLearnerSignals(next);
        setLearnerSignalsFailure(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLearnerSignals(null);
        setLearnerSignalsFailure(toLoadError(error));
      });
    return () => {
      active = false;
    };
  }, [days, dataVersion]);

  const reviewSignal = useCallback(
    (signal: DetectedSignal, action: SignalReviewAction) => {
      const { end, start } = rangeQuery(days);
      setReviewing(signal.signalFingerprint);
      setReviewError(null);
      void (async () => {
        try {
          const response = await fetch(
            "/api/analytics/question-intelligence",
            {
              body: JSON.stringify({
                end,
                nextStatus: action,
                signalFingerprint: signal.signalFingerprint,
                start,
              }),
              cache: "no-store",
              headers: { "content-type": "application/json" },
              method: "POST",
            },
          );
          if (!response.ok) {
            const body: unknown = await response.json().catch(() => null);
            const code =
              isRecord(body) && typeof body.code === "string"
                ? body.code
                : "request_denied";
            setReviewError(
              code === "invalid_transition"
                ? "That review step is not allowed from the signal's current state. The lifecycle only moves forward."
                : code === "signal_not_found"
                  ? "The platform no longer detects that signal in this range, so no review was recorded."
                  : "The review could not be recorded. Nothing was changed.",
            );
            return;
          }
          setIntelligenceVersion((current) => current + 1);
        } catch {
          setReviewError(
            "The review request did not reach the platform. Nothing was changed.",
          );
        } finally {
          setReviewing(null);
        }
      })();
    },
    [days],
  );

  const rangeLine = useMemo(() => {
    if (snapshot === null) return null;
    const { range: window } = snapshot.overview;
    const from = formatDay(window.start);
    const to = formatDay(window.end);
    if (from === null || to === null) return null;
    return `${from} – ${to} · ${count(window.dayCount)} ${plural(
      window.dayCount,
      "day",
    )} · ${window.timeZone}`;
  }, [snapshot]);

  const definitions = useMemo(() => {
    if (snapshot === null) return [];
    const merged = new Map<string, string>();
    for (const section of [
      snapshot.overview,
      snapshot.distribution,
      snapshot.answerQuality,
      snapshot.learnerProgress,
      ...(intelligence === null
        ? []
        : [intelligence.labels, intelligence.signals]),
      ...(widget === null
        ? []
        : [widget.breakdown, widget.engagement, widget.contentGaps]),
      ...(learnerSignals === null ? [] : [learnerSignals]),
    ]) {
      for (const [term, meaning] of Object.entries(section.definitions)) {
        if (!merged.has(term)) merged.set(term, meaning);
      }
    }
    return [...merged.entries()];
  }, [snapshot, intelligence, widget, learnerSignals]);

  const toolbar = (
    <div className={styles.toolbar}>
      <div className={styles.toolbarText}>
        <p className={styles.eyebrow}>
          Durable analytics · {payload.tenant.displayName}
        </p>
        {rangeLine !== null ? (
          <p className={styles.rangeLine}>{rangeLine}</p>
        ) : (
          <p className={styles.rangeLine}>
            Questions, grounding and progress for this workspace.
          </p>
        )}
        {loading ? (
          <p className={styles.status} role="status">
            Loading durable analytics…
          </p>
        ) : snapshot === null ? null : (
          <p className={styles.status}>
            Generated {formatMoment(snapshot.overview.generatedAt) ?? "just now"}
          </p>
        )}
      </div>
      <div className={styles.toolbarActions}>
        <SelectField
          className={styles.rangeField}
          label="Range"
          onChange={(event) => {
            const next = event.target.value;
            if (isRangeValue(next)) setRange(next);
          }}
          options={RANGE_OPTIONS}
          value={range}
        />
        <Button loading={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
    </div>
  );

  if (failure !== null) {
    const copy = errorCopy[failure];
    return (
      <div className={styles.panel}>
        {toolbar}
        <EmptyState
          action={
            <Button loading={loading} onClick={() => void refresh()}>
              Try again
            </Button>
          }
          description={copy.description}
          headline={copy.headline}
          tone={failure === "denied" ? "restricted" : "error"}
        />
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <div className={styles.panel}>
        {toolbar}
        <p className={styles.status} role="status">
          Reading durable analytics for the selected range…
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {toolbar}

      <DistributionSection distribution={snapshot.distribution} />

      {intelligence === null ? (
        <section className={styles.section}>
          <SectionHead
            eyebrow="Question labels and signals"
            state="unknown"
            title="Topics, intents and signals"
          />
          <EmptyState
            description={
              intelligenceFailure === "denied"
                ? "Your current role is not permitted to read question labels or signals. Nothing is substituted for them."
                : "The question intelligence functions did not answer. This is expected until the question-intelligence migration has been applied to this project's database. No sample topics, intents or signals are shown in their place."
            }
            headline={
              intelligenceFailure === "denied"
                ? "Labels and signals are restricted for this role"
                : "Question labels and signals are not available yet"
            }
            tone={intelligenceFailure === "denied" ? "restricted" : "neutral"}
          />
        </section>
      ) : (
        <>
          <LabelsSection labels={intelligence.labels} />
          <SignalsSection
            onReview={reviewSignal}
            reviewError={reviewError}
            reviewing={reviewing}
            signals={intelligence.signals}
          />
        </>
      )}

      {widget === null ? (
        <section className={styles.section}>
          <SectionHead
            eyebrow="Where questions arrive"
            state="unknown"
            title="Console and widget"
          />
          <EmptyState
            description={
              widgetFailure === "denied"
                ? "Your current role is not permitted to read surface analytics. Nothing is substituted for them."
                : "The surface analytics functions did not answer. This is expected until the widget-analytics migration has been applied to this project's database. Widget activity is not shown as zero here, because an unrecorded surface and an unused widget are different things."
            }
            headline={
              widgetFailure === "denied"
                ? "Surface analytics are restricted for this role"
                : "Surface attribution is not available yet"
            }
            tone={widgetFailure === "denied" ? "restricted" : "neutral"}
          />
        </section>
      ) : (
        <>
          <SurfaceSection widget={widget} />
          <WidgetSection widget={widget} />
        </>
      )}

      {learnerSignals === null ? (
        <section className={styles.section}>
          <SectionHead
            eyebrow="Learner signals"
            state="unknown"
            title="Who is worth your attention"
          />
          <EmptyState
            description={
              learnerSignalsFailure === "denied"
                ? "Your current role is not permitted to read per-learner signals. Nothing is substituted for them."
                : "The learner-signal functions did not answer. This is expected until the learner-signal-readout migration has been applied to this project's database. No sample learners are shown in their place."
            }
            headline={
              learnerSignalsFailure === "denied"
                ? "Learner signals are restricted for this role"
                : "Learner signals are not available yet"
            }
            tone={learnerSignalsFailure === "denied" ? "restricted" : "neutral"}
          />
        </section>
      ) : (
        <LearnerSignalsSection learnerSignals={learnerSignals} />
      )}

      <VolumeSection overview={snapshot.overview} />
      <QualitySection quality={snapshot.answerQuality} />
      <ProgressSection progress={snapshot.learnerProgress} />

      {definitions.length > 0 && (
        <details className={styles.definitions}>
          <summary>How these numbers are defined</summary>
          <dl className={styles.definitionList}>
            {definitions.map(([term, meaning]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <p className={styles.boundary}>
        <strong>Durable analytics boundary.</strong> Every figure here is
        aggregated by a tenant-scoped Supabase function over recorded rows. A
        metric the platform cannot measure is shown as “Not known” with the
        reason, never as a zero; a truncated list always states what was left
        out. No fixture, sample or estimated data appears on this surface.
      </p>
    </div>
  );
}

export default InsightsPanel;
