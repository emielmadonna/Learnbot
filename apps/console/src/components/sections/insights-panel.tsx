"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
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
  type AnalyticsTenantOverview,
  type AnalyticsWidgetSnapshot,
} from "../../lib/supabase/analytics-rpc";
import {
  parseAnswerFeedbackSummary,
  type AnswerFeedbackSummary,
} from "../../lib/supabase/answer-feedback-rpc";
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
  type QuestionIntentName,
  type ReadinessTier,
  type SignalKind,
  type SignalReviewAction,
} from "../../lib/supabase/question-intelligence-rpc";
import { Button, EmptyState, StateBadge } from "../ui";
import styles from "./insights-panel.module.css";

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
  { value: "366", label: "All" },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

type InsightsView = "insights" | "signals" | "students";

const INSIGHTS_VIEWS: readonly {
  readonly value: InsightsView;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "insights",
    label: "Questions",
    description: "What people asked and how the assistant answered",
  },
  {
    value: "students",
    label: "Students",
    description: "Depth, progress and learners worth a closer look",
  },
  {
    value: "signals",
    label: "Signals",
    description: "Patterns that crossed a recorded threshold",
  },
];

function insightsViewFrom(params: URLSearchParams): InsightsView {
  const value = params.get("view");
  return value === "students" || value === "signals" ? value : "insights";
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

type InsightsExportFormat = "json" | "csv";

type InsightsExportRow = {
  dataset: string;
  path: string;
  value: string;
};

function collectExportRows(
  value: unknown,
  dataset: string,
  path: string,
  rows: InsightsExportRow[],
) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ dataset, path, value: "[]" });
      return;
    }
    value.forEach((item, index) => {
      collectExportRows(item, dataset, `${path}[${index}]`, rows);
    });
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      rows.push({ dataset, path, value: "{}" });
      return;
    }
    entries.forEach(([key, item]) => {
      collectExportRows(item, dataset, path ? `${path}.${key}` : key, rows);
    });
    return;
  }
  rows.push({
    dataset,
    path,
    value: value === null || value === undefined ? "" : String(value),
  });
}

