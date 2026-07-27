"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AnalyticsRpcError,
  parseAnalyticsLearnerProgress,
  parseAnalyticsTenantOverview,
  type AnalyticsLearnerProgress,
  type AnalyticsTenantOverview,
} from "../../lib/supabase/analytics-rpc";
import type { LearningCourse } from "../../lib/supabase/learning-rpc";
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

  if (payload.role === "platform_owner") {
    return (
      <div className={styles.page}>
        {notices}
        <PlatformHome accountName={accountName} payload={payload} />
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

const ROLE_LABELS: Record<ShellPayload["role"], string> = {
  learner: "Learner",
  creator: "Creator",
  teacher: "Teacher",
  tenant_admin: "Workspace admin",
  tenant_owner: "Workspace owner",
  platform_owner: "Platform owner",
};

/** Possessive form of a workspace name: "Estie" → "Estie's". */
function possessive(name: string) {
  const trimmed = name.trim();
  if (trimmed === "") return "This workspace's";
  return trimmed.endsWith("s") ? `${trimmed}'` : `${trimmed}'s`;
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
  progress: AnalyticsLearnerProgress;
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

  return {
    overview: parseAnalyticsTenantOverview(body.overview),
    progress: parseAnalyticsLearnerProgress(body.learnerProgress),
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
  const firstDraft = facts.drafts[0];

  const headline =
    facts.courses.length === 0
      ? "Nothing has been built here yet."
      : facts.citableLessons === 0
        ? `${assistantName} has nothing published to answer from.`
        : attention.length > 0
          ? `${count(facts.published.length)} ${plural(
              facts.published.length,
              "course is",
              "courses are",
            )} live — and ${count(attention.length)} ${plural(
              attention.length,
              "thing needs",
              "things need",
            )} your attention.`
          : `${count(facts.published.length)} ${plural(
              facts.published.length,
              "course is",
              "courses are",
            )} live and complete.`;

  const lede =
    facts.courses.length === 0
      ? `Create the first course and ${assistantName} will start answering from it. Nothing is published, so learners currently see an empty workspace.`
      : facts.citableLessons === 0
        ? `${count(facts.courses.length)} ${plural(
            facts.courses.length,
            "course exists",
            "courses exist",
          )}, but no published lesson carries content yet — so every answer ${assistantName} gives is ungrounded.`
        : `${count(facts.citableLessons)} published ${plural(
            facts.citableLessons,
            "lesson",
          )} across ${count(facts.published.length)} ${plural(
            facts.published.length,
            "course",
          )} ${plural(
            facts.citableLessons,
            "is",
            "are",
          )} live for learners and available to ${assistantName}.`;

  const libraryItems: DistributionItem[] = [
    {
      id: "published",
      label: "Published",
      value: facts.published.length,
      sublabel: `${count(facts.publishedLessons)} published ${plural(
        facts.publishedLessons,
        "lesson",
      )}`,
      emphasis: true,
    },
    {
      id: "draft",
      label: "Draft",
      value: facts.drafts.length,
      sublabel: "Not visible to learners",
    },
  ];

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.heroEyebrow}>
            {ROLE_LABELS[payload.role]} · {possessive(tenantName)} workspace
          </p>
          <h1 className={styles.heroTitle}>{headline}</h1>
          <p className={styles.heroLede}>{lede}</p>
          <p className={styles.heroSigned}>Signed in as {accountName}</p>
          <div className={styles.heroActions}>
            {facts.courses.length === 0 && canAuthor ? (
              <PanelLink
                extra={{ intent: "create" }}
                panel="course"
                payload={payload}
                variant="primary"
              >
                Create the first course <span aria-hidden="true">→</span>
              </PanelLink>
            ) : firstDraft !== undefined && canAuthor ? (
              <PanelLink
                extra={{ id: firstDraft.courseId }}
                panel="course"
                payload={payload}
                variant="primary"
              >
                Review {firstDraft.title} <span aria-hidden="true">→</span>
              </PanelLink>
            ) : (
              <PanelLink panel="course" payload={payload} variant="primary">
                Open learning <span aria-hidden="true">→</span>
              </PanelLink>
            )}
            <PanelLink panel="agent" payload={payload}>
              Configure {assistantName}
            </PanelLink>
            <PanelLink panel="insights" payload={payload} variant="quiet">
              See insights
            </PanelLink>
          </div>
        </div>

        <aside className={styles.heroPanel} aria-label="Course library">
          <p className={styles.heroPanelLabel}>Course library</p>
          <p className={styles.heroPanelValue}>
            {count(facts.courses.length)}
            <span>{plural(facts.courses.length, "course", "courses")}</span>
          </p>
          <DistributionBar
            ariaLabel="Courses by publication status"
            emptyMessage="No course has been created in this workspace yet."
            items={libraryItems}
            rank={false}
            total={facts.courses.length}
          />
          <p className={styles.heroPanelFoot}>
            {count(facts.modules)} {plural(facts.modules, "module")} ·{" "}
            {count(facts.lessons)} {plural(facts.lessons, "lesson")} in total
          </p>
        </aside>
      </section>

      <section aria-labelledby="home-live" className={styles.section}>
        <SectionHead
          eyebrow="What's live"
          id="home-live"
          lede="Counted from this workspace's own courses, modules and lessons. These figures do not depend on the analytics functions."
          title={`What learners can reach in ${tenantName}`}
        />
        <div className={styles.tiles}>
          <StatTile
            eyebrow="Courses"
            label="Published courses"
            sublabel={
              facts.drafts.length === 0
                ? "No course is sitting in draft"
                : `${count(facts.drafts.length)} still in draft`
            }
            value={count(facts.published.length)}
          />
          <StatTile
            eyebrow="Lessons"
            label="Published lessons"
            sublabel={`of ${count(facts.lessons)} ${plural(
              facts.lessons,
              "lesson",
            )} across ${count(facts.modules)} ${plural(facts.modules, "module")}`}
            value={count(facts.publishedLessons)}
          />
          <StatTile
            eyebrow="Assistant grounding"
            footnote={`Published lessons carrying at least one content block, inside a published course.`}
            label={`Material ${assistantName} can cite`}
            sublabel={
              facts.citableLessons === 0
                ? "Nothing published yet, so every answer is ungrounded"
                : `${count(facts.lessonsWithoutContent)} ${plural(
                    facts.lessonsWithoutContent,
                    "lesson",
                  )} still ${plural(
                    facts.lessonsWithoutContent,
                    "has",
                    "have",
                  )} no content block`
            }
            value={count(facts.citableLessons)}
          />
        </div>

        {facts.citableLessons === 0 ? (
          <EmptyState
            action={
              <PanelLink
                extra={canAuthor ? { intent: "create" } : undefined}
                panel="course"
                payload={payload}
                variant="primary"
              >
                {canAuthor ? "Create a course" : "Open learning"}
              </PanelLink>
            }
            description={`No course has been published with content yet, so ${assistantName} has nothing to answer from. Publish a lesson with at least one content block and answers become grounded in it.`}
            headline="The assistant has no grounded material"
          />
        ) : null}
      </section>

      <ActivitySection payload={payload} />

      <section aria-labelledby="home-attention" className={styles.section}>
        <SectionHead
          eyebrow="Needs attention"
          id="home-attention"
          lede="Derived from the workspace itself, so every line here is checkable in the course panel right now."
          title="What is unfinished"
          aside={
            attention.length === 0 ? undefined : (
              <span className={styles.countChip}>
                {count(attention.length)} {plural(attention.length, "item")}
              </span>
            )
          }
        />

        {attention.length === 0 ? (
          <EmptyState
            compact
            description={
              facts.courses.length === 0
                ? "There is no course yet, so there is nothing unfinished to report. That changes as soon as the first course exists."
                : "Every course is published, every module holds a lesson, and every lesson carries content."
            }
            headline="Nothing is unfinished"
          />
        ) : (
          <ul className={styles.attentionList}>
            {attention.map((item) => (
              <li
                className={cx(
                  styles.attentionItem,
                  item.severity === "blocking" && styles.attentionBlocking,
                )}
                key={item.id}
              >
                <div className={styles.attentionCopy}>
                  <p className={styles.attentionHeadline}>{item.headline}</p>
                  <p className={styles.attentionDetail}>{item.detail}</p>
                </div>
                <PanelLink
                  extra={item.courseId === null ? undefined : { id: item.courseId }}
                  panel="course"
                  payload={payload}
                  variant="quiet"
                >
                  {item.actionLabel}
                </PanelLink>
              </li>
            ))}
          </ul>
        )}

        <p className={styles.footnote}>
          Upload and ingestion state is not carried in the workspace payload, so
          stalled uploads are not listed here. Nothing on this list is inferred.
        </p>
      </section>

      <section aria-labelledby="home-courses" className={styles.section}>
        <SectionHead
          eyebrow="Library"
          id="home-courses"
          lede="Editorial state only. Learner completion lives in insights, not on an operator's home."
          title="Courses in this workspace"
          aside={
            facts.courses.length === 0 ? undefined : (
              <span className={styles.countChip}>
                {count(facts.courses.length)}{" "}
                {plural(facts.courses.length, "course")}
              </span>
            )
          }
        />

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
          <div className={styles.courseGrid}>
            {facts.courses.map((course) => (
              <CourseCard course={course} key={course.courseId} payload={payload} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="home-actions" className={styles.section}>
        <SectionHead
          eyebrow="Quick actions"
          id="home-actions"
          title="Go straight to the work"
        />
        <div className={styles.quickGrid}>
          <QuickAction
            description={
              canAuthor
                ? "Author modules and lessons, then publish when they are ready."
                : "Read the modules and lessons learners are working through."
            }
            panel="course"
            payload={payload}
            title={canAuthor ? "Edit a course" : "Open learning"}
          />
          <QuickAction
            description={`Persona, tone, voice and what ${assistantName} is allowed to answer from.`}
            panel="agent"
            payload={payload}
            title={`Configure ${assistantName}`}
          />
          <QuickAction
            description="Questions, grounding coverage and the completion funnel for this workspace."
            panel="insights"
            payload={payload}
            title="See insights"
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

function CourseCard({
  course,
  payload,
}: {
  course: CourseFacts;
  payload: ShellPayload;
}) {
  const { panelHref, openPanel } = usePanelRouter();
  const canOpen = payload.sections.course === true;

  const body = (
    <>
      <span className={styles.cardHead}>
        <span className={styles.cardTitle}>{course.title}</span>
        <StatusPill status={course.status} />
      </span>
      <span className={styles.cardCopy}>
        {course.description ?? "No description has been written for this course."}
      </span>
      <span className={styles.cardFacts}>
        <span>
          <b>{count(course.modules)}</b> {plural(course.modules, "module")}
        </span>
        <span>
          <b>{count(course.publishedLessons)}</b> of {count(course.lessons)}{" "}
          {plural(course.lessons, "lesson")} published
        </span>
        {course.lessonsWithoutContent > 0 ? (
          <span className={styles.cardWarn}>
            <b>{count(course.lessonsWithoutContent)}</b> without content
          </span>
        ) : null}
      </span>
    </>
  );

  if (!canOpen) {
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
                )} across the portfolio. You are currently working inside ${
                  payload.tenant.displayName
                }.`}
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
