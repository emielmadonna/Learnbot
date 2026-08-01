"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AnalyticsRpcError,
  parseAnalyticsAnswerQuality,
  parseAnalyticsLearnerProgress,
  parseAnalyticsQuestionDistribution,
  parseAnalyticsTenantOverview,
  type AnalyticsAnswerQuality,
  type AnalyticsLearnerProgress,
  type AnalyticsQuestionDistribution,
  type AnalyticsTenantOverview,
} from "../../lib/supabase/analytics-rpc";
import type { LearningCourse } from "../../lib/supabase/learning-rpc";
import {
  parseAnalyticsQuestionLabels,
  parseAnalyticsSignals,
  type AnalyticsQuestionLabels,
  type AnalyticsSignals,
} from "../../lib/supabase/question-intelligence-rpc";
import {
  PlatformRpcError,
  parsePlatformOverview,
  type PlatformOverview,
} from "../../lib/supabase/platform-rpc";
import type { PanelKey, ShellPayload } from "../app-shell/contract";
import { asWorkspace, useDataVersion } from "../app-shell/shell-data";
import { usePanelRouter } from "../app-shell/use-panel-router";
import {
  DistributionBar,
  EmptyState,
  StateBadge,
  StatTile,
  TrendChart,
  type DistributionItem,
  type TrendPoint,
} from "../ui";
import { cx } from "../ui/cx";
import { errorMessages, percent, statusMessages } from "./learning-format";
import styles from "./home-section.module.css";

/**
 * The canvas of the shell: what the signed-in person sees before any panel is
 * opened. Every destination from here is a panel, never a navigation.
 *
 * The canvas is not one surface. A learner sees their own learning; an operator
 * (teacher, creator, admin, owner) sees the workspace and its people, and never
 * their own completion percentage — that number is meaningless for someone who
 * runs the workspace rather than studies in it. A platform owner leads with the
 * client portfolio instead of one tenant's course list.
 *
 * Honesty rule, inherited from the insights panel: the analytics RPCs are not
 * applied to every database yet. When they do not answer, this surface says so
 * and shows nothing in their place — never a zero standing in for a number the
 * platform could not measure.
 */