function exportCsvCell(value: string) {
  const protectedValue = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

function analyticsExportCsv(exportData: Record<string, unknown>) {
  const rows: InsightsExportRow[] = [];
  for (const [dataset, value] of Object.entries(exportData)) {
    collectExportRows(value, dataset, "", rows);
  }
  return [
    ["dataset", "path", "value"].map(exportCsvCell).join(","),
    ...rows.map((row) =>
      [row.dataset, row.path, row.value].map(exportCsvCell).join(","),
    ),
  ].join("\r\n");
}

function downloadInsightsExport(
  format: InsightsExportFormat,
  filenameStem: string,
  exportData: Record<string, unknown>,
) {
  const body =
    format === "json"
      ? JSON.stringify(exportData, null, 2)
      : `${analyticsExportCsv(exportData)}\r\n`;
  const blob = new Blob([body], {
    type:
      format === "json"
        ? "application/json;charset=utf-8"
        : "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filenameStem}.${format}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

// ------------------------------------------------ labelled questions

const INTENT_LABELS: Record<QuestionIntentName, string> = {
  clarification: "Clarification",
  definition: "Definition",
  how_to: "How to",
  off_topic: "Off topic",
  scope_check: "Scope check",
  troubleshooting: "Troubleshooting",
};

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

// -------------------------------------------------------- learner signals

const ESCALATION_LABELS: Record<EscalationState, string> = {
  declining: "Declining",
  escalating: "Escalating",
  insufficient_data: "Not enough data yet",
  steady: "Steady",
};

const READINESS_LABELS: Record<ReadinessTier, string> = {
  insufficient_data: "Not enough data yet",
  likely_ready: "Looks ready for a next offer",
  not_yet: "Not yet",
  possible: "Possible",
};

function learnerLabel(row: LearnerSignalRow): string {
  if (row.displayName !== null && row.displayName.trim() !== "") {
    return row.displayName;
  }
  return `Learner ${row.subjectUserId.slice(0, 8)}`;
}

// ---------------------------------------------------- Corso v2 presentation

type QuestionListFilter = "all" | "refused" | "repeated";
type LearnerListFilter = "engaged" | "beyond" | "stuck" | "quiet";
type SignalListFilter = "new" | "open" | "reviewed" | "resolved";

function initialsFor(label: string) {
  const local = label.split("@")[0] ?? label;
  const words = local
    .split(/[\s._-]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (words.length === 0) return "L";
  const first = words[0]?.[0] ?? "L";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

function percentage(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function SurfaceMark() {
  return (
    <span aria-hidden="true" className={styles.v2Mark}>
      <i />
    </span>
  );
}

function V2RangeButtons({
  disabled,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (value: RangeValue) => void;
  readonly value: RangeValue;
}) {
  return (
    <div aria-label="Analytics range" className={styles.v2Range} role="group">
      {RANGE_OPTIONS.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={cx(
            styles.v2RangeButton,
            value === option.value && styles.v2RangeButtonActive,
          )}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={
            option.value === "366"
              ? "All available analytics, up to the platform's one-year reporting limit"
              : undefined
          }
          type="button"
        >
          {option.value === "7"
            ? "7d"
            : option.value === "30"
              ? "30d"
              : "All"}
        </button>
      ))}
    </div>
  );
}

/**
 * The switcher between Questions, Students and Signals.
 *
 * These three are one panel behind `?view=`, not three panels, so without this
 * control the only way to reach Students or Signals was to type the query
 * string by hand — the panel rendered no navigation at all. They are anchors
 * rather than buttons so the deep link stays copyable and mid-click still
 * opens a new tab; `PanelHost` already owns `?view=` as shell state.
 */
function V2ViewSwitch({ view }: { readonly view: InsightsView }) {
  return (
    <nav aria-label="Analytics view" className={styles.v2ViewSwitch}>
      {INSIGHTS_VIEWS.map((entry) => (
        <a
          aria-current={entry.value === view ? "page" : undefined}
          className={cx(
            styles.v2ViewSwitchLink,
            entry.value === view && styles.v2ViewSwitchLinkActive,
          )}
          href={`/app?panel=insights&view=${entry.value}`}
          key={entry.value}
          title={entry.description}
        >
          {entry.label}
        </a>
      ))}
    </nav>
  );
}

function V2SurfaceHeader({
  children,
  detail,
  title,
  view,
}: {
  readonly children?: ReactNode;
  readonly detail?: string | undefined;
  readonly title: string;
  readonly view?: InsightsView | undefined;
}) {
  return (
    <header className={styles.v2SurfaceHeader}>
      <div className={styles.v2SurfaceTitle}>
        <SurfaceMark />
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <div className={styles.v2HeaderActions}>
        {view ? <V2ViewSwitch view={view} /> : null}
        {children}
      </div>
    </header>
  );
}

function V2MetricCard({
  badge,
  label,
  sublabel,
  tone,
  value,
}: {
  readonly badge?: string | undefined;
  readonly label: string;
  readonly sublabel: string;
  readonly tone?: "good" | "warning" | "muted" | undefined;
  readonly value: string;
}) {
  return (
    <article className={styles.v2MetricCard}>
      <span className={styles.v2MetricLabel}>{label}</span>
      <div className={styles.v2MetricValueLine}>
        <strong
          className={cx(
            styles.v2MetricValue,
            value.length > 8 && styles.v2MetricValueLong,
          )}
        >
          {value}
        </strong>
        {badge ? <span className={styles.v2PartialBadge}>{badge}</span> : null}
      </div>
      <span
        className={cx(
          styles.v2MetricSublabel,
          tone === "good" && styles.v2Good,
          tone === "warning" && styles.v2Warning,
        )}
      >
        {sublabel}
      </span>
    </article>
  );
}

function V2InsightsView({
  exportAvailable,
  exportNotice,
  feedback,
  feedbackFailure,
  intelligence,
  loading,
  onExport,
  onExportJson,
  onRangeChange,
  onRefresh,
  range,
  rangeLine,
  snapshot,
}: {
  readonly exportAvailable: boolean;
  readonly exportNotice: string | null;
  readonly feedback: AnswerFeedbackSummary | null;
  readonly feedbackFailure: LoadError | null;
  readonly intelligence: QuestionIntelligence | null;
  readonly loading: boolean;
  readonly onExport: () => void;
  readonly onExportJson: () => void;
  readonly onRangeChange: (value: RangeValue) => void;
  readonly onRefresh: () => void;
  readonly range: RangeValue;
  readonly rangeLine: string | null;
  readonly snapshot: AnalyticsSnapshot;
}) {
  const [filter, setFilter] = useState<QuestionListFilter>("all");
  const [query, setQuery] = useState("");

  const volume = snapshot.overview.metrics.questionVolume;
  const activeLearners = snapshot.overview.metrics.activeLearners;
  const grounding = snapshot.answerQuality.metrics.groundingCoverage;
  const totalQuestions =
    volume.state === "unknown" ? 0 : volume.value.totalQuestions;
  const learnerCount =
    activeLearners.state === "unknown" ? null : activeLearners.value.learners;
  const answerCount =
    grounding.state === "unknown" ? null : grounding.value.answers;
  const answeredShare =
    answerCount === null ? null : percentage(answerCount, totalQuestions);
  const noAnswerCount =
    answerCount === null ? null : Math.max(0, totalQuestions - answerCount);

  // "Rated helpful" is three distinct statements and collapsing them would be
  // exactly the lie 20260731061000's header warns about. A read that failed is
  // "Not known"; a window that genuinely holds no rating is "Not measured";
  // and a real score never travels without the response rate it was drawn
  // from, because a percentage over a self-selected handful is meaningless on
  // its own.
  const feedbackValue =
    feedback === null
      ? "Not known"
      : feedback.helpfulPercent === null
        ? "Not measured"
        : `${feedback.helpfulPercent}%`;
  const feedbackBadge =
    feedback === null
      ? "NOT READ"
      : feedback.helpfulPercent === null
        ? "NOT RATED"
        : feedback.ratedPercent !== null && feedback.ratedPercent < 100
          ? "PARTIAL"
          : undefined;
  const feedbackSublabel =
    feedback === null
      ? feedbackFailure === "denied"
        ? "Your role may not read answer feedback"
        : feedbackFailure === null
          ? "Reading recorded ratings…"
          : "Answer feedback could not be read"
      : feedback.helpfulPercent === null
        ? `No answer rated yet — ${count(feedback.answerCount)} answered`
        : `${count(feedback.ratedCount)} of ${count(feedback.answerCount)} answers rated`;

  const labels = intelligence?.labels ?? null;
  const important = labels?.metrics.importantQuestions ?? null;
  const topics = labels?.metrics.topicDistribution ?? null;
  const rows =
    important === null || important.state === "unknown"
      ? []
      : important.value.questions;
  const refusedRows = rows.filter(
    (row) =>
      row.groundingOutcome === "no_answer" ||
      row.groundingOutcome === "ungrounded",
  );
  const repeatedRows = rows.filter((row) => row.recurrence > 1);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shownRows = rows.filter((row) => {
    if (filter === "refused" && !refusedRows.includes(row)) return false;
    if (filter === "repeated" && row.recurrence <= 1) return false;
    if (normalizedQuery === "") return true;
    return [
      row.question,
      row.topicLabel,
      row.courseTitle,
      row.lessonTitle,
      INTENT_LABELS[row.intent],
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const topicRows =
    topics === null || topics.state === "unknown" ? [] : topics.value.topics;
  const maxTopicQuestions = Math.max(
    1,
    ...topicRows.map((topic) => topic.questions),
  );
  const buckets =
    volume.state === "unknown" ? [] : volume.value.buckets;
  const maxBucketQuestions = Math.max(
    1,
    ...buckets.map((bucket) => bucket.questions),
  );
  const peak = buckets.reduce<(typeof buckets)[number] | null>(
    (best, bucket) =>
      best === null || bucket.questions > best.questions ? bucket : best,
    null,
  );

  return (
    <div className={styles.v2Screen}>
      <V2SurfaceHeader title="Insights" view="insights">
        <V2RangeButtons
          disabled={loading}
          onChange={onRangeChange}
          value={range}
        />
        {/* Refresh and Export JSON have no other home on this surface — they
            used to live in a toolbar that rendered nowhere, so they move here
            rather than disappearing. */}
        <button
          className={styles.v2SecondaryButton}
          disabled={loading}
          onClick={onRefresh}
          type="button"
        >
          Refresh
        </button>
        <button
          className={styles.v2SecondaryButton}
          disabled={!exportAvailable}
          onClick={onExportJson}
          type="button"
        >
          Export JSON
        </button>
        <button
          className={styles.v2SecondaryButton}
          disabled={!exportAvailable}
          onClick={onExport}
          type="button"
        >
          Export CSV
        </button>
      </V2SurfaceHeader>

      <div className={styles.v2InsightsBody}>
        <div className={styles.v2MetricGrid}>
          <V2MetricCard
            label="Questions asked"
            sublabel={rangeLine ?? "Selected reporting range"}
            value={volume.state === "unknown" ? "Not known" : count(totalQuestions)}
          />
          <V2MetricCard
            label="Students asking"
            sublabel="Distinct authenticated learners"
            value={learnerCount === null ? "Not known" : count(learnerCount)}
          />
          <V2MetricCard
            label="Answered"
            sublabel={
              noAnswerCount === null
                ? "Answer recording is unavailable"
                : `${count(noAnswerCount)} without a recorded answer`
            }
            tone={noAnswerCount !== null && noAnswerCount > 0 ? "warning" : "good"}
            value={answeredShare ?? "Not known"}
          />
          <V2MetricCard
            badge={feedbackBadge}
            label="Rated helpful"
            sublabel={feedbackSublabel}
            value={feedbackValue}
          />
        </div>

        <div className={styles.v2InsightsGrid}>
          <section className={styles.v2Card}>
            <div className={styles.v2QuestionHeader}>
              <h2>Every question</h2>
              <label className={styles.v2Search}>
                <span aria-hidden="true">⌕</span>
                <span className={styles.srOnly}>Search questions</span>
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  type="search"
                  value={query}
                />
              </label>
            </div>
            <div
              aria-label="Question filters"
              className={styles.v2Pills}
              role="group"
            >
              <button
                aria-pressed={filter === "all"}
                className={cx(
                  styles.v2Pill,
                  filter === "all" && styles.v2PillActive,
                )}
                onClick={() => setFilter("all")}
                type="button"
              >
                All {count(totalQuestions)}
              </button>
              <button
                aria-pressed={filter === "refused"}
                className={cx(
                  styles.v2Pill,
                  filter === "refused" && styles.v2PillActive,
                )}
                onClick={() => setFilter("refused")}
                type="button"
              >
                Refused {count(refusedRows.length)}
              </button>
              <span
                className={cx(styles.v2Pill, styles.v2PillUnavailable)}
                title="Ratings are recorded and totalled on the card above, but analytics_question_labels does not carry a per-question rating, so this list cannot be filtered by one"
              >
                Not helpful —
              </span>
              <button
                aria-pressed={filter === "repeated"}
                className={cx(
                  styles.v2Pill,
                  filter === "repeated" && styles.v2PillActive,
                )}
                onClick={() => setFilter("repeated")}
                type="button"
              >
                Repeated {count(repeatedRows.length)}
              </button>
            </div>

            {shownRows.length === 0 ? (
              <div className={styles.v2CompactEmpty}>
                <strong>No matching recorded question</strong>
                <span>
                  {rows.length === 0
                    ? "Question-level labels are not available for this range."
                    : "Change the search or filter to see another recorded question."}
                </span>
              </div>
            ) : (
              <ul className={styles.v2QuestionRows}>
                {shownRows.map((row) => {
                  const outcome =
                    row.groundingOutcome === "no_answer"
                      ? "Refused"
                      : row.groundingOutcome === "ungrounded"
                        ? "Ungrounded"
                        : row.groundingOutcome === "grounded"
                          ? "Grounded"
                          : "Not recorded";
                  return (
                    <li key={row.messageId}>
                      <div className={styles.v2QuestionMain}>
                        <span className={styles.v2TinyAvatar}>
                          {initialsFor(row.topicLabel)}
                        </span>
                        <p>
                          “{row.question}
                          {row.truncatedQuestion ? "…" : ""}”
                        </p>
                        <span
                          className={cx(
                            styles.v2Outcome,
                            row.groundingOutcome === "grounded" &&
                              styles.v2OutcomeGood,
                            (row.groundingOutcome === "no_answer" ||
                              row.groundingOutcome === "ungrounded") &&
                              styles.v2OutcomeWarning,
                          )}
                        >
                          {outcome}
                        </span>
                      </div>
                      <div className={styles.v2QuestionMeta}>
                        <span>{row.topicLabel}</span>
                        <span>{INTENT_LABELS[row.intent]}</span>
                        <span>{formatMoment(row.askedAt) ?? "Time not recorded"}</span>
                        <span>
                          {row.lessonTitle ??
                            row.courseTitle ??
                            "Beyond the published syllabus"}
                        </span>
                        {row.recurrenceLearners > 1 ? (
                          <span className={styles.v2AccentText}>
                            Asked by {count(row.recurrenceLearners)} learners
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className={styles.v2ListFooter}>
              <span>
                Showing {count(shownRows.length)} of {count(totalQuestions)}
              </span>
              {important !== null &&
              important.state !== "unknown" &&
              important.value.omittedQuestions > 0 ? (
                <span>
                  {count(important.value.omittedQuestions)} more were outside the
                  ranked question response
                </span>
              ) : null}
            </div>
          </section>

          <aside className={styles.v2SideStack}>
            <section className={styles.v2SideCard}>
              <h2>Topics</h2>
              {topicRows.length === 0 ? (
                <p className={styles.v2SideNote}>
                  No classified topic is available for this range.
                </p>
              ) : (
                <div className={styles.v2TopicList}>
                  {topicRows.slice(0, 6).map((topic) => (
                    <div key={topic.topicKey}>
                      <div>
                        <span>{topic.topicLabel}</span>
                        <span>{count(topic.questions)}</span>
                      </div>
                      <span className={styles.v2BarTrack}>
                        <i
                          className={
                            topic.ungroundedAnswers === topic.questions
                              ? styles.v2BarMuted
                              : undefined
                          }
                          style={{
                            width: `${Math.max(
                              4,
                              (topic.questions / maxTopicQuestions) * 100,
                            )}%`,
                          }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {topics !== null &&
              topics.state !== "unknown" &&
              topics.value.unclassified.questions > 0 ? (
                <p className={styles.v2SideNote}>
                  {count(topics.value.unclassified.questions)} recorded{" "}
                  {plural(topics.value.unclassified.questions, "question")}{" "}
                  {topics.value.unclassified.questions === 1 ? "has" : "have"} no
                  classifier label and are not assigned to a made-up topic.
                </p>
              ) : null}
            </section>

            <section className={styles.v2SideCard}>
              <h2>When they ask</h2>
              {buckets.length === 0 ? (
                <p className={styles.v2SideNote}>
                  No daily activity is recorded for this range.
                </p>
              ) : (
                <>
                  <div
                    aria-label="Questions by day"
                    className={styles.v2MiniBars}
                    role="img"
                  >
                    {buckets.map((bucket) => (
                      <i
                        key={bucket.bucketStart}
                        style={{
                          height: `${Math.max(
                            5,
                            (bucket.questions / maxBucketQuestions) * 100,
                          )}%`,
                        }}
                        title={`${formatDay(bucket.bucketStart) ?? bucket.bucketStart}: ${count(bucket.questions)}`}
                      />
                    ))}
                  </div>
                  <div className={styles.v2MiniAxis}>
                    <span>{formatDay(buckets[0]?.bucketStart) ?? "Start"}</span>
                    <span>
                      {formatDay(buckets[buckets.length - 1]?.bucketStart) ??
                        "Now"}
                    </span>
                  </div>
                  <p className={styles.v2SideNote}>
                    {peak === null
                      ? "No recorded peak."
                      : `Peak recorded ${formatDay(peak.bucketStart) ?? "in this range"} with ${count(peak.questions)} ${plural(peak.questions, "question")}.`}
                  </p>
                </>
              )}
            </section>
          </aside>
        </div>
        {exportNotice ? (
          <p className={styles.v2Status} role="status">
            {exportNotice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function V2DepthBars({ row }: { readonly row: LearnerSignalRow }) {
  const share = row.depth.notableOrCriticalShare ?? 0;
  const filled = Math.max(1, Math.min(4, Math.ceil(share * 4)));
  return (
    <span
      aria-label={`${sharePercent(row.depth.notableOrCriticalShare) ?? "Unknown"} notable or critical depth`}
      className={styles.v2Depth}
    >
      {[1, 2, 3, 4].map((level) => (
        <i className={level <= filled ? styles.v2DepthFilled : undefined} key={level} />
      ))}
    </span>
  );
}

function V2StudentsView({
  learnerSignals,
}: {
  readonly learnerSignals: AnalyticsLearnerSignals;
}) {
  const [filter, setFilter] = useState<LearnerListFilter>("engaged");
  const rowsMetric = learnerSignals.metrics.learnerRows;
  const coverage = learnerSignals.metrics.learnerCoverage;
  const learners =
    rowsMetric.state === "unknown" ? [] : rowsMetric.value.learners;
  const [selectedLearnerId, setSelectedLearnerId] = useState<string | null>(
    learners[0]?.subjectUserId ?? null,
  );
  const quietCutoff = Date.now() - 14 * DAY_MS;
  const shownLearners = learners.filter((row) => {
    if (filter === "beyond") {
      return (
        row.readiness.tier === "likely_ready" ||
        row.readiness.tier === "possible"
      );
    }
    if (filter === "stuck") return row.stuck.clusterCount > 0;
    if (filter === "quiet") {
      const lastAsked = parseMs(row.lastAskedAt);
      return lastAsked !== null && lastAsked < quietCutoff;
    }
    return true;
  });
  const selected =
    shownLearners.find((row) => row.subjectUserId === selectedLearnerId) ??
    shownLearners[0] ??
    null;
  const coverageCount =
    coverage.state === "unknown" ? null : coverage.value.learners;

  return (
    <div className={styles.v2Screen}>
      <V2SurfaceHeader
        detail={
          coverageCount === null
            ? "· learner coverage unavailable"
            : `· ${count(coverageCount)} ${plural(coverageCount, "learner")} asked something in this range`
        }
        title="Students"
        view="students"
      />
      <div className={styles.v2SplitBody}>
        <section className={styles.v2LearnerListPane}>
          <div
            aria-label="Student filters"
            className={styles.v2Pills}
            role="group"
          >
            {(
              [
                ["engaged", "Most engaged"],
                ["beyond", "Asking beyond the course"],
                ["stuck", "Stuck"],
                ["quiet", "Gone quiet"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                className={cx(
                  styles.v2Pill,
                  styles.v2PillRaised,
                  filter === value && styles.v2PillActive,
                )}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <div className={styles.v2LearnerTable}>
            <div className={styles.v2LearnerTableHead}>
              <span>Student</span>
              <span>Asked</span>
              <span>Depth</span>
            </div>
            {shownLearners.length === 0 ? (
              <div className={styles.v2CompactEmpty}>
                <strong>No learner matches this filter</strong>
                <span>The filter only uses recorded learner signals.</span>
              </div>
            ) : (
              shownLearners.map((row) => {
                const label = learnerLabel(row);
                const active = selected?.subjectUserId === row.subjectUserId;
                // Two independent, recorded-signal-driven tones: "stuck" (a
                // repeated topic crossed the stuck threshold) reads as an
                // alert on the status line, and "gone quiet" (nothing asked
                // in the last 14 days) dims the whole row. Neither is a
                // judgement call — both come straight off the learner row.
                const isStuck = row.stuck.clusterCount > 0;
                const lastAskedMs = parseMs(row.lastAskedAt);
                const isQuiet = lastAskedMs !== null && lastAskedMs < quietCutoff;
                return (
                  <button
                    aria-pressed={active}
                    className={cx(
                      styles.v2LearnerRow,
                      active && styles.v2LearnerRowActive,
                      isQuiet && styles.v2LearnerRowQuiet,
                    )}
                    key={row.subjectUserId}
                    onClick={() => setSelectedLearnerId(row.subjectUserId)}
                    type="button"
                  >
                    <span className={styles.v2LearnerIdentity}>
                      <i className={active ? styles.v2AvatarActive : undefined}>
                        {initialsFor(label)}
                      </i>
                      <span>
                        <strong>{label}</strong>
                        <small className={isStuck ? styles.v2LearnerMetaStuck : undefined}>
                          Last asked {formatMoment(row.lastAskedAt) ?? "not recorded"}
                          {" · "}
                          {count(row.distinctTopics)}{" "}
                          {plural(row.distinctTopics, "topic")}
                        </small>
                      </span>
                    </span>
                    <strong>{count(row.questions)}</strong>
                    <V2DepthBars row={row} />
                  </button>
                );
              })
            )}
          </div>
          <p className={styles.v2PaneNote}>
            Depth is the recorded share of notable or critical classified
            questions. It is not a personality or ability score.
          </p>
        </section>

        <aside className={styles.v2DetailPane}>
          {selected === null ? (
            <div className={styles.v2CompactEmpty}>
              <strong>No recorded learner to inspect</strong>
              <span>Choose another range or filter.</span>
            </div>
          ) : (
            <>
              <div className={styles.v2DetailIdentity}>
                <span>{initialsFor(learnerLabel(selected))}</span>
                <div>
                  <h2>{learnerLabel(selected)}</h2>
                  <p>
                    {count(selected.questions)}{" "}
                    {plural(selected.questions, "question")} · last asked{" "}
                    {formatMoment(selected.lastAskedAt) ?? "not recorded"}
                  </p>
                </div>
              </div>

              <section className={styles.v2InsightCallout}>
                <h3>{READINESS_LABELS[selected.readiness.tier]}</h3>
                <p>
                  {count(selected.questions)} questions across{" "}
                  {count(selected.distinctTopics)}{" "}
                  {plural(selected.distinctTopics, "topic")} and{" "}
                  {count(selected.distinctLessons)}{" "}
                  {plural(selected.distinctLessons, "lesson")}.{" "}
                  {selected.readiness.evidence.maxPercentComplete === null
                    ? "No course-progress percentage is recorded."
                    : `Maximum recorded course progress is ${Math.round(
                        selected.readiness.evidence.maxPercentComplete,
                      )}%.`}
                </p>
              </section>

              <p className={styles.v2DetailEyebrow}>ENGAGEMENT</p>
              <dl className={styles.v2DetailFacts}>
                <div>
                  <dt>Question depth</dt>
                  <dd>
                    {sharePercent(selected.depth.notableOrCriticalShare) ??
                      "Not enough data"}
                  </dd>
                </div>
                <div>
                  <dt>Specificity trend</dt>
                  <dd>{ESCALATION_LABELS[selected.escalation.state]}</dd>
                </div>
                <div>
                  <dt>Ungrounded answers</dt>
                  <dd>{count(selected.ungroundedAnswers)}</dd>
                </div>
                <div>
                  <dt>Courses asked about</dt>
                  <dd>{count(selected.distinctCourses)}</dd>
                </div>
              </dl>

              <p className={styles.v2DetailEyebrow}>REPEATED QUESTIONS</p>
              {selected.stuck.clusters.length === 0 ? (
                <p className={styles.v2PaneNote}>
                  No topic crossed the recorded stuck threshold for this learner.
                </p>
              ) : (
                <ul className={styles.v2DetailCards}>
                  {selected.stuck.clusters.map((cluster) => (
                    <li key={`${cluster.lessonId ?? "none"}:${cluster.topicKey}`}>
                      <p>“{cluster.topicLabel}”</p>
                      <span>
                        {cluster.lessonTitle ??
                          cluster.courseTitle ??
                          "No course context"}{" "}
                        · asked {count(cluster.repeats)} times
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className={styles.v2PrivacyNote}>
                This view uses only the tenant's durable conversation subject,
                access-account label, classifications and progress rows.
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * One stroked glyph per lifecycle/severity combination, matching the mockup
 * exactly rather than approximating with text glyphs: a resolved signal
 * always gets the checkmark regardless of the severity it was detected at,
 * because "dismissed" is a review outcome, not a measurement.
 */
function V2SignalIcon({ signal }: { readonly signal: DetectedSignal }) {
  const resolved = signal.review.status === "dismissed";
  return (
    <span
      aria-hidden="true"
      className={cx(
        styles.v2SignalIcon,
        signal.severity === "critical" && styles.v2SignalIconCritical,
        signal.severity === "elevated" && styles.v2SignalIconElevated,
        signal.severity === "watch" && styles.v2SignalIconWatch,
      )}
    >
      <svg
        fill="none"
        height="18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={resolved ? 2.2 : 2}
        viewBox="0 0 24 24"
        width="18"
      >
        {resolved ? (
          <path d="M4.5 12.5 9.5 17.5 19.5 7" />
        ) : signal.severity === "critical" ? (
          <>
            <path d="M12 3.5 21 19H3z" />
            <path d="M12 10v4M12 16.5h.01" />
          </>
        ) : signal.severity === "elevated" ? (
          <>
            <path d="M20 12a8 8 0 1 1-2.4-5.7" />
            <path d="M20 4v4h-4" />
          </>
        ) : (
          <>
            <path d="M4 17l5-5 4 3.5 7-7.5" />
            <path d="M15 8h5v5" />
          </>
        )}
      </svg>
    </span>
  );
}

function v2EvidenceValue(fact: { readonly label: string; readonly value: string }) {
  const numeric = Number(fact.value);
  if (
    fact.label.toLocaleLowerCase().includes("share") &&
    Number.isFinite(numeric) &&
    numeric >= 0 &&
    numeric <= 1
  ) {
    return `${Math.round(numeric * 100)}%`;
  }
  return fact.value;
}

function signalMatchesFilter(signal: DetectedSignal, filter: SignalListFilter) {
  if (filter === "new") return signal.review.status === "new";
  if (filter === "open") {
    return (
      signal.review.status === "new" ||
      signal.review.status === "acknowledged"
    );
  }
  if (filter === "reviewed") {
    return (
      signal.review.status === "acknowledged" ||
      signal.review.status === "actioned"
    );
  }
  return signal.review.status === "dismissed";
}

function V2SignalsView({
  onReview,
  reviewError,
  reviewing,
  signals,
}: {
  readonly onReview: (
    signal: DetectedSignal,
    action: SignalReviewAction,
  ) => void;
  readonly reviewError: string | null;
  readonly reviewing: string | null;
  readonly signals: AnalyticsSignals;
}) {
  const metric = signals.metrics.detectedSignals;
  const rows = metric.state === "unknown" ? [] : metric.value.signals;
  const defaultFilter: SignalListFilter = rows.some(
    (signal) => signal.review.status === "new",
  )
    ? "new"
    : "open";
  const [filter, setFilter] = useState<SignalListFilter>(defaultFilter);
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(
    rows.find((signal) => signalMatchesFilter(signal, defaultFilter))
      ?.signalFingerprint ?? null,
  );
  const shownSignals = rows.filter((signal) =>
    signalMatchesFilter(signal, filter),
  );
  const selected =
    shownSignals.find(
      (signal) => signal.signalFingerprint === selectedFingerprint,
    ) ??
    shownSignals[0] ??
    null;
  const filterCounts: Record<SignalListFilter, number> = {
    new: rows.filter((signal) => signal.review.status === "new").length,
    open: rows.filter((signal) => signalMatchesFilter(signal, "open")).length,
    reviewed: rows.filter((signal) => signalMatchesFilter(signal, "reviewed"))
      .length,
    resolved: rows.filter((signal) => signal.review.status === "dismissed")
      .length,
  };

  return (
    <div className={styles.v2Screen}>
      <V2SurfaceHeader
        detail={`· ${count(filterCounts.new)} new in this range`}
        title="Signals"
        view="signals"
      />
      <div className={styles.v2SplitBody}>
        <section className={styles.v2SignalListPane}>
          <div
            aria-label="Signal filters"
            className={styles.v2Pills}
            role="group"
          >
            {(
              [
                ["new", "New"],
                ["open", "Open"],
                ["reviewed", "Reviewed"],
                ["resolved", "Resolved"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                className={cx(
                  styles.v2Pill,
                  styles.v2PillRaised,
                  filter === value && styles.v2PillActive,
                )}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {label} {count(filterCounts[value])}
              </button>
            ))}
          </div>

          {reviewError ? (
            <p className={styles.v2ReviewError} role="alert">
              {reviewError}
            </p>
          ) : null}

          <div className={styles.v2SignalList}>
            {shownSignals.length === 0 ? (
              <div className={styles.v2CompactEmpty}>
                <strong>No signal in this state</strong>
                <span>
                  The deterministic detectors returned no matching signal for
                  this range.
                </span>
                {/* The RPC explains its own emptiness — which detector had
                    nothing to compare, what was truncated — and the panel used
                    to drop that entirely, leaving an empty pane that looked
                    broken rather than quiet. */}
                {metric.limitations.map((limitation) => (
                  <span key={limitation}>{limitation}</span>
                ))}
              </div>
            ) : (
              shownSignals.map((signal) => {
                const active =
                  selected?.signalFingerprint === signal.signalFingerprint;
                const facts = evidenceFacts(signal.evidence).slice(0, 3);
                return (
                  <button
                    aria-pressed={active}
                    className={cx(
                      styles.v2SignalCard,
                      active && styles.v2SignalCardActive,
                      signal.review.status === "dismissed" &&
                        styles.v2SignalCardResolved,
                    )}
                    key={signal.signalFingerprint}
                    onClick={() =>
                      setSelectedFingerprint(signal.signalFingerprint)
                    }
                    type="button"
                  >
                    <div>
                      <V2SignalIcon signal={signal} />
                      <h3>{signal.headline}</h3>
                    </div>
                    <p>{signal.detail}</p>
                    <span className={styles.v2SignalFacts}>
                      <span>{SIGNAL_KIND_LABELS[signal.kind]}</span>
                      <span>{signal.severity}</span>
                      {facts.map((fact) => (
                        <span key={fact.label}>
                          {fact.label}: {v2EvidenceValue(fact)}
                        </span>
                      ))}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <aside className={styles.v2DetailPane}>
          {selected === null ? (
            <div className={styles.v2CompactEmpty}>
              <strong>No signal to inspect</strong>
              <span>Choose another lifecycle filter.</span>
            </div>
          ) : (
            <>
              <p className={styles.v2DetailEyebrow}>SIGNAL</p>
              <h2 className={styles.v2SignalDetailTitle}>{selected.headline}</h2>
              <p className={styles.v2SignalDetailCopy}>{selected.detail}</p>

              <p className={styles.v2DetailEyebrow}>RECORDED EVIDENCE</p>
              <dl className={styles.v2DetailFacts}>
                {evidenceFacts(selected.evidence).map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{v2EvidenceValue(fact)}</dd>
                  </div>
                ))}
              </dl>

              <p className={styles.v2DetailEyebrow}>READ FROM</p>
              {selected.evidenceRefs.length === 0 ? (
                <p className={styles.v2PaneNote}>
                  The detector returned no row reference for this signal.
                </p>
              ) : (
                <ul className={styles.v2EvidenceList}>
                  {selected.evidenceRefs.slice(0, 8).map((reference) => (
                    <li key={reference}>{reference}</li>
                  ))}
                </ul>
              )}

              {selected.review.note ? (
                <>
                  <p className={styles.v2DetailEyebrow}>REVIEW NOTE</p>
                  <p className={styles.v2SignalDetailCopy}>
                    {selected.review.note}
                  </p>
                </>
              ) : null}

              <div className={styles.v2SignalActions}>
                <a className={styles.v2PrimaryButton} href="/app?panel=course">
                  Write this lesson
                </a>
                {(NEXT_REVIEW_ACTIONS[selected.review.status] ?? [])
                  .filter(
                    (action) =>
                      selected.review.status !== "new" || action !== "actioned",
                  )
                  .map(
                  (action) => (
                    <button
                      className={
                        action === "actioned"
                          ? styles.v2PrimaryButton
                          : styles.v2SecondaryButton
                      }
                      disabled={reviewing === selected.signalFingerprint}
                      key={action}
                      onClick={() => onReview(selected, action)}
                      type="button"
                    >
                      {action === "acknowledged"
                        ? "Mark reviewed"
                        : REVIEW_ACTION_LABELS[action]}
                    </button>
                  ),
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
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

/**
 * "Rated helpful" loads on its own, same reason again: a workspace without
 * 20260731061000 must lose one metric card, not the panel. The card renders
 * "Not known" on failure and "Not measured" when the window genuinely holds no
 * rating — two different statements that must not collapse into each other.
 */
async function loadAnswerFeedback(
  days: number,
): Promise<AnswerFeedbackSummary> {
  const query = new URLSearchParams({ days: String(days) });

  let response: Response;
  try {
    response = await fetch(
      `/api/analytics/answer-feedback?${query.toString()}`,
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
  return parseAnswerFeedbackSummary({
    ok: true,
    dataMode: "durable",
    ...(isRecord(body.feedback) ? body.feedback : {}),
  });
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
export function InsightsPanel({ params, payload, refresh }: PanelProps) {
  const dataVersion = useDataVersion();
  const view = insightsViewFrom(params);
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
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedbackSummary | null>(null);
  const [feedbackFailure, setFeedbackFailure] = useState<LoadError | null>(
    null,
  );

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

  // Answer feedback loads independently for the same reason as the two blocks
  // above: 20260731061000 is the newest migration on this surface, so it is the
  // one most likely to be missing from a given project.
  useEffect(() => {
    let active = true;
    loadAnswerFeedback(days)
      .then((next) => {
        if (!active) return;
        setFeedback(next);
        setFeedbackFailure(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFeedback(null);
        setFeedbackFailure(toLoadError(error));
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

  const exportData = useMemo<Record<string, unknown>>(
    () => ({
      version: 1,
      exportedAt: new Date().toISOString(),
      tenant: {
        tenantId: payload.tenant.tenantId,
        slug: payload.tenant.slug,
        displayName: payload.tenant.displayName,
      },
      range: {
        days,
        ...(rangeQuery(days)),
      },
      availability: {
        analytics: snapshot !== null ? "available" : (failure ?? "loading"),
        questionIntelligence:
          intelligence !== null
            ? "available"
            : (intelligenceFailure ?? "loading"),
        widget: widget !== null ? "available" : (widgetFailure ?? "loading"),
        learnerSignals:
          learnerSignals !== null
            ? "available"
            : (learnerSignalsFailure ?? "loading"),
      },
      analytics: snapshot,
      questionIntelligence: intelligence,
      widget,
      learnerSignals,
    }),
    [
      days,
      failure,
      intelligence,
      intelligenceFailure,
      learnerSignals,
      learnerSignalsFailure,
      payload.tenant.displayName,
      payload.tenant.slug,
      payload.tenant.tenantId,
      snapshot,
      widget,
      widgetFailure,
    ],
  );

  const exportAvailable =
    snapshot !== null ||
    intelligence !== null ||
    widget !== null ||
    learnerSignals !== null;

  const exportAnalytics = useCallback(
    (format: InsightsExportFormat) => {
      if (!exportAvailable) return;
      const date = new Date().toISOString().slice(0, 10);
      downloadInsightsExport(
        format,
        `${payload.tenant.slug}-insights-${days}d-${date}`,
        exportData,
      );
      setExportNotice(
        `Downloaded ${format.toUpperCase()} from the durable data currently available for this range.`,
      );
    },
    [days, exportAvailable, exportData, payload.tenant.slug],
  );

  const intelligenceUnavailable = (
    <section className={styles.section}>
      <SectionHead
        eyebrow={view === "signals" ? "Signals" : "Question explorer"}
        state="unknown"
        title={
          view === "signals"
            ? "Patterns worth acting on"
            : "Topics, intents and questions"
        }
      />
      {intelligenceFailure === null ? (
        <p className={styles.status} role="status">
          Reading question intelligence for the selected range…
        </p>
      ) : (
        <EmptyState
          description={
            intelligenceFailure === "denied"
              ? "Your current role is not permitted to read question labels or signals. Nothing is substituted for them."
              : "The question intelligence functions did not answer. This is expected until the question-intelligence migration has been applied to this project's database. No sample topics, intents or signals are shown in their place."
          }
          headline={
            intelligenceFailure === "denied"
              ? "Question intelligence is restricted for this role"
              : "Question intelligence is not available yet"
          }
          tone={intelligenceFailure === "denied" ? "restricted" : "neutral"}
        />
      )}
    </section>
  );

  const learnerSignalsUnavailable = (
    <section className={styles.section}>
      <SectionHead
        eyebrow="Students"
        state="unknown"
        title="Who is worth your attention"
      />
      {learnerSignalsFailure === null ? (
        <p className={styles.status} role="status">
          Reading learner signals for the selected range…
        </p>
      ) : (
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
      )}
    </section>
  );

  if (view === "signals") {
    return (
      intelligence === null ? (
        <div className={styles.v2Screen}>
          <V2SurfaceHeader title="Signals" view="signals" />
          <div className={styles.v2Unavailable}>{intelligenceUnavailable}</div>
        </div>
      ) : (
        <V2SignalsView
          onReview={reviewSignal}
          reviewError={reviewError}
          reviewing={reviewing}
          signals={intelligence.signals}
        />
      )
    );
  }

  if (view === "students") {
    return (
      learnerSignals === null ? (
        <div className={styles.v2Screen}>
          <V2SurfaceHeader title="Students" view="students" />
          <div className={styles.v2Unavailable}>{learnerSignalsUnavailable}</div>
        </div>
      ) : (
        <V2StudentsView learnerSignals={learnerSignals} />
      )
    );
  }

  if (failure !== null) {
    const copy = errorCopy[failure];
    return (
      <div className={styles.v2Screen}>
        <V2SurfaceHeader title="Insights" view="insights">
          <V2RangeButtons
            disabled={loading}
            onChange={setRange}
            value={range}
          />
        </V2SurfaceHeader>
        <div className={styles.v2Unavailable}>
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
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <div className={styles.v2Screen}>
        <V2SurfaceHeader title="Insights" view="insights">
          <V2RangeButtons
            disabled={loading}
            onChange={setRange}
            value={range}
          />
        </V2SurfaceHeader>
        <p className={styles.v2Loading} role="status">
          Reading durable analytics for the selected range…
        </p>
      </div>
    );
  }

  return (
    <V2InsightsView
      exportAvailable={exportAvailable}
      exportNotice={exportNotice}
      feedback={feedback}
      feedbackFailure={feedbackFailure}
      intelligence={intelligence}
      loading={loading}
      onExport={() => exportAnalytics("csv")}
      onExportJson={() => exportAnalytics("json")}
      onRangeChange={setRange}
      onRefresh={() => void refresh()}
      range={range}
      rangeLine={rangeLine}
      snapshot={snapshot}
    />
  );
}

export default InsightsPanel;