export function HomeSection({
  payload,
  accountName,
}: {
  payload: ShellPayload;
  accountName: string;
}) {
  const { params } = usePanelRouter();

  const status = params.get("status") ?? "";
  const error = params.get("error") ?? "";

  const notices = (
    <>
      {statusMessages[status] ? (
        <p className={styles.notice} role="status">
          {statusMessages[status]}
        </p>
      ) : null}
      {errorMessages[error] ? (
        <p className={styles.alert} role="alert">
          {errorMessages[error]}
        </p>
      ) : null}
    </>
  );

  if (payload.role === "learner") {
    return (
      <div className={styles.page}>
        {notices}
        <LearnerHome accountName={accountName} payload={payload} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {notices}
      <OperatorHome accountName={accountName} payload={payload} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

function count(value: number) {
  return value.toLocaleString();
}

function plural(value: number, singular: string, pluralForm?: string) {
  return value === 1 ? singular : (pluralForm ?? `${singular}s`);
}

function formatDay(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function formatMoment(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

/**
 * A panel entry point that is a real link: right-clickable, shareable, and
 * keyboard reachable. Renders nothing when the tenant has the section disabled,
 * so this surface can never point at a panel the shell will not open.
 */
function PanelLink({
  payload,
  panel,
  extra,
  children,
  variant = "secondary",
  className,
}: {
  payload: ShellPayload;
  panel: PanelKey;
  extra?: Record<string, string> | undefined;
  children: ReactNode;
  variant?: "primary" | "secondary" | "quiet" | undefined;
  className?: string | undefined;
}) {
  const { panelHref, openPanel } = usePanelRouter();
  if (payload.sections[panel] !== true) return null;

  const variantClass =
    variant === "primary"
      ? styles.linkPrimary
      : variant === "quiet"
        ? styles.linkQuiet
        : styles.linkSecondary;

  return (
    <a
      className={cx(styles.link, variantClass, className)}
      href={panelHref(panel, extra)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        openPanel(panel, extra);
      }}
    >
      {children}
    </a>
  );
}

function QuickAction({
  payload,
  panel,
  extra,
  title,
  description,
}: {
  payload: ShellPayload;
  panel: PanelKey;
  extra?: Record<string, string> | undefined;
  title: string;
  description: string;
}) {
  const { panelHref, openPanel } = usePanelRouter();
  if (payload.sections[panel] !== true) return null;

  return (
    <a
      className={styles.quickAction}
      href={panelHref(panel, extra)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        openPanel(panel, extra);
      }}
    >
      <span className={styles.quickTitle}>
        {title}
        <span aria-hidden="true">→</span>
      </span>
      <span className={styles.quickCopy}>{description}</span>
    </a>
  );
}

function SectionHead({
  eyebrow,
  title,
  lede,
  aside,
  id,
}: {
  eyebrow: string;
  title: string;
  lede?: string | undefined;
  aside?: ReactNode | undefined;
  id?: string | undefined;
}) {
  return (
    <div className={styles.sectionHead}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h2 className={styles.sectionTitle} id={id}>
          {title}
        </h2>
        {lede === undefined ? null : <p className={styles.lede}>{lede}</p>}
      </div>
      {aside === undefined ? null : (
        <div className={styles.sectionAside}>{aside}</div>
      )}
    </div>
  );
}

/** Draft / published pill. Deliberately not a StateBadge: that badge reports
 *  data provenance (known / unknown), not editorial status. */
function StatusPill({ status }: { status: string }) {
  const live = status === "published";
  return (
    <span className={cx(styles.pill, live ? styles.pillLive : styles.pillDraft)}>
      {live ? "Published" : status === "" ? "Draft" : status}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Workspace facts — everything derivable today, with no new RPC
 * ------------------------------------------------------------------ */

type CourseFacts = {
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  isPublished: boolean;
  modules: number;
  emptyModules: number;
  lessons: number;
  publishedLessons: number;
  lessonsWithoutContent: number;
  citableLessons: number;
};

type WorkspaceFacts = {
  courses: CourseFacts[];
  published: CourseFacts[];
  drafts: CourseFacts[];
  modules: number;
  emptyModules: number;
  lessons: number;
  publishedLessons: number;
  lessonsWithoutContent: number;
  /** Published lessons carrying at least one content block, inside a published
   *  course: the material the assistant can actually answer from. */
  citableLessons: number;
};

function readCourse(course: LearningCourse): CourseFacts {
  const lessons = course.modules.flatMap((module) => module.lessons);
  const isPublished = course.status === "published";
  return {
    courseId: course.courseId,
    title: course.title,
    description: course.description,
    status: course.status,
    isPublished,
    modules: course.modules.length,
    emptyModules: course.modules.filter((module) => module.lessons.length === 0)
      .length,
    lessons: lessons.length,
    publishedLessons: lessons.filter((lesson) => lesson.status === "published")
      .length,
    lessonsWithoutContent: lessons.filter((lesson) => lesson.blocks.length === 0)
      .length,
    citableLessons: isPublished
      ? lessons.filter(
          (lesson) => lesson.status === "published" && lesson.blocks.length > 0,
        ).length
      : 0,
  };
}

function readWorkspaceFacts(courses: readonly LearningCourse[]): WorkspaceFacts {
  const facts = courses.map(readCourse);
  const sum = (pick: (course: CourseFacts) => number) =>
    facts.reduce((running, course) => running + pick(course), 0);

  return {
    courses: facts,
    published: facts.filter((course) => course.isPublished),
    drafts: facts.filter((course) => !course.isPublished),
    modules: sum((course) => course.modules),
    emptyModules: sum((course) => course.emptyModules),
    lessons: sum((course) => course.lessons),
    publishedLessons: sum((course) => course.publishedLessons),
    lessonsWithoutContent: sum((course) => course.lessonsWithoutContent),
    citableLessons: sum((course) => course.citableLessons),
  };
}

type AttentionItem = {
  id: string;
  headline: string;
  detail: string;
  /** Deep link into the course panel for the first affected course. */
  courseId: string | null;
  actionLabel: string;
  severity: "blocking" | "open";
};

/**
 * Derived entirely from the workspace payload — no analytics RPC involved, so
 * these are true even on a database where the analytics migration is pending.
 */
function readAttention(
  facts: WorkspaceFacts,
  assistantName: string,
  canAuthor: boolean,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  const publishedEmpty = facts.published.filter(
    (course) => course.publishedLessons === 0,
  );
  if (publishedEmpty.length > 0) {
    const first = publishedEmpty[0];
    items.push({
      id: "published-empty",
      severity: "blocking",
      headline: `${count(publishedEmpty.length)} published ${plural(
        publishedEmpty.length,
        "course has",
        "courses have",
      )} no published lesson`,
      detail: `Learners can open ${
        publishedEmpty.length === 1 ? "it" : "them"
      } and find nothing to read. Publish a lesson, or return the course to draft.`,
      courseId: first?.courseId ?? null,
      actionLabel: publishedEmpty.length === 1 ? `Open ${first?.title ?? "course"}` : "Open the first one",
    });
  }

  const emptyCourses = facts.courses.filter((course) => course.lessons === 0);
  if (emptyCourses.length > 0) {
    const first = emptyCourses[0];
    items.push({
      id: "courses-without-lessons",
      severity: "blocking",
      headline: `${count(emptyCourses.length)} ${plural(
        emptyCourses.length,
        "course",
      )} ${plural(emptyCourses.length, "has", "have")} no lesson at all`,
      detail: `A course with no lesson has nothing to teach and nothing for ${assistantName} to cite.`,
      courseId: first?.courseId ?? null,
      actionLabel: !canAuthor
        ? "Open the course"
        : emptyCourses.length === 1
          ? `Add a lesson to ${first?.title ?? "it"}`
          : "Add the first lesson",
    });
  }

  if (facts.lessonsWithoutContent > 0) {
    const first = facts.courses.find(
      (course) => course.lessonsWithoutContent > 0,
    );
    items.push({
      id: "lessons-without-content",
      severity: "open",
      headline: `${count(facts.lessonsWithoutContent)} ${plural(
        facts.lessonsWithoutContent,
        "lesson",
      )} ${plural(
        facts.lessonsWithoutContent,
        "carries",
        "carry",
      )} no content block`,
      detail: `An empty lesson cannot be read and cannot be quoted back by ${assistantName}.`,
      courseId: first?.courseId ?? null,
      actionLabel: first === undefined ? "Open learning" : `Open ${first.title}`,
    });
  }

  if (facts.drafts.length > 0) {
    const first = facts.drafts[0];
    items.push({
      id: "drafts",
      severity: "open",
      headline: `${count(facts.drafts.length)} ${plural(
        facts.drafts.length,
        "course is",
        "courses are",
      )} still ${plural(facts.drafts.length, "a draft", "drafts")}`,
      detail: `A draft is invisible to learners and outside ${assistantName}'s grounding. Publish when the lessons are ready.`,
      courseId: first?.courseId ?? null,
      actionLabel:
        facts.drafts.length === 1
          ? `${canAuthor ? "Review" : "Open"} ${first?.title ?? "the draft"}`
          : `${canAuthor ? "Review" : "Open"} the first draft`,
    });
  }

  if (facts.emptyModules > 0) {
    const first = facts.courses.find((course) => course.emptyModules > 0);
    items.push({
      id: "empty-modules",
      severity: "open",
      headline: `${count(facts.emptyModules)} ${plural(
        facts.emptyModules,
        "module",
      )} ${plural(facts.emptyModules, "contains", "contain")} no lesson`,
      detail:
        "An empty module shows up in the outline but leads nowhere for a learner.",
      courseId: first?.courseId ?? null,
      actionLabel: first === undefined ? "Open learning" : `Open ${first.title}`,
    });
  }

  return items;
}

/* ------------------------------------------------------------------ *
 * Analytics transport — degrades honestly when the RPCs are not applied
 * ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_DAYS = 30;

type ActivitySnapshot = {
  overview: AnalyticsTenantOverview;
  distribution: AnalyticsQuestionDistribution;
  answerQuality: AnalyticsAnswerQuality;
  progress: AnalyticsLearnerProgress;
  questionLabels: AnalyticsQuestionLabels | null;
  /** Null when the signals read failed — never an empty list standing in. */
  signals: AnalyticsSignals | null;
};

type ActivityFailure = "unavailable" | "denied" | "authentication" | "unverifiable";

const activityFailureCopy: Record<
  ActivityFailure,
  { headline: string; description: string }
> = {
  unavailable: {
    headline: "Learner activity is not available yet",
    description:
      "The durable analytics functions did not answer. That is expected until the learning analytics migration has been applied to this project's database. No sample, estimated or zero-filled figures are shown in their place.",
  },
  denied: {
    headline: "Learner activity is restricted for this role",
    description:
      "Your role is not permitted to read tenant analytics. Nothing is substituted for the figures you cannot see.",
  },
  authentication: {
    headline: "Sign in again to read learner activity",
    description:
      "The session could not be verified for this request. Reload the console and sign in to continue.",
  },
  unverifiable: {
    headline: "The analytics response could not be verified",
    description:
      "The service replied with a payload this console cannot confirm is a durable analytics envelope, so none of it is displayed.",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toActivityFailure(error: unknown): ActivityFailure {
  if (error instanceof AnalyticsRpcError) {
    if (error.code === "denied" || error.code === "access_denied") {
      return "denied";
    }
    if (
      error.code === "authentication" ||
      error.code === "authentication_required"
    ) {
      return "authentication";
    }
    if (error.code === "unverifiable" || error.code === "invalid_response") {
      return "unverifiable";
    }
  }
  return "unavailable";
}

async function loadActivity(days: number): Promise<ActivitySnapshot> {
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
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new AnalyticsRpcError("request_failed");
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
    if (response.status === 403 || code === "access_denied") {
      throw new AnalyticsRpcError("denied");
    }
    if (response.status === 401 || code === "authentication_required") {
      throw new AnalyticsRpcError("authentication");
    }
    throw new AnalyticsRpcError("unavailable");
  }
  if (!isRecord(body) || body.ok !== true) {
    throw new AnalyticsRpcError("unverifiable");
  }

  /*
   * One request, both halves of it.
   *
   * This response has always carried `signals` alongside `labels`, and Home
   * parsed the labels and dropped the signals on the floor — which is why the
   * surface that is supposed to say "here is what is worth acting on" never
   * mentioned a single detected signal. Nothing new is fetched here; the
   * payload is simply no longer half-read.
   *
   * The two are parsed independently so a malformed half cannot take the
   * other down, and each falls to null rather than to an empty value: an
   * empty list would read as "nothing detected", which is a claim, while null
   * renders as "not known".
   */
  const intelligence = await fetch(
    `/api/analytics/question-intelligence?${query.toString()}`,
    {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    },
  )
    .then(async (intelligenceResponse) => {
      if (!intelligenceResponse.ok) return null;
      const intelligenceBody: unknown = await intelligenceResponse
        .json()
        .catch(() => null);
      if (!isRecord(intelligenceBody) || intelligenceBody.ok !== true) {
        return null;
      }
      let labels: AnalyticsQuestionLabels | null = null;
      let signals: AnalyticsSignals | null = null;
      try {
        labels = parseAnalyticsQuestionLabels(intelligenceBody.labels);
      } catch {
        labels = null;
      }
      try {
        signals = parseAnalyticsSignals(intelligenceBody.signals);
      } catch {
        signals = null;
      }
      return { labels, signals };
    })
    .catch(() => null);
  const questionLabels = intelligence?.labels ?? null;
  const detectedSignals = intelligence?.signals ?? null;

  return {
    overview: parseAnalyticsTenantOverview(body.overview),
    distribution: parseAnalyticsQuestionDistribution(body.distribution),
    answerQuality: parseAnalyticsAnswerQuality(body.answerQuality),
    progress: parseAnalyticsLearnerProgress(body.learnerProgress),
    questionLabels,
    signals: detectedSignals,
  };
}

type ActivityState =
  | { status: "loading" }
  | { status: "ready"; snapshot: ActivitySnapshot }
  | { status: "failed"; failure: ActivityFailure };

function useActivity(): ActivityState {
  const dataVersion = useDataVersion();
  const [state, setState] = useState<ActivityState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    loadActivity(ACTIVITY_DAYS)
      .then((snapshot) => {
        if (active) setState({ status: "ready", snapshot });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ status: "failed", failure: toActivityFailure(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [dataVersion]);

  return state;
}

/* ------------------------------------------------------------------ *
 * "Dismiss for a week" — a local, non-authoritative snooze
 * ------------------------------------------------------------------ */

const ONE_THING_DISMISS_MS = 7 * DAY_MS;

/** Scoped per tenant so a platform owner moving between client workspaces
 *  never has one tenant's dismissal hide a different tenant's attention item. */
function oneThingDismissKey(tenantId: string): string {
  return `corso.console.home.oneThingDismissedUntil.${tenantId}`;
}

function readOneThingDismissedUntil(tenantId: string): number | null {
  try {
    const raw = window.localStorage.getItem(oneThingDismissKey(tenantId));
    if (raw === null) return null;
    const until = Number(raw);
    return Number.isFinite(until) ? until : null;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts —
    // fall through to "not dismissed" rather than throwing.
    return null;
  }
}

function writeOneThingDismissedUntil(tenantId: string, until: number) {
  try {
    window.localStorage.setItem(oneThingDismissKey(tenantId), String(until));
  } catch {
    // The dismissal still applies for the rest of this session via React
    // state even when it cannot be persisted.
  }
}

/* ------------------------------------------------------------------ *
 * Operator canvas — teacher, creator, tenant admin, tenant owner
 * ------------------------------------------------------------------ */

function OperatorHome({
  payload,
  accountName,
}: {
  payload: ShellPayload;
  accountName: string;
}) {
  const workspace = asWorkspace(payload);
  const courses = useMemo(() => workspace?.courses ?? [], [workspace]);
  const facts = useMemo(() => readWorkspaceFacts(courses), [courses]);
  const assistantName = payload.agent.assistantName;
  const canAuthor = workspace?.identity.canAuthor === true;
  const attention = useMemo(
    () => readAttention(facts, assistantName, canAuthor),
    [facts, assistantName, canAuthor],
  );

  const tenantName = payload.tenant.displayName;
  const rawFirstName =
    accountName.trim().split(/\s+/u).filter(Boolean)[0] ?? accountName;
  const firstName =
    rawFirstName.length === 0
      ? "there"
      : rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1);
  const primaryAttention = attention[0] ?? null;
  const tenantId = payload.tenant.tenantId;
  const [dismissedUntil, setDismissedUntil] = useState<number | null>(null);
  useEffect(() => {
    setDismissedUntil(readOneThingDismissedUntil(tenantId));
  }, [tenantId]);
  const oneThingDismissed =
    dismissedUntil !== null && dismissedUntil > Date.now();
  const dismissOneThingForAWeek = () => {
    const until = Date.now() + ONE_THING_DISMISS_MS;
    writeOneThingDismissedUntil(tenantId, until);
    setDismissedUntil(until);
  };
  const activity = useActivity();
  const volume =
    activity.status === "ready"
      ? activity.snapshot.overview.metrics.questionVolume
      : null;
  const quality =
    activity.status === "ready"
      ? activity.snapshot.answerQuality.metrics.groundingCoverage
      : null;
  const summary =
    volume !== null && volume.state !== "unknown"
      ? `${assistantName} answered ${count(
          volume.value.totalQuestions,
        )} ${plural(volume.value.totalQuestions, "question")} in the last ${
          ACTIVITY_DAYS
        } days${
          quality !== null && quality.state !== "unknown"
            ? ` and refused ${count(quality.value.ungroundedAnswers)} safely.`
            : "."
        }`
      : facts.citableLessons === 0
        ? `${assistantName} has nothing published to answer from yet.`
        : `${assistantName} can answer from ${count(
            facts.citableLessons,
          )} published ${plural(facts.citableLessons, "lesson")}.`;

  return (
    <>
      <section className={styles.welcome}>
        <h1 className={styles.heroTitle}>Good morning, {firstName}</h1>
        <p className={styles.heroLede}>{summary}</p>
      </section>

      {oneThingDismissed ? null : (
        <section className={styles.oneThing} aria-labelledby="home-one-thing">
          <p className={styles.heroEyebrow}>Today&apos;s one thing</p>
          <h2 id="home-one-thing">
            {primaryAttention?.headline ??
              (facts.citableLessons === 0
                ? `Publish the first lesson ${assistantName} can use`
                : "Everything published is ready for students")}
          </h2>
          <p>
            {primaryAttention?.detail ??
              (facts.citableLessons === 0
                ? "The assistant refuses rather than inventing an answer. One published lesson gives it a safe place to start."
                : "There are no structural gaps in the course right now. Review real student questions for the next opportunity.")}
          </p>
          <div className={styles.heroActions}>
            <PanelLink
              extra={
                primaryAttention?.courseId
                  ? { id: primaryAttention.courseId }
                  : facts.courses.length === 0 && canAuthor
                    ? { intent: "create" }
                    : undefined
              }
              panel="course"
              payload={payload}
              variant="primary"
            >
              {primaryAttention?.actionLabel ??
                (facts.courses.length === 0 && canAuthor
                  ? "Create the first course"
                  : "Open Learning")}
            </PanelLink>
            <PanelLink
              extra={{ view: "insights" }}
              panel="insights"
              payload={payload}
            >
              Read what they asked
            </PanelLink>
            <button
              className={styles.dismissAction}
              onClick={dismissOneThingForAWeek}
              type="button"
            >
              Dismiss for a week
            </button>
          </div>
        </section>
      )}

      <OperatorActivityGrid activity={activity} payload={payload} />

      <section aria-labelledby="home-courses" className={styles.courseSummary}>
        <div className={styles.courseSummaryHead}>
          <h2 id="home-courses">Your course</h2>
          <PanelLink panel="course" payload={payload} variant="quiet">
            Open Learning <span aria-hidden="true">›</span>
          </PanelLink>
        </div>

        {facts.courses.length === 0 ? (
          <EmptyState
            action={
              canAuthor ? (
                <PanelLink
                  extra={{ intent: "create" }}
                  panel="course"
                  payload={payload}
                  variant="primary"
                >
                  Create the first course
                </PanelLink>
              ) : undefined
            }
            description={`Nothing has been authored in ${tenantName} yet. The first course is what gives ${assistantName} something to answer from.`}
            headline="No course has been created yet"
          />
        ) : (
          <div className={styles.courseFacts}>
            <div className={styles.courseFact}>
              <span className={styles.factIcon} data-tone="good" aria-hidden="true">
                <svg
                  fill="none"
                  height="20"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  width="20"
                >
                  <path d="M4.5 12.5 9.5 17.5 19.5 7" />
                </svg>
              </span>
              <span>
                <strong>
                  {count(facts.publishedLessons)}{" "}
                  {plural(facts.publishedLessons, "lesson")} live
                </strong>
                <small>Everything the assistant is allowed to use.</small>
              </span>
            </div>
            <div className={styles.courseFact}>
              <span className={styles.factIcon} aria-hidden="true">
                <svg
                  fill="none"
                  height="20"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  width="20"
                >
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M12 8v4.5l3 2" />
                </svg>
              </span>
              <span>
                <strong>
                  {facts.drafts.length === 0
                    ? "Every course is published"
                    : `${count(facts.drafts.length)} ${plural(
                        facts.drafts.length,
                        "course",
                      )} not published`}
                </strong>
                <small>
                  {facts.drafts.length === 0
                    ? "Students can use every finished course."
                    : "Draft content stays outside student answers."}
                </small>
              </span>
            </div>
            <div className={styles.courseFact}>
              <span className={styles.factIcon} data-tone="muted" aria-hidden="true">
                <svg
                  fill="none"
                  height="20"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  width="20"
                >
                  <path d="M20 12a8 8 0 1 1-2.4-5.7" />
                  <path d="M20 4v4h-4" />
                </svg>
              </span>
              <span>
                <strong>
                  {count(facts.modules)} {plural(facts.modules, "module")} organized
                </strong>
                <small>
                  {facts.emptyModules === 0
                    ? "Every module contains learning."
                    : `${count(facts.emptyModules)} ${plural(
                        facts.emptyModules,
                        "module needs",
                        "modules need",
                      )} a lesson.`}
                </small>
              </span>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function OperatorActivityGrid({
  activity,
  payload,
}: {
  activity: ActivityState;
  payload: ShellPayload;
}) {
  if (activity.status === "loading") {
    return (
      <div className={styles.activityGrid}>
        <section className={styles.weekCard} aria-live="polite">
          <p className={styles.status}>Reading workspace activity…</p>
        </section>
        <section className={styles.topicCard}>
          <p className={styles.status}>Reading question topics…</p>
        </section>
      </div>
    );
  }

  if (activity.status === "failed") {
    return (
      <section className={styles.activityUnavailable}>
        <div>
          <h2>{activityFailureCopy[activity.failure].headline}</h2>
          <p>{activityFailureCopy[activity.failure].description}</p>
        </div>
        <PanelLink panel="insights" payload={payload}>
          Open insights
        </PanelLink>
      </section>
    );
  }

  const volume = activity.snapshot.overview.metrics.questionVolume;
  const learners = activity.snapshot.overview.metrics.activeLearners;
  const coverage =
    activity.snapshot.answerQuality.metrics.groundingCoverage;
  const distribution = activity.snapshot.distribution.distribution;
  const topicDistribution =
    activity.snapshot.questionLabels?.metrics.topicDistribution ?? null;
  const signalsMetric =
    activity.snapshot.signals?.metrics.detectedSignals ?? null;
  const questions =
    volume.state === "unknown" ? null : volume.value.totalQuestions;
  const people =
    learners.state === "unknown" ? null : learners.value.learners;
  const grounded =
    coverage.state === "unknown" ? null : coverage.value.groundedAnswers;
  const answers =
    coverage.state === "unknown" ? null : coverage.value.answers;
  const answerRate =
    grounded === null || answers === null || answers === 0
      ? null
      : Math.round((grounded / answers) * 100);
  const refused =
    coverage.state === "unknown" ? null : coverage.value.ungroundedAnswers;
  const recentBuckets =
    volume.state === "unknown" ? [] : volume.value.buckets.slice(-7);
  const tallest = Math.max(
    1,
    ...recentBuckets.map((bucket) => bucket.questions),
  );
  const attributedTopics =
    topicDistribution === null || topicDistribution.state === "unknown"
      ? []
      : topicDistribution.value.topics.map((topic) => ({
          id: topic.topicKey,
          label: topic.topicLabel,
          questions: topic.questions,
        }));
  const modules =
    attributedTopics.length > 0
      ? attributedTopics.slice(0, 4)
      : distribution.state === "unknown"
        ? []
        : distribution.value.courses
            .flatMap((course) =>
              course.modules.map((module) => ({
                id: module.moduleId,
                label: module.moduleTitle,
                questions: module.questions,
              })),
            )
            .sort((left, right) => right.questions - left.questions)
            .slice(0, 4);
  const topicPeak = Math.max(1, ...modules.map((module) => module.questions));

  return (
    <div className={styles.activityGrid}>
      <section className={styles.weekCard} aria-labelledby="home-week">
        <div className={styles.cardTopline}>
          <h2 id="home-week">This month</h2>
          <PanelLink
            extra={{ view: "insights" }}
            panel="insights"
            payload={payload}
            variant="quiet"
          >
            Last {ACTIVITY_DAYS} days <span aria-hidden="true">⌄</span>
          </PanelLink>
        </div>
        <div className={styles.metricRow}>
          <div>
            <strong>{questions === null ? "—" : count(questions)}</strong>
            <span>questions</span>
            <small data-tone={questions === null ? "muted" : "good"}>
              {questions === null ? "Not measured" : "Durable total"}
            </small>
          </div>
          <div>
            <strong>{people === null ? "—" : count(people)}</strong>
            <span>students</span>
            <small data-tone={people === null ? "muted" : "good"}>
              {people === null ? "Not measured" : "Active learners"}
            </small>
          </div>
          <div>
            <strong>{answerRate === null ? "—" : `${answerRate}%`}</strong>
            <span>grounded</span>
            {/* Refusal count is a neutral fact, not a positive delta like the
                two captions above it — it stays muted even when known. */}
            <small data-tone="muted">
              {refused === null
                ? "Not measured"
                : `${count(refused)} safely refused`}
            </small>
          </div>
        </div>
        {recentBuckets.length > 0 ? (
          <>
            <div
              aria-label="Questions over the last seven recorded days"
              className={styles.miniBars}
            >
              {recentBuckets.map((bucket, index) => (
                <i
                  data-current={
                    index >= Math.max(0, recentBuckets.length - 2) || undefined
                  }
                  key={bucket.bucketStart}
                  style={{
                    height: `${Math.max(
                      10,
                      Math.round((bucket.questions / tallest) * 100),
                    )}%`,
                  }}
                  title={`${formatDay(bucket.bucketStart) ?? bucket.bucketStart}: ${count(
                    bucket.questions,
                  )} questions`}
                />
              ))}
            </div>
            <div className={styles.barLabels}>
              <span>{formatDay(recentBuckets[0]?.bucketStart) ?? "Start"}</span>
              <span>
                {formatDay(recentBuckets[recentBuckets.length - 1]?.bucketStart) ??
                  "Latest"}
              </span>
            </div>
          </>
        ) : (
          <p className={styles.noChart}>No recorded questions in this range.</p>
        )}
      </section>

      <section className={styles.topicCard} aria-labelledby="home-topics">
        <h2 id="home-topics">What they asked about</h2>
        {modules.length > 0 ? (
          <div className={styles.topicList}>
            {modules.map((module) => (
              <div className={styles.topic} key={module.id}>
                <div>
                  <span>{module.label}</span>
                  <span>{count(module.questions)}</span>
                </div>
                <i>
                  <span
                    style={{
                      width: `${Math.max(
                        7,
                        Math.round((module.questions / topicPeak) * 100),
                      )}%`,
                    }}
                  />
                </i>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.noTopics}>
            Topic attribution is not available for this range yet.
          </p>
        )}
        <PanelLink
          className={styles.topicLink}
          extra={{ view: "insights" }}
          panel="insights"
          payload={payload}
          variant="quiet"
        >
          See every question <span aria-hidden="true">›</span>
        </PanelLink>
      </section>
      {/*
        * Signals — the half of this response Home used to discard.
        *
        * Three states are kept apart on purpose, because collapsing them is
        * how a surface starts lying: a failed read says "not known", a
        * successful read with nothing detected says WHY (the RPC ships that
        * sentence, and it is usually "no question in this range carries a
        * recorded classification"), and a real detection is listed. An empty
        * list is never rendered as reassurance.
        */}
      <section className={styles.topicCard} aria-labelledby="home-signals">
        <h2 id="home-signals">Worth acting on</h2>
        {signalsMetric === null ? (
          <p className={styles.noTopics}>
            Signals are not known for this range — the read did not complete.
          </p>
        ) : signalsMetric.state === "unknown" ? (
          <p className={styles.noTopics}>
            {signalsMetric.limitations.length > 0
              ? signalsMetric.limitations[0]
              : "Signals are not known for this range."}
          </p>
        ) : signalsMetric.value.signals.length === 0 ? (
          <p className={styles.noTopics}>
            {signalsMetric.limitations.length > 0
              ? signalsMetric.limitations[0]
              : "Nothing in this range met a detection threshold."}
          </p>
        ) : (
          <div className={styles.topics}>
            {signalsMetric.value.signals.slice(0, 3).map((signal) => (
              <div className={styles.topic} key={signal.signalFingerprint}>
                <div>
                  <span>{signal.headline}</span>
                  <span>{signal.severity}</span>
                </div>
                <small>{signal.detail}</small>
              </div>
            ))}
          </div>
        )}
        <PanelLink
          className={styles.topicLink}
          extra={{ view: "signals" }}
          panel="insights"
          payload={payload}
          variant="quiet"
        >
          See every signal <span aria-hidden="true">›</span>
        </PanelLink>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Learner activity — the analytics-backed half of the operator canvas
 * ------------------------------------------------------------------ */

function ActivitySection({ payload }: { payload: ShellPayload }) {
  const state = useActivity();

  return (
    <section aria-labelledby="home-activity" className={styles.section}>
      <SectionHead
        eyebrow="Learner activity"
        id="home-activity"
        lede={`Who has been learning in the last ${ACTIVITY_DAYS} days, and who has stopped. Every figure here comes from a tenant-scoped analytics function — none of it is computed in the browser.`}
        title="Your people"
        aside={
          state.status === "failed" ? (
            <StateBadge state="unknown">Not available</StateBadge>
          ) : undefined
        }
      />

      {state.status === "loading" ? (
        <p className={styles.status} role="status">
          Reading learner activity for the last {ACTIVITY_DAYS} days…
        </p>
      ) : state.status === "failed" ? (
        <EmptyState
          action={
            <PanelLink panel="insights" payload={payload} variant="secondary">
              Open insights
            </PanelLink>
          }
          description={activityFailureCopy[state.failure].description}
          headline={activityFailureCopy[state.failure].headline}
          tone={state.failure === "denied" ? "restricted" : "error"}
        />
      ) : (
        <ActivityFigures payload={payload} snapshot={state.snapshot} />
      )}
    </section>
  );
}

function ActivityFigures({
  snapshot,
  payload,
}: {
  snapshot: ActivitySnapshot;
  payload: ShellPayload;
}) {
  const learners = snapshot.overview.metrics.activeLearners;
  const volume = snapshot.overview.metrics.questionVolume;
  const funnel = snapshot.progress.metrics.courseFunnel;

  const funnelCourses = funnel.state === "unknown" ? [] : funnel.value.courses;
  const totalWithProgress = funnelCourses.reduce(
    (running, course) => running + course.learnersWithProgress,
    0,
  );
  const totalStalled = funnelCourses.reduce(
    (running, course) => running + course.stalledLearners,
    0,
  );
  const totalCompleted = funnelCourses.reduce(
    (running, course) => running + course.learnersCompleted,
    0,
  );
  const totalStarted = funnelCourses.reduce(
    (running, course) => running + course.learnersStarted,
    0,
  );

  const buckets = volume.state === "unknown" ? [] : volume.value.buckets;
  const learnerPoints: TrendPoint[] = buckets.map((bucket) => ({
    label: formatDay(bucket.bucketStart) ?? bucket.bucketStart,
    value: bucket.activeLearners,
  }));

  const progressItems: DistributionItem[] = funnelCourses.map((course) => ({
    id: course.courseId,
    label: course.courseTitle,
    value: course.learnersStarted,
    sublabel: [
      `${count(course.learnersCompleted)} completed`,
      `${count(course.learnersInProgress)} in progress`,
      course.stalledLearners > 0
        ? `${count(course.stalledLearners)} stalled`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  }));

  const asOf = formatMoment(snapshot.overview.generatedAt);

  return (
    <>
      <div className={styles.tiles}>
        {learners.state === "unknown" ? (
          <StatTile
            eyebrow={`Last ${ACTIVITY_DAYS} days`}
            label="People learning"
            reason={
              learners.limitations[0] ??
              "The platform did not report active learners for this range."
            }
            state="unknown"
          />
        ) : (
          <StatTile
            asOf={asOf ?? undefined}
            eyebrow={`Last ${ACTIVITY_DAYS} days`}
            label="People learning"
            state={learners.state}
            sublabel="Distinct learners who asked the assistant at least one question"
            value={count(learners.value.learners)}
          />
        )}

        {volume.state === "unknown" ? (
          <StatTile
            eyebrow={`Last ${ACTIVITY_DAYS} days`}
            label="Questions asked"
            reason={
              volume.limitations[0] ??
              "The platform did not report question volume for this range."
            }
            state="unknown"
          />
        ) : (
          <StatTile
            eyebrow={`Last ${ACTIVITY_DAYS} days`}
            label="Questions asked"
            state={volume.state}
            sublabel={`${count(volume.value.activeConversations)} ${plural(
              volume.value.activeConversations,
              "conversation",
            )} · last on ${
              formatMoment(volume.value.lastQuestionAt) ?? "no recorded date"
            }`}
            value={count(volume.value.totalQuestions)}
          />
        )}

        {funnel.state === "unknown" ? (
          <StatTile
            eyebrow="Across all courses"
            label="Learners making progress"
            reason={
              funnel.limitations[0] ??
              "The platform did not report a course funnel for this workspace."
            }
            state="unknown"
          />
        ) : (
          <StatTile
            eyebrow="Across all courses"
            label="Learners making progress"
            state={funnel.state}
            sublabel={`${count(totalStarted)} started · ${count(
              totalCompleted,
            )} completed`}
            value={count(totalWithProgress)}
          />
        )}

        {funnel.state === "unknown" ? (
          <StatTile
            eyebrow="Needs a nudge"
            label="Stalled learners"
            reason={
              funnel.limitations[0] ??
              "The platform did not report a course funnel for this workspace."
            }
            state="unknown"
          />
        ) : (
          <StatTile
            eyebrow="Needs a nudge"
            footnote={`In progress or blocked with no recorded activity for over ${count(
              snapshot.progress.stalledThresholdDays,
            )} days.`}
            label="Stalled learners"
            state={funnel.state}
            sublabel={
              totalStalled === 0
                ? "Nobody has gone quiet mid-course"
                : `${count(totalStalled)} of ${count(
                    totalWithProgress,
                  )} learners with progress`
            }
            value={count(totalStalled)}
          />
        )}
      </div>

      {learnerPoints.length > 0 ? (
        <TrendChart
          ariaLabel={`Active learners per day over the last ${ACTIVITY_DAYS} days`}
          caption="Active learners per day"
          points={learnerPoints}
        />
      ) : null}

      {progressItems.length === 0 ? (
        <EmptyState
          compact
          description="No learner has a recorded progress row for any course in this workspace. Rows appear as soon as someone opens a published lesson."
          headline="No learner progress recorded yet"
        />
      ) : (
        <DistributionBar
          ariaLabel="Learners started, by course"
          caption="Learners started, by course"
          items={progressItems}
          maxItems={6}
          total={totalStarted}
        />
      )}

      <div className={styles.sectionFoot}>
        <PanelLink panel="insights" payload={payload} variant="quiet">
          All insights <span aria-hidden="true">→</span>
        </PanelLink>
        <PanelLink panel="people" payload={payload} variant="quiet">
          Manage people <span aria-hidden="true">→</span>
        </PanelLink>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Platform owner canvas — the client portfolio leads
 * ------------------------------------------------------------------ */

type PortfolioState =
  | { status: "loading" }
  | { status: "ready"; overview: PlatformOverview }
  | { status: "failed"; message: string };

function PlatformHome({
  payload,
  accountName,
}: {
  payload: ShellPayload;
  accountName: string;
}) {
  const dataVersion = useDataVersion();
  const [state, setState] = useState<PortfolioState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch("/api/platform", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const body: unknown = await response.json().catch(() => null);
        const overview = parsePlatformOverview(body);
        if (active) setState({ status: "ready", overview });
      } catch (error: unknown) {
        if (!active) return;
        setState({
          status: "failed",
          message:
            error instanceof PlatformRpcError && error.code === "access_denied"
              ? "This account is not authorized to read the client portfolio."
              : "The platform control plane did not answer, so no portfolio figures are shown. Nothing is estimated in their place.",
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [dataVersion]);

  const tenants = state.status === "ready" ? state.overview.tenants : [];
  const totals = state.status === "ready" ? state.overview.totals : null;

  const clientItems: DistributionItem[] = tenants.map((tenant) => ({
    id: tenant.tenantId,
    label: tenant.displayName,
    value: tenant.publishedCourses,
    sublabel: [
      `${count(tenant.members)} ${plural(tenant.members, "member")}`,
      `${count(tenant.courses)} ${plural(tenant.courses, "course")}`,
      tenant.status === "active" ? null : tenant.status,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    emphasis: tenant.tenantId === payload.tenant.tenantId,
  }));

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.heroEyebrow}>Platform owner · Client portfolio</p>
          <h1 className={styles.heroTitle}>
            {totals === null
              ? "Every client workspace, in one place."
              : `${count(totals.activeTenants)} of ${count(
                  totals.tenants,
                )} client ${plural(
                  totals.tenants,
                  "workspace is",
                  "workspaces are",
                )} active.`}
          </h1>
          <p className={styles.heroLede}>
            {totals === null
              ? "Client entry, section access and workspace status all live in the platform panel."
              : `${count(totals.courses)} ${plural(
                  totals.courses,
                  "course",
                )} and ${count(totals.members)} ${plural(
                  totals.members,
                  "member",
                )} across the portfolio.${
                  payload.tenant.tenantId
                    ? ` You are currently working inside ${payload.tenant.displayName}.`
                    : " No client workspace is selected."
                }`}
          </p>
          <p className={styles.heroSigned}>Signed in as {accountName}</p>
          <div className={styles.heroActions}>
            <PanelLink panel="platform" payload={payload} variant="primary">
              Open the client portfolio <span aria-hidden="true">→</span>
            </PanelLink>
            <PanelLink panel="course" payload={payload}>
              Learning in {payload.tenant.displayName}
            </PanelLink>
            <PanelLink panel="insights" payload={payload} variant="quiet">
              See insights
            </PanelLink>
          </div>
        </div>

        <aside className={styles.heroPanel} aria-label="Portfolio totals">
          <p className={styles.heroPanelLabel}>Knowledge indexed</p>
          {totals === null ? (
            <p className={styles.heroPanelAbsent}>
              {state.status === "loading" ? "Loading…" : "Not available"}
            </p>
          ) : (
            <p className={styles.heroPanelValue}>
              {count(totals.knowledgeChunks)}
              <span>{plural(totals.knowledgeChunks, "chunk")}</span>
            </p>
          )}
          <p className={styles.heroPanelFoot}>
            {totals === null
              ? state.status === "loading"
                ? "Reading portfolio totals from the platform control plane."
                : "The platform control plane did not answer, so no total is shown here."
              : `${count(totals.sources)} ${plural(
                  totals.sources,
                  "source",
                )} ingested across ${count(totals.tenants)} ${plural(
                  totals.tenants,
                  "client",
                )}.`}
          </p>
        </aside>
      </section>

      <section aria-labelledby="home-clients" className={styles.section}>
        <SectionHead
          eyebrow="Clients"
          id="home-clients"
          lede="Published courses per client workspace, from the platform control plane."
          title="Where the learning is live"
        />

        {state.status === "loading" ? (
          <p className={styles.status} role="status">
            Reading the client portfolio…
          </p>
        ) : state.status === "failed" ? (
          <EmptyState
            action={
              <PanelLink panel="platform" payload={payload}>
                Open the platform panel
              </PanelLink>
            }
            description={state.message}
            headline="The client portfolio is not available"
            tone="error"
          />
        ) : (
          <>
            <div className={styles.tiles}>
              <StatTile
                eyebrow="Portfolio"
                label="Client workspaces"
                sublabel={`${count(
                  state.overview.totals.activeTenants,
                )} active`}
                value={count(state.overview.totals.tenants)}
              />
              <StatTile
                eyebrow="Portfolio"
                label="Courses"
                sublabel={`${count(
                  tenants.reduce(
                    (running, tenant) => running + tenant.publishedCourses,
                    0,
                  ),
                )} published`}
                value={count(state.overview.totals.courses)}
              />
              <StatTile
                eyebrow="Portfolio"
                label="Members"
                sublabel="People with access to a client workspace"
                value={count(state.overview.totals.members)}
              />
            </div>

            <DistributionBar
              ariaLabel="Published courses by client workspace"
              caption="Published courses by client"
              emptyMessage="No client workspace has published a course yet."
              items={clientItems}
              maxItems={8}
            />
          </>
        )}
      </section>

      <section aria-labelledby="home-platform-actions" className={styles.section}>
        <SectionHead
          eyebrow="Quick actions"
          id="home-platform-actions"
          title="Go straight to the work"
        />
        <div className={styles.quickGrid}>
          <QuickAction
            description="Enter a client workspace, set section access, change status."
            panel="platform"
            payload={payload}
            title="Client portfolio"
          />
          <QuickAction
            description="Questions, grounding coverage and the completion funnel for the workspace you are in."
            panel="insights"
            payload={payload}
            title="See insights"
          />
          <QuickAction
            description="Author modules and lessons inside the current workspace."
            panel="course"
            payload={payload}
            title="Edit a course"
          />
          <QuickAction
            description="Invite people, set roles and see who has access."
            panel="people"
            payload={payload}
            title="Manage people"
          />
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Learner canvas — unchanged in substance, this copy is true for them
 * ------------------------------------------------------------------ */

function LearnerHome({
  payload,
  accountName,
}: {
  payload: ShellPayload;
  accountName: string;
}) {
  const { openPanel } = usePanelRouter();
  const workspace = asWorkspace(payload);
  const courses = workspace?.courses ?? [];
  const canAuthor = workspace?.identity.canAuthor === true;
  const assistantName = payload.agent.assistantName;

  const firstCourse = courses[0];
  const firstLesson = firstCourse?.modules
    .flatMap((module) => module.lessons)
    .find((lesson) => lesson.progressState !== "completed");

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.heroEyebrow}>
            Welcome back, {accountName} ·{" "}
            {firstCourse?.title ?? "Your learning workspace"}
          </p>
          <h1 className={styles.heroTitle}>
            {firstLesson
              ? firstLesson.title
              : firstCourse
                ? "You're all caught up."
                : "Build the first learning journey."}
          </h1>
          <p className={styles.heroLede}>
            {firstCourse?.description ??
              `${assistantName} is ready for real course material. Add the first lesson or import ${payload.tenant.displayName}'s existing library.`}
          </p>
          <div className={styles.heroActions}>
            {firstLesson && firstCourse ? (
              <PanelLink
                extra={{
                  id: firstCourse.courseId,
                  lessonId: firstLesson.lessonId,
                }}
                panel="course"
                payload={payload}
                variant="primary"
              >
                Continue lesson <span aria-hidden="true">→</span>
              </PanelLink>
            ) : canAuthor ? (
              <PanelLink
                extra={{ intent: "create" }}
                panel="course"
                payload={payload}
                variant="primary"
              >
                Add learning <span aria-hidden="true">→</span>
              </PanelLink>
            ) : (
              <PanelLink panel="agent" payload={payload} variant="primary">
                Ask {assistantName} <span aria-hidden="true">→</span>
              </PanelLink>
            )}
            <PanelLink panel="course" payload={payload}>
              Browse learning
            </PanelLink>
          </div>
        </div>

        <aside className={styles.heroPanel} aria-label="Course progress">
          <p className={styles.heroPanelLabel}>Course progress</p>
          <p className={styles.heroPanelValue}>
            {firstCourse
              ? `${Math.round(percent(firstCourse.progress.percentComplete))}%`
              : "—"}
            <span>{firstCourse?.title ?? "No course yet"}</span>
          </p>
          <div className={styles.progressTrack}>
            <span
              style={{
                width: `${
                  firstCourse ? percent(firstCourse.progress.percentComplete) : 0
                }%`,
              }}
            />
          </div>
          <p className={styles.heroPanelFoot}>
            {firstCourse
              ? `${firstCourse.progress.lessonsCompleted} of ${firstCourse.progress.lessonsTotal} lessons complete`
              : "No published lessons yet"}
          </p>
        </aside>
      </section>

      {payload.sections.agent === true ? (
        <button
          className={styles.assistantDock}
          onClick={() => openPanel("agent")}
          type="button"
        >
          <span className={styles.orb} aria-hidden="true" />
          <span className={styles.dockCopy}>
            <b>Ask {assistantName}</b>
            <small>Grounded in your published learning</small>
          </span>
          <span className={styles.pill}>Text or voice</span>
        </button>
      ) : null}

      <section aria-labelledby="home-my-learning" className={styles.section}>
        <SectionHead
          eyebrow="My learning"
          id="home-my-learning"
          title="Courses"
          aside={
            courses.length === 0 ? undefined : (
              <span className={styles.countChip}>
                {count(courses.length)} available
              </span>
            )
          }
        />

        {courses.length === 0 ? (
          <EmptyState
            action={
              canAuthor ? (
                <PanelLink
                  extra={{ intent: "create" }}
                  panel="course"
                  payload={payload}
                  variant="primary"
                >
                  Create the first course
                </PanelLink>
              ) : undefined
            }
            description="Your workspace is ready. Add the first lesson to begin a learning journey."
            headline="No course has been added yet."
          />
        ) : (
          <div className={styles.courseGrid}>
            {courses.map((course) => (
              <LearnerCourseCard
                course={course}
                key={course.courseId}
                payload={payload}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function LearnerCourseCard({
  course,
  payload,
}: {
  course: LearningCourse;
  payload: ShellPayload;
}) {
  const { panelHref, openPanel } = usePanelRouter();
  const complete = percent(course.progress.percentComplete);

  const body = (
    <>
      <span className={styles.cardHead}>
        <span className={styles.cardTitle}>{course.title}</span>
        <StatusPill status={course.status} />
      </span>
      <span className={styles.cardCopy}>
        {course.description ?? "No description has been written for this course."}
      </span>
      <span className={styles.progressTrack}>
        <span style={{ width: `${complete}%` }} />
      </span>
      <span className={styles.cardFacts}>
        <span>
          <b>{course.progress.lessonsCompleted}</b> of{" "}
          {course.progress.lessonsTotal} lessons · {Math.round(complete)}%
        </span>
      </span>
    </>
  );

  if (payload.sections.course !== true) {
    return <div className={styles.card}>{body}</div>;
  }

  return (
    <a
      className={cx(styles.card, styles.cardLink)}
      href={panelHref("course", { id: course.courseId })}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        openPanel("course", { id: course.courseId });
      }}
    >
      {body}
    </a>
  );
}

export default HomeSection;
