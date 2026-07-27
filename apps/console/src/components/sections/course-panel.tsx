"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import UploadLearning from "../../app/app/upload-learning";
import type {
  AuthoringBlockType,
  AuthoringResult,
  CourseRevisionHistory,
  UploadProcessingState,
  UploadStateReport,
} from "../../lib/supabase/authoring-rpc";
import type {
  LearningBlock,
  LearningCourse,
  LearningLesson,
  LearningModule,
} from "../../lib/supabase/learning-rpc";
import type { PanelProps } from "../app-shell/contract";
import { asWorkspace } from "../app-shell/shell-data";
import { usePanelRouter } from "../app-shell/use-panel-router";
import {
  Button,
  EmptyState,
  PanelFrame,
  SelectField,
  TextAreaField,
  TextField,
} from "../ui";
import {
  LearningBlockView,
  MarkdownEditor,
  learningBlockPreview,
  readRichTextMarkdown,
  richTextBlockContent,
} from "../ui/rich-text";
import { percent } from "./learning-format";
import styles from "./course-panel.module.css";
import shared from "./sections.module.css";

/* ------------------------------------------------------------------------ */
/* Contract constants                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Only these roles may mutate authored content. `teacher` and `learner` see the
 * same outline read-only — the editor never renders a control it knows the
 * server will refuse.
 */
const AUTHORING_ROLES: ReadonlySet<string> = new Set([
  "creator",
  "tenant_admin",
  "tenant_owner",
]);

const BLOCK_TYPES: readonly AuthoringBlockType[] = [
  "rich_text",
  "heading",
  "callout",
  "code",
  "quote",
  "list",
  "divider",
];

const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_TYPES);

const BLOCK_TYPE_LABEL: Readonly<Record<AuthoringBlockType, string>> = {
  rich_text: "Rich text",
  heading: "Heading",
  callout: "Callout",
  code: "Code",
  quote: "Quote",
  list: "List",
  divider: "Divider",
};

const LIFECYCLE_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
] as const;

/**
 * Copy for every refusal the authoring route can return. `version_conflict` is
 * handled separately because it is not a failure of the request — it means the
 * course moved underneath this editor and the operator has to reload before any
 * further edit can be trusted.
 */
const ERROR_COPY: Readonly<Record<string, string>> = {
  insufficient_role:
    "Your role cannot change this course. Nothing was changed.",
  not_found:
    "That item no longer exists in this course. Reload the course to see its current shape.",
  invalid_request:
    "Those values were rejected. Check the field lengths and try again — nothing was changed.",
  idempotency_conflict:
    "That change was already recorded once. Reload the course before editing again.",
  tenant_selection_required:
    "This request needs an active workspace. Reload the console and try again.",
  authentication_required:
    "Your session is no longer valid. Sign in again — nothing was changed.",
  authoring_request_denied:
    "The editing service refused that request. Course editing may not be enabled on this database yet (its migration may still be unapplied). Nothing was changed.",
  request_failed:
    "That change could not be sent. Nothing was changed.",
};

/* ------------------------------------------------------------------------ */
/* Transport                                                                 */
/* ------------------------------------------------------------------------ */

type AuthoringResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function postAuthoring<T>(
  body: Record<string, unknown>,
): Promise<AuthoringResponse<T>> {
  try {
    const response = await fetch("/api/authoring", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const code =
        isRecord(payload) && typeof payload.code === "string"
          ? payload.code
          : "request_failed";
      return { ok: false, code };
    }
    return { ok: true, data: payload as T };
  } catch {
    return { ok: false, code: "request_failed" };
  }
}

/** Idempotency keys must be 8–200 chars of `[A-Za-z0-9:_-]`. */
function operationKey(prefix: string) {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${random}`;
}

/* ------------------------------------------------------------------------ */
/* Shared editor plumbing                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Every mutation is funnelled through one runner so exactly one edit is ever in
 * flight, the owning course `recordVersion` is threaded forward from the
 * previous response, and a 409 latches the whole editor read-only.
 */
type RunMutation = (
  key: string,
  body: Record<string, unknown>,
) => Promise<AuthoringResult | null>;

type EditorApi = {
  readonly courseId: string;
  readonly run: RunMutation;
  readonly busyKey: string | null;
  /** True while a mutation is in flight or after an unresolved conflict. */
  readonly locked: boolean;
};

function cx(...values: readonly (string | false | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

function titleError(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "A title is required.";
  if (trimmed.length < 3) return "Use at least 3 characters.";
  if (trimmed.length > 160) return "Use at most 160 characters.";
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* Block content mapping                                                     */
/* ------------------------------------------------------------------------ */

type BlockDraft = {
  readonly type: AuthoringBlockType;
  readonly text: string;
  readonly variant: string;
};

type VariantField =
  | { readonly kind: "none" }
  | {
      readonly kind: "select";
      readonly label: string;
      readonly options: readonly { value: string; label: string }[];
    }
  | { readonly kind: "text"; readonly label: string; readonly placeholder: string };

function variantField(type: AuthoringBlockType): VariantField {
  switch (type) {
    case "rich_text":
      /**
       * Both values were already legal in `rich_text` content; only the editor
       * behind them changes. "Rich text" opens the formatting editor and stores
       * markdown; "Plain text" keeps the literal textarea, so a block authored
       * before this editor existed is never silently reinterpreted.
       */
      return {
        kind: "select",
        label: "Format",
        options: [
          { value: "markdown", label: "Rich text" },
          { value: "plain", label: "Plain text" },
        ],
      };
    case "heading":
      return {
        kind: "select",
        label: "Level",
        options: [
          { value: "2", label: "Level 2" },
          { value: "3", label: "Level 3" },
          { value: "4", label: "Level 4" },
        ],
      };
    case "callout":
      return {
        kind: "select",
        label: "Tone",
        options: [
          { value: "note", label: "Note" },
          { value: "warning", label: "Warning" },
          { value: "success", label: "Success" },
        ],
      };
    case "code":
      return { kind: "text", label: "Language", placeholder: "text" };
    case "quote":
      return { kind: "text", label: "Attribution", placeholder: "Optional" };
    case "list":
      return {
        kind: "select",
        label: "Style",
        options: [
          { value: "bullet", label: "Bulleted" },
          { value: "numbered", label: "Numbered" },
        ],
      };
    case "divider":
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}

function defaultVariant(type: AuthoringBlockType) {
  switch (type) {
    case "rich_text":
      return "markdown";
    case "heading":
      return "2";
    case "callout":
      return "note";
    case "code":
      return "text";
    case "list":
      return "bullet";
    default:
      return "";
  }
}

function draftToContent(draft: BlockDraft): Record<string, unknown> {
  const text = draft.text;
  switch (draft.type) {
    case "rich_text":
      // Markdown is sanitised on the way out — HTML never reaches the database
      // from this console, whatever was typed or pasted into the editor.
      return draft.variant === "markdown"
        ? richTextBlockContent(text)
        : { text, format: "plain" };
    case "heading":
      return { text, level: Number(draft.variant) || 2 };
    case "callout":
      return { text, tone: draft.variant || "note" };
    case "code":
      return { text, language: draft.variant || "text" };
    case "quote":
      return draft.variant.trim().length > 0
        ? { text, attribution: draft.variant.trim() }
        : { text };
    case "list":
      return {
        items: text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        style: draft.variant || "bullet",
      };
    case "divider":
      return {};
    default:
      return { text };
  }
}

function asBlockType(value: string): AuthoringBlockType {
  return BLOCK_TYPE_SET.has(value)
    ? (value as AuthoringBlockType)
    : "rich_text";
}

/**
 * A block is only editable here when this editor can round-trip its content
 * without silently rewriting it. A `rich_text` block that stores markdown or
 * HTML instead of `text` is shown and can be deleted, but is never re-saved
 * through a plain-text field.
 */
function blockIsEditable(block: LearningBlock) {
  if (!BLOCK_TYPE_SET.has(block.type)) return false;
  const type = asBlockType(block.type);
  if (type === "divider") return true;
  if (type === "list") return true;
  return (
    typeof block.content.text === "string" ||
    Object.keys(block.content).length === 0
  );
}

function blockDraftFrom(block: LearningBlock): BlockDraft {
  const type = asBlockType(block.type);
  const content = block.content;
  const text = typeof content.text === "string" ? content.text : "";
  switch (type) {
    case "list": {
      const items = Array.isArray(content.items)
        ? content.items.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      return {
        type,
        text: items.join("\n"),
        variant: typeof content.style === "string" ? content.style : "bullet",
      };
    }
    case "heading":
      return {
        type,
        text,
        variant:
          typeof content.level === "number" ? String(content.level) : "2",
      };
    case "callout":
      return {
        type,
        text,
        variant: typeof content.tone === "string" ? content.tone : "note",
      };
    case "code":
      return {
        type,
        text,
        variant:
          typeof content.language === "string" ? content.language : "text",
      };
    case "quote":
      return {
        type,
        text,
        variant:
          typeof content.attribution === "string" ? content.attribution : "",
      };
    case "divider":
      return { type, text: "", variant: "" };
    default: {
      /**
       * A block with no declared format predates this editor and is literal
       * text, so it stays "plain" until someone deliberately switches it. Only
       * content that already says `markdown` is loaded into the rich editor.
       */
      const format =
        typeof content.format === "string" ? content.format : "plain";
      return {
        type,
        text: format === "markdown" ? readRichTextMarkdown(content) : text,
        variant: format,
      };
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Publication visibility                                                    */
/* ------------------------------------------------------------------------ */

/**
 * What learners cannot see yet.
 *
 * `learning_get_workspace` only ever hands a learner *published* modules and
 * lessons, and `learning_create_module` / `learning_create_lesson` create their
 * rows as drafts. So anything still in draft is invisible to every learner even
 * when the course itself says "published" — which is exactly the trap this
 * panel has to make impossible to walk into.
 *
 * Archived rows are counted separately and never described as pending work:
 * archiving is a decision to hide something, and `learning_publish_course`
 * leaves it hidden.
 */
type PublishGap = {
  readonly modules: number;
  readonly lessons: number;
  readonly archived: number;
  readonly total: number;
};

function publicationGap(
  outline: readonly LearningModule[],
  removed: ReadonlySet<string> = new Set<string>(),
): PublishGap {
  let modules = 0;
  let lessons = 0;
  let archived = 0;
  for (const module of outline) {
    if (removed.has(module.moduleId)) continue;
    if (module.status === "draft") modules += 1;
    if (module.status === "archived") archived += 1;
    for (const lesson of module.lessons) {
      if (removed.has(lesson.lessonId)) continue;
      if (lesson.status === "draft") lessons += 1;
      if (lesson.status === "archived") archived += 1;
    }
  }
  return { modules, lessons, archived, total: modules + lessons };
}

function countOf(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** "3 lessons and 1 module", "1 module", "2 lessons". */
function gapPhrase(gap: PublishGap) {
  const parts: string[] = [];
  if (gap.lessons > 0) parts.push(countOf(gap.lessons, "lesson"));
  if (gap.modules > 0) parts.push(countOf(gap.modules, "module"));
  return parts.join(" and ");
}

/**
 * One line of prose for a block, used only where a *label* is wanted — the
 * block itself is rendered properly by `LearningBlockView`. Markdown is
 * projected to plain text so a preview never shows raw asterisks.
 */
function blockPreview(block: LearningBlock) {
  return learningBlockPreview(block.type, block.content);
}

/* ------------------------------------------------------------------------ */
/* Panel entry point                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Learning panel: the course library, one course with its full editable
 * outline, revision history, publishing and the honest upload state.
 *
 * Publishing and learner progress stay native form posts to the existing
 * durable routes (`/app/progress`, `/app/course/create`, `/app/course/publish`).
 * Structural editing goes through `POST /api/authoring`.
 */
export function CoursePanel({ payload, params, refresh }: PanelProps) {
  const { openPanel } = usePanelRouter();
  const workspace = asWorkspace(payload);
  const courses = workspace?.courses ?? [];
  const role = workspace?.identity.role ?? payload.role;
  /**
   * One gate for the whole panel. `canAuthor` is the server's own answer, read
   * straight out of the authoring RPC gate; the role set is a second, local
   * assertion of the same contract so a database that has not yet applied the
   * `canAuthor` correction still cannot hand a teacher an editor whose every
   * button returns 403. Nothing that can be refused is offered unless both
   * agree.
   */
  const canAuthor =
    workspace?.identity.canAuthor === true && AUTHORING_ROLES.has(role);
  const canEdit = canAuthor;

  const courseId = params.get("id");
  const activeCourse = courseId
    ? courses.find((course) => course.courseId === courseId)
    : undefined;

  if (courseId !== null && activeCourse === undefined) {
    return (
      <div className={shared.stack}>
        <EmptyState
          action={
            <Button onClick={() => openPanel("course")} variant="primary">
              Back to all courses
            </Button>
          }
          description="It may have been deleted, or it belongs to a workspace you cannot read."
          headline="That course is not in this workspace"
          tone="error"
        />
      </div>
    );
  }

  if (activeCourse !== undefined) {
    return (
      <CourseView
        assistantName={payload.agent.assistantName}
        canEdit={canEdit}
        course={activeCourse}
        initialLessonId={params.get("lessonId")}
        key={activeCourse.courseId}
        onBack={() => openPanel("course")}
        onAskAssistant={(lessonId) =>
          openPanel("agent", { courseId: activeCourse.courseId, lessonId })
        }
        refresh={refresh}
        role={role}
      />
    );
  }

  return (
    <CourseLibrary
      canAuthor={canAuthor}
      courses={courses}
      onOpen={(id) => openPanel("course", { id })}
      wantsCreate={params.get("intent") === "create"}
    />
  );
}

/* ------------------------------------------------------------------------ */
/* Library                                                                   */
/* ------------------------------------------------------------------------ */

function CourseLibrary({
  canAuthor,
  courses,
  onOpen,
  wantsCreate,
}: {
  readonly canAuthor: boolean;
  readonly courses: readonly LearningCourse[];
  readonly onOpen: (courseId: string) => void;
  readonly wantsCreate: boolean;
}) {
  return (
    <div className={shared.stack}>
      <section className={shared.stackTight}>
        <div className={shared.sectionHead}>
          <div>
            <p className={shared.eyebrow}>Library</p>
            <h3 className={shared.title}>Courses</h3>
          </div>
          <span className={shared.meta}>{courses.length} available</span>
        </div>

        {courses.length === 0 ? (
          <div className={shared.empty}>
            <h4 className={shared.subtitle}>No course has been added yet.</h4>
            <p className={shared.lede}>
              Your workspace is ready. Add the first lesson to begin a learning
              journey.
            </p>
          </div>
        ) : (
          <div className={shared.cardGrid}>
            {courses.map((course) => {
              const gap = publicationGap(course.modules);
              return (
                <button
                  className={`${shared.card} ${shared.cardButton}`}
                  key={course.courseId}
                  onClick={() => onOpen(course.courseId)}
                  type="button"
                >
                  <div className={shared.cardHead}>
                    <h4 className={shared.cardTitle}>{course.title}</h4>
                    <span className={shared.badge}>{course.status}</span>
                  </div>
                  {canAuthor && gap.total > 0 ? (
                    <span className={styles.cardPill}>
                      {countOf(gap.total, "item")} not visible to learners
                    </span>
                  ) : null}
                  <p className={shared.cardCopy}>{course.description}</p>
                  <div className={shared.progressTrack}>
                    <span
                      style={{
                        width: `${percent(course.progress.percentComplete)}%`,
                      }}
                    />
                  </div>
                  <span className={shared.meta}>
                    {course.modules.length}{" "}
                    {course.modules.length === 1 ? "module" : "modules"} ·{" "}
                    {Math.round(percent(course.progress.percentComplete))}%
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {canAuthor ? (
        <section className={shared.stackTight} id="create-course">
          <div className={shared.sectionHead}>
            <div>
              <p className={shared.eyebrow}>Course creator</p>
              <h3 className={shared.title}>Add learning</h3>
            </div>
            <span className={shared.badge}>Private draft</span>
          </div>

          <form className={shared.form} action="/app/course/create" method="post">
            <label className={shared.field}>
              <span>Course title</span>
              <input
                autoFocus={wantsCreate}
                maxLength={160}
                minLength={3}
                name="title"
                placeholder="Marketing Magic"
                required
              />
            </label>
            <label className={shared.field}>
              <span>What learners will be able to do</span>
              <textarea
                maxLength={2000}
                minLength={3}
                name="description"
                placeholder="A concise outcome-focused description."
                required
              />
            </label>
            <div className={shared.formGrid}>
              <label className={shared.field}>
                <span>First module</span>
                <input
                  maxLength={160}
                  minLength={3}
                  name="moduleTitle"
                  placeholder="Build your foundation"
                  required
                />
              </label>
              <label className={shared.field}>
                <span>First lesson</span>
                <input
                  maxLength={160}
                  minLength={3}
                  name="lessonTitle"
                  placeholder="Start with your vision"
                  required
                />
              </label>
            </div>
            <label className={shared.field}>
              <span>Lesson content</span>
              <textarea
                maxLength={50000}
                minLength={20}
                name="lessonContent"
                placeholder="Paste or write the first lesson. It stays a draft until you publish."
                required
              />
            </label>
            <div className={shared.formFooter}>
              <span className={shared.meta}>
                Saved privately to this workspace. Every part of it stays
                editable afterwards.
              </span>
              <button className={shared.primaryButton} type="submit">
                Create draft
              </button>
            </div>
          </form>

          <div className={shared.form}>
            <div>
              <p className={shared.eyebrow}>Secure import</p>
              <h4 className={shared.subtitle}>Upload an existing source</h4>
              <p className={shared.lede}>
                The file is signed directly into this tenant’s private
                quarantine. It cannot become learning until the security and
                extraction pipeline clears it.
              </p>
            </div>
            <UploadLearning
              courses={courses.map((course) => ({
                courseId: course.courseId,
                title: course.title,
              }))}
            />
            <UploadStateReportView />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Course view + editor                                                      */
/* ------------------------------------------------------------------------ */

function CourseView({
  assistantName,
  canEdit,
  course,
  initialLessonId,
  onAskAssistant,
  onBack,
  refresh,
  role,
}: {
  readonly assistantName: string;
  readonly canEdit: boolean;
  readonly course: LearningCourse;
  readonly initialLessonId: string | null;
  readonly onAskAssistant: (lessonId: string) => void;
  readonly onBack: () => void;
  readonly refresh: () => Promise<void>;
  readonly role: string;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [showRevisions, setShowRevisions] = useState(false);
  const [openLessons, setOpenLessons] = useState<readonly string[]>(
    initialLessonId === null ? [] : [initialLessonId],
  );

  /**
   * The owning course `record_version` is the single concurrency token for the
   * whole module/lesson/block tree. Every accepted mutation returns the
   * advanced value, and the next request must carry it — the payload prop only
   * catches up after `refresh()` has round-tripped the server render, so the
   * ref is the authority in between.
   */
  const versionRef = useRef(course.recordVersion);
  const [knownVersion, setKnownVersion] = useState(course.recordVersion);
  const inFlightRef = useRef(false);

  // Someone else's edit lands here: adopt any version the server reports ahead
  // of what this editor has seen.
  useEffect(() => {
    if (course.recordVersion > versionRef.current) {
      versionRef.current = course.recordVersion;
      setKnownVersion(course.recordVersion);
    }
  }, [course.recordVersion]);

  // Optimistic shape held only until the server render catches up to every
  // version this editor has been handed.
  const [pendingRemoved, setPendingRemoved] = useState<readonly string[]>([]);
  const [pendingOrder, setPendingOrder] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const caughtUp = course.recordVersion >= knownVersion;

  useEffect(() => {
    if (!caughtUp) return;
    setPendingRemoved((previous) =>
      previous.length === 0 ? previous : [],
    );
    setPendingOrder((previous) =>
      Object.keys(previous).length === 0 ? previous : {},
    );
  }, [caughtUp]);

  const run = useCallback<RunMutation>(
    async (key, body) => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setBusyKey(key);
      setFailure(null);
      setNotice(null);
      try {
        const response = await postAuthoring<AuthoringResult>({
          ...body,
          expectedVersion: versionRef.current,
          idempotencyKey: operationKey(key.replace(/[^A-Za-z0-9:_-]/gu, "-")),
        });
        if (!response.ok) {
          if (response.code === "version_conflict") setConflict(true);
          else
            setFailure(
              ERROR_COPY[response.code] ?? ERROR_COPY.request_failed ?? null,
            );
          return null;
        }
        const result = response.data;
        if (typeof result.recordVersion === "number") {
          versionRef.current = Math.max(
            versionRef.current,
            result.recordVersion,
          );
          setKnownVersion(versionRef.current);
        }
        setNotice("Saved.");
        try {
          await refresh();
        } catch {
          // The mutation was accepted; only the re-read failed. The version is
          // already threaded forward, so editing can continue.
        }
        return result;
      } finally {
        inFlightRef.current = false;
        setBusyKey(null);
      }
    },
    [refresh],
  );

  const locked = busyKey !== null || conflict;
  const api: EditorApi = {
    courseId: course.courseId,
    run,
    busyKey,
    locked,
  };

  const removed = new Set<string>(caughtUp ? [] : pendingRemoved);
  const modules = arrange(
    course.modules.filter((module) => !removed.has(module.moduleId)),
    (module) => module.moduleId,
    caughtUp ? undefined : pendingOrder[course.courseId],
  );

  function noteRemoved(id: string) {
    setPendingRemoved((previous) => [...previous, id]);
  }

  async function moveChild(
    parentKind: "course" | "module",
    parentId: string,
    orderedIds: readonly string[],
    index: number,
    delta: -1 | 1,
  ) {
    const target = index + delta;
    const moved = orderedIds[index];
    const displaced = orderedIds[target];
    if (moved === undefined || displaced === undefined) return;
    const next = [...orderedIds];
    next[index] = displaced;
    next[target] = moved;
    setPendingOrder((previous) => ({ ...previous, [parentId]: next }));
    const result = await run(`reorder-${parentId}`, {
      action: "reorder",
      parentKind,
      parentId,
      orderedIds: next,
    });
    if (result === null) {
      setPendingOrder((previous) => {
        const copy = { ...previous };
        delete copy[parentId];
        return copy;
      });
    }
    restoreMoveFocus(moved, delta);
  }

  function toggleLesson(lessonId: string) {
    setOpenLessons((previous) =>
      previous.includes(lessonId)
        ? previous.filter((value) => value !== lessonId)
        : [...previous, lessonId],
    );
  }

  const moduleIds = modules.map((module) => module.moduleId);
  const gap = publicationGap(course.modules, removed);

  return (
    <div className={shared.stack}>
      <div>
        <button className={shared.textAction} onClick={onBack} type="button">
          <span aria-hidden="true">←</span> All courses
        </button>
      </div>

      <section className={shared.stackTight}>
        <div className={shared.sectionHead}>
          <div>
            <p className={shared.eyebrow}>{course.status}</p>
            <h3 className={shared.title}>{course.title}</h3>
          </div>
          <span className={shared.meta}>
            {Math.round(percent(course.progress.percentComplete))}%
          </span>
        </div>
        <p className={shared.lede}>{course.description}</p>
        <div className={shared.progressTrack}>
          <span
            style={{ width: `${percent(course.progress.percentComplete)}%` }}
          />
        </div>
        <p className={shared.meta}>
          {course.progress.lessonsCompleted} of {course.progress.lessonsTotal}{" "}
          lessons complete
        </p>
      </section>

      <div className={styles.editorRoot}>
        {conflict ? (
          <div className={styles.conflict} role="alert">
            <span className={styles.messageBody}>
              <strong>This course changed somewhere else.</strong>
              Your edit was refused so it could not overwrite the newer version.
              Reload the course, check what changed, then make the edit again.
            </span>
            <Button
              onClick={() => {
                setConflict(false);
                setFailure(null);
                setNotice(null);
                void refresh();
              }}
              size="sm"
              variant="primary"
            >
              Reload course
            </Button>
          </div>
        ) : null}

        {failure !== null ? (
          <div className={styles.failure} role="alert">
            <span className={styles.messageBody}>{failure}</span>
            <Button onClick={() => setFailure(null)} size="sm" variant="ghost">
              Dismiss
            </Button>
          </div>
        ) : null}

        {!canEdit ? (
          <p className={styles.readOnly}>
            <span className={styles.messageBody}>
              {role === "teacher"
                ? "Your teacher role can read this outline but cannot change it. Ask a creator, admin or owner to edit the course."
                : "This outline is read-only for your role."}
            </span>
          </p>
        ) : null}

        {canEdit ? (
          <>
            <CourseDetailsForm api={api} course={course} />

            <div className={styles.toolbar}>
              <Button
                aria-expanded={showRevisions}
                onClick={() => setShowRevisions((value) => !value)}
                size="sm"
              >
                {showRevisions ? "Hide revision history" : "Revision history"}
              </Button>
              {gap.total > 0 ? (
                <a className={styles.pendingLink} href="#publish-course">
                  {gapPhrase(gap)} not visible to learners
                </a>
              ) : null}
              <span className={styles.toolbarSpacer} />
              <span className={styles.versionStamp}>
                Version {knownVersion}
                {notice !== null && busyKey === null ? ` · ${notice}` : ""}
                {busyKey !== null ? " · Saving…" : ""}
              </span>
            </div>

            {showRevisions ? (
              <RevisionHistoryView
                api={api}
                onClose={() => setShowRevisions(false)}
              />
            ) : null}
          </>
        ) : null}

        {modules.length === 0 ? (
          <EmptyState
            compact
            description={
              canEdit
                ? "Add the first module to start building the outline."
                : "Nothing has been authored in this course yet."
            }
            headline="This course has no modules"
          />
        ) : (
          <ol className={styles.outline}>
            {modules.map((module, index) => (
              <ModuleCard
                api={api}
                assistantName={assistantName}
                canEdit={canEdit}
                index={index}
                key={module.moduleId}
                module={module}
                onAskAssistant={onAskAssistant}
                onMove={(delta) =>
                  void moveChild(
                    "course",
                    course.courseId,
                    moduleIds,
                    index,
                    delta,
                  )
                }
                onMoveLesson={(orderedIds, lessonIndex, delta) =>
                  void moveChild(
                    "module",
                    module.moduleId,
                    orderedIds,
                    lessonIndex,
                    delta,
                  )
                }
                onRemoved={noteRemoved}
                onToggleLesson={toggleLesson}
                openLessons={openLessons}
                pendingOrder={caughtUp ? undefined : pendingOrder}
                removed={removed}
                total={modules.length}
              />
            ))}
          </ol>
        )}

        {canEdit ? <AddModuleForm api={api} /> : null}

        {canEdit ? <PublishPanel course={course} gap={gap} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Publishing                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The one control that changes what a learner can see, and it is offered
 * whenever there is anything to change — including on a course that is already
 * published, which is the case that used to be silently unreachable.
 *
 * It says the exact count before it is pressed, and `learning_publish_course`
 * promotes exactly that set: every draft module and lesson, and nothing that
 * was archived.
 */
function PublishPanel({
  course,
  gap,
}: {
  readonly course: LearningCourse;
  readonly gap: PublishGap;
}) {
  const live = course.status === "published";

  if (live && gap.total === 0) {
    return (
      <p className={styles.notice} id="publish-course">
        <span className={styles.messageBody}>
          <strong>Learners see this course exactly as it is above.</strong>
          Every module and lesson in it is published.
          {gap.archived > 0
            ? ` ${countOf(gap.archived, "archived item")} stays hidden until you set it back to published.`
            : ""}
        </span>
      </p>
    );
  }

  return (
    <form
      action="/app/course/publish"
      className={styles.publish}
      id="publish-course"
      method="post"
    >
      <input name="courseId" type="hidden" value={course.courseId} />
      <span className={styles.messageBody}>
        <strong>
          {live
            ? "This course has changes learners cannot see"
            : "This course is not visible to learners yet"}
        </strong>
        {gap.total > 0 ? (
          <>
            {gapPhrase(gap)} {gap.total === 1 ? "is" : "are"} still a draft.
            Publishing makes exactly {gap.total === 1 ? "that one" : "those"}{" "}
            live and leaves everything else as it is.
          </>
        ) : (
          <>
            Everything inside this course is already published, so publishing
            only makes the course itself visible.
          </>
        )}
        {gap.archived > 0 ? (
          <>
            {" "}
            {countOf(gap.archived, "archived item")} stays hidden — publishing
            never brings archived content back.
          </>
        ) : null}
      </span>
      <button className={shared.primaryButton} type="submit">
        {live ? "Publish changes" : "Publish course"}
      </button>
    </form>
  );
}

/**
 * Draft and archived rows are invisible to learners regardless of the course's
 * own status, so every one of them is labelled where it sits in the outline.
 */
function VisibilityPill({ status }: { readonly status: string }) {
  if (status === "published") return null;
  return (
    <span className={cx(styles.pill, styles.pillWarning)}>
      {status === "archived"
        ? "Archived · hidden from learners"
        : "Draft · not visible to learners"}
    </span>
  );
}

/** Applies an optimistic order override, keeping unknown ids at the end. */
function arrange<T>(
  items: readonly T[],
  id: (item: T) => string,
  order: readonly string[] | undefined,
): readonly T[] {
  if (order === undefined) return items;
  const rank = new Map<string, number>(
    order.map((value, index): [string, number] => [value, index]),
  );
  return [...items].sort(
    (left, right) =>
      (rank.get(id(left)) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(id(right)) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Keyboard reordering must not drop focus. After the list re-renders, focus
 * returns to the same button on the moved row, or to its twin when the row has
 * reached an end and that button is now disabled.
 */
function restoreMoveFocus(movedId: string, delta: -1 | 1) {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const primary = document.getElementById(
      `move-${delta < 0 ? "up" : "down"}-${movedId}`,
    );
    if (primary instanceof HTMLButtonElement && !primary.disabled) {
      primary.focus();
      return;
    }
    const secondary = document.getElementById(
      `move-${delta < 0 ? "down" : "up"}-${movedId}`,
    );
    if (secondary instanceof HTMLButtonElement) secondary.focus();
  });
}

/* ------------------------------------------------------------------------ */
/* Course details                                                            */
/* ------------------------------------------------------------------------ */

function CourseDetailsForm({
  api,
  course,
}: {
  readonly api: EditorApi;
  readonly course: LearningCourse;
}) {
  const serverTitle = course.title;
  const serverDescription = course.description ?? "";
  const [title, setTitle] = useState(serverTitle);
  const [description, setDescription] = useState(serverDescription);
  const [error, setError] = useState<string | undefined>(undefined);

  // Adopt server values whenever they actually change, without clobbering
  // in-progress typing on unrelated refreshes.
  useEffect(() => {
    setTitle(serverTitle);
  }, [serverTitle]);
  useEffect(() => {
    setDescription(serverDescription);
  }, [serverDescription]);

  const dirty = title !== serverTitle || description !== serverDescription;
  const busy = api.busyKey === "course-update";

  async function save() {
    const invalid = titleError(title);
    if (invalid !== undefined) {
      setError(invalid);
      return;
    }
    setError(undefined);
    await api.run("course-update", {
      action: "course.update",
      courseId: course.courseId,
      // Patch semantics: null leaves the column untouched, "" clears the
      // description.
      title: title === serverTitle ? null : title.trim(),
      description: description === serverDescription ? null : description,
    });
  }

  return (
    <div className={styles.inlineForm}>
      <TextField
        error={error}
        label="Course title"
        maxLength={160}
        onChange={(event) => setTitle(event.target.value)}
        value={title}
      />
      <TextAreaField
        help="Leave this empty to clear the description."
        label="What learners will be able to do"
        maxLength={2000}
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        value={description}
      />
      <div className={styles.formActions}>
        <Button
          disabled={!dirty || (api.locked && !busy)}
          loading={busy}
          loadingLabel="Saving…"
          onClick={() => void save()}
          variant="primary"
        >
          Save course details
        </Button>
        {dirty ? (
          <Button
            disabled={api.locked}
            onClick={() => {
              setTitle(serverTitle);
              setDescription(serverDescription);
              setError(undefined);
            }}
            variant="ghost"
          >
            Discard changes
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Modules                                                                   */
/* ------------------------------------------------------------------------ */

function ModuleCard({
  api,
  assistantName,
  canEdit,
  index,
  module,
  onAskAssistant,
  onMove,
  onMoveLesson,
  onRemoved,
  onToggleLesson,
  openLessons,
  pendingOrder,
  removed,
  total,
}: {
  readonly api: EditorApi;
  readonly assistantName: string;
  readonly canEdit: boolean;
  readonly index: number;
  readonly module: LearningModule;
  readonly onAskAssistant: (lessonId: string) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onMoveLesson: (
    orderedIds: readonly string[],
    index: number,
    delta: -1 | 1,
  ) => void;
  readonly onRemoved: (id: string) => void;
  readonly onToggleLesson: (lessonId: string) => void;
  readonly openLessons: readonly string[];
  readonly pendingOrder: Readonly<Record<string, readonly string[]>> | undefined;
  readonly removed: ReadonlySet<string>;
  readonly total: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const lessons = arrange(
    module.lessons.filter((lesson) => !removed.has(lesson.lessonId)),
    (lesson) => lesson.lessonId,
    pendingOrder?.[module.moduleId],
  );
  const lessonIds = lessons.map((lesson) => lesson.lessonId);

  async function rename(next: string) {
    const result = await api.run(`module-rename-${module.moduleId}`, {
      action: "module.update",
      moduleId: module.moduleId,
      title: next.trim(),
    });
    if (result !== null) setRenaming(false);
  }

  async function setStatus(next: string) {
    await api.run(`module-status-${module.moduleId}`, {
      action: "module.update",
      moduleId: module.moduleId,
      status: next,
    });
  }

  async function remove() {
    const result = await api.run(`module-delete-${module.moduleId}`, {
      action: "module.delete",
      moduleId: module.moduleId,
    });
    if (result !== null) onRemoved(module.moduleId);
  }

  return (
    <li className={styles.moduleCard}>
      <div className={styles.moduleHead}>
        {renaming ? (
          <InlineRename
            busy={api.busyKey === `module-rename-${module.moduleId}`}
            disabled={api.locked}
            label="Module title"
            onCancel={() => setRenaming(false)}
            onSave={rename}
            value={module.title}
          />
        ) : (
          <>
            <span className={styles.headText}>
              <h4 className={styles.headTitle}>
                <span className={styles.headMeta}>Module {index + 1} · </span>
                {module.title}
              </h4>
              <span className={styles.headMeta}>
                {module.status} · {lessons.length}{" "}
                {lessons.length === 1 ? "lesson" : "lessons"}
              </span>
              {canEdit ? <VisibilityPill status={module.status} /> : null}
            </span>
            {canEdit ? (
              <span className={styles.rowActions}>
                <MoveButtons
                  disabled={api.locked}
                  first={index === 0}
                  id={module.moduleId}
                  label={`module ${module.title}`}
                  last={index === total - 1}
                  onMove={onMove}
                />
                <Button
                  disabled={api.locked}
                  onClick={() => setRenaming(true)}
                  size="sm"
                >
                  Rename
                </Button>
                <DangerConfirm
                  busy={api.busyKey === `module-delete-${module.moduleId}`}
                  disabled={api.locked}
                  label="Delete"
                  onConfirm={remove}
                  question={`Delete “${module.title}” and its lessons?`}
                />
              </span>
            ) : null}
          </>
        )}
      </div>

      {canEdit ? (
        <div className={styles.metaRow}>
          <SelectField
            className={styles.grow}
            hideLabel
            label={`Status for module ${module.title}`}
            onChange={(event) => void setStatus(event.target.value)}
            options={LIFECYCLE_OPTIONS}
            value={module.status}
          />
        </div>
      ) : null}

      {lessons.length === 0 ? (
        <div className={styles.lessonBody}>
          <EmptyState
            compact
            description={
              canEdit
                ? "Add a lesson to this module."
                : "No lesson has been authored in this module."
            }
            headline="No lessons yet"
          />
        </div>
      ) : (
        <ol className={styles.lessonList}>
          {lessons.map((lesson, lessonIndex) => (
            <LessonRow
              api={api}
              assistantName={assistantName}
              canEdit={canEdit}
              index={lessonIndex}
              key={lesson.lessonId}
              lesson={lesson}
              onAskAssistant={onAskAssistant}
              onMove={(delta) => onMoveLesson(lessonIds, lessonIndex, delta)}
              onRemoved={onRemoved}
              onToggle={() => onToggleLesson(lesson.lessonId)}
              open={openLessons.includes(lesson.lessonId)}
              removed={removed}
              total={lessons.length}
            />
          ))}
        </ol>
      )}

      {canEdit ? (
        <div className={styles.lessonBody}>
          <AddLessonForm api={api} moduleId={module.moduleId} />
        </div>
      ) : null}
    </li>
  );
}

function AddModuleForm({ api }: { readonly api: EditorApi }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const busy = api.busyKey === "module-create";

  if (!open) {
    return (
      <div className={styles.formActions}>
        <Button disabled={api.locked} onClick={() => setOpen(true)}>
          Add module
        </Button>
      </div>
    );
  }

  async function create() {
    const invalid = titleError(title);
    if (invalid !== undefined) {
      setError(invalid);
      return;
    }
    setError(undefined);
    const result = await api.run("module-create", {
      action: "module.create",
      courseId: api.courseId,
      title: title.trim(),
    });
    if (result !== null) {
      setTitle("");
      setOpen(false);
    }
  }

  return (
    <div className={styles.inlineForm}>
      <TextField
        error={error}
        label="New module title"
        maxLength={160}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void create();
          }
        }}
        value={title}
      />
      <div className={styles.formActions}>
        <Button
          disabled={api.locked && !busy}
          loading={busy}
          loadingLabel="Adding…"
          onClick={() => void create()}
          variant="primary"
        >
          Add module
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(undefined);
          }}
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Lessons                                                                   */
/* ------------------------------------------------------------------------ */

function LessonRow({
  api,
  assistantName,
  canEdit,
  index,
  lesson,
  onAskAssistant,
  onMove,
  onRemoved,
  onToggle,
  open,
  removed,
  total,
}: {
  readonly api: EditorApi;
  readonly assistantName: string;
  readonly canEdit: boolean;
  readonly index: number;
  readonly lesson: LearningLesson;
  readonly onAskAssistant: (lessonId: string) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemoved: (id: string) => void;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly removed: ReadonlySet<string>;
  readonly total: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const blocks = lesson.blocks.filter(
    (block) => !removed.has(block.contentBlockId),
  );
  const bodyId = `lesson-body-${lesson.lessonId}`;

  async function rename(next: string) {
    const result = await api.run(`lesson-rename-${lesson.lessonId}`, {
      action: "lesson.update",
      lessonId: lesson.lessonId,
      title: next.trim(),
    });
    if (result !== null) setRenaming(false);
  }

  async function setStatus(next: string) {
    await api.run(`lesson-status-${lesson.lessonId}`, {
      action: "lesson.update",
      lessonId: lesson.lessonId,
      status: next,
    });
  }

  async function remove() {
    const result = await api.run(`lesson-delete-${lesson.lessonId}`, {
      action: "lesson.delete",
      lessonId: lesson.lessonId,
    });
    if (result !== null) onRemoved(lesson.lessonId);
  }

  return (
    <li className={styles.lessonRow}>
      <div className={styles.lessonHead}>
        {renaming ? (
          <InlineRename
            busy={api.busyKey === `lesson-rename-${lesson.lessonId}`}
            disabled={api.locked}
            label="Lesson title"
            onCancel={() => setRenaming(false)}
            onSave={rename}
            value={lesson.title}
          />
        ) : (
          <>
            <button
              aria-controls={bodyId}
              aria-expanded={open}
              className={styles.disclosure}
              onClick={onToggle}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cx(styles.caret, open && styles.caretOpen)}
              >
                ▶
              </span>
              <span
                className={cx(
                  styles.ordinal,
                  lesson.progressState === "completed" && styles.ordinalDone,
                )}
              >
                {lesson.progressState === "completed" ? "✓" : index + 1}
              </span>
              <span className={styles.lessonLabel}>
                <b>{lesson.title}</b>
                <small>
                  {lesson.status} · {blocks.length} learning{" "}
                  {blocks.length === 1 ? "block" : "blocks"}
                </small>
              </span>
            </button>
            {canEdit ? <VisibilityPill status={lesson.status} /> : null}
            {canEdit ? (
              <span className={styles.rowActions}>
                <MoveButtons
                  disabled={api.locked}
                  first={index === 0}
                  id={lesson.lessonId}
                  label={`lesson ${lesson.title}`}
                  last={index === total - 1}
                  onMove={onMove}
                />
                <Button
                  disabled={api.locked}
                  onClick={() => setRenaming(true)}
                  size="sm"
                >
                  Rename
                </Button>
                <DangerConfirm
                  busy={api.busyKey === `lesson-delete-${lesson.lessonId}`}
                  disabled={api.locked}
                  label="Delete"
                  onConfirm={remove}
                  question={`Delete “${lesson.title}” and its blocks?`}
                />
              </span>
            ) : null}
          </>
        )}
      </div>

      {open ? (
        <div className={styles.lessonBody} id={bodyId}>
          {canEdit ? (
            <SelectField
              className={styles.grow}
              label="Lesson status"
              onChange={(event) => void setStatus(event.target.value)}
              options={LIFECYCLE_OPTIONS}
              value={lesson.status}
            />
          ) : null}

          {blocks.length === 0 ? (
            <EmptyState
              compact
              description={
                canEdit
                  ? "Add a block to give this lesson content."
                  : "This lesson has no content blocks yet."
              }
              headline="No content blocks"
            />
          ) : (
            <ul className={styles.blockList}>
              {blocks.map((block) => (
                <BlockRow
                  api={api}
                  block={block}
                  canEdit={canEdit}
                  key={block.contentBlockId}
                  onRemoved={onRemoved}
                />
              ))}
            </ul>
          )}

          {canEdit ? (
            <>
              <p className={shared.meta}>
                Blocks keep their creation order — the authoring contract has no
                reorder for blocks, only for modules and lessons.
              </p>
              <AddBlockForm api={api} lessonId={lesson.lessonId} />
            </>
          ) : null}

          <div className={shared.lessonActions}>
            <form action="/app/progress" method="post">
              <input name="lessonId" type="hidden" value={lesson.lessonId} />
              <input
                name="state"
                type="hidden"
                value={
                  lesson.progressState === "completed"
                    ? "in_progress"
                    : "completed"
                }
              />
              <button className={shared.secondaryButton} type="submit">
                {lesson.progressState === "completed"
                  ? "Mark in progress"
                  : "Mark complete"}
              </button>
            </form>
            <button
              className={shared.textAction}
              onClick={() => onAskAssistant(lesson.lessonId)}
              type="button"
            >
              Ask {assistantName} about this
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function AddLessonForm({
  api,
  moduleId,
}: {
  readonly api: EditorApi;
  readonly moduleId: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const busy = api.busyKey === `lesson-create-${moduleId}`;

  if (!open) {
    return (
      <div className={styles.formActions}>
        <Button disabled={api.locked} onClick={() => setOpen(true)} size="sm">
          Add lesson
        </Button>
      </div>
    );
  }

  async function create() {
    const invalid = titleError(title);
    if (invalid !== undefined) {
      setError(invalid);
      return;
    }
    setError(undefined);
    const result = await api.run(`lesson-create-${moduleId}`, {
      action: "lesson.create",
      moduleId,
      title: title.trim(),
      // Omitted rather than sent empty: the route rejects a zero-length body.
      content: content.trim().length === 0 ? null : content,
    });
    if (result !== null) {
      setTitle("");
      setContent("");
      setOpen(false);
    }
  }

  return (
    <div className={styles.inlineForm}>
      <TextField
        error={error}
        label="New lesson title"
        maxLength={160}
        onChange={(event) => setTitle(event.target.value)}
        value={title}
      />
      <TextAreaField
        help="Optional. Becomes the lesson's opening content."
        label="Opening content"
        maxLength={50000}
        onChange={(event) => setContent(event.target.value)}
        rows={3}
        value={content}
      />
      <div className={styles.formActions}>
        <Button
          disabled={api.locked && !busy}
          loading={busy}
          loadingLabel="Adding…"
          onClick={() => void create()}
          variant="primary"
        >
          Add lesson
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(undefined);
          }}
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Blocks                                                                    */
/* ------------------------------------------------------------------------ */

function BlockRow({
  api,
  block,
  canEdit,
  onRemoved,
}: {
  readonly api: EditorApi;
  readonly block: LearningBlock;
  readonly canEdit: boolean;
  readonly onRemoved: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BlockDraft>(() => blockDraftFrom(block));
  const editable = blockIsEditable(block);
  const savingKey = `block-update-${block.contentBlockId}`;
  const busy = api.busyKey === savingKey;

  async function save() {
    const result = await api.run(savingKey, {
      action: "block.update",
      contentBlockId: block.contentBlockId,
      blockType: draft.type,
      content: draftToContent(draft),
    });
    if (result !== null) setEditing(false);
  }

  async function remove() {
    const result = await api.run(`block-delete-${block.contentBlockId}`, {
      action: "block.delete",
      contentBlockId: block.contentBlockId,
    });
    if (result !== null) onRemoved(block.contentBlockId);
  }

  return (
    <li className={styles.blockCard}>
      <div className={styles.blockHead}>
        <span className={styles.pill}>
          {BLOCK_TYPE_LABEL[asBlockType(block.type)] ?? block.type}
        </span>
        {!editing ? (
          /**
           * The learner-facing rendering, in place. This is the surface a
           * learner reads a lesson on, so the block is shown as what it is —
           * headings as headings, lists as lists, rich text with its
           * formatting — rather than as one truncated grey line.
           */
          <LearningBlockView
            className={styles.blockBody}
            content={block.content}
            type={block.type}
          />
        ) : null}
        {canEdit && !editing ? (
          <span className={styles.rowActions}>
            {editable ? (
              <Button
                disabled={api.locked}
                onClick={() => {
                  setDraft(blockDraftFrom(block));
                  setEditing(true);
                }}
                size="sm"
              >
                Edit
              </Button>
            ) : null}
            <DangerConfirm
              busy={api.busyKey === `block-delete-${block.contentBlockId}`}
              disabled={api.locked}
              label="Delete"
              onConfirm={remove}
              question="Delete this block?"
            />
          </span>
        ) : null}
      </div>

      {canEdit && !editable ? (
        <p className={`${styles.pill} ${styles.pillWarning}`}>
          Stored in a format this editor will not rewrite — it can only be
          deleted here.
        </p>
      ) : null}

      {editing ? (
        <BlockFields
          busy={busy}
          draft={draft}
          locked={api.locked}
          onCancel={() => setEditing(false)}
          onChange={setDraft}
          onSave={save}
          saveLabel="Save block"
        />
      ) : null}
    </li>
  );
}

function AddBlockForm({
  api,
  lessonId,
}: {
  readonly api: EditorApi;
  readonly lessonId: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BlockDraft>({
    type: "rich_text",
    text: "",
    variant: defaultVariant("rich_text"),
  });
  const key = `block-create-${lessonId}`;
  const busy = api.busyKey === key;

  if (!open) {
    return (
      <div className={styles.formActions}>
        <Button disabled={api.locked} onClick={() => setOpen(true)} size="sm">
          Add block
        </Button>
      </div>
    );
  }

  async function create() {
    const result = await api.run(key, {
      action: "block.create",
      lessonId,
      blockType: draft.type,
      content: draftToContent(draft),
    });
    if (result !== null) {
      setDraft({
        type: "rich_text",
        text: "",
        variant: defaultVariant("rich_text"),
      });
      setOpen(false);
    }
  }

  return (
    <BlockFields
      busy={busy}
      draft={draft}
      locked={api.locked}
      onCancel={() => setOpen(false)}
      onChange={setDraft}
      onSave={create}
      saveLabel="Add block"
    />
  );
}

function BlockFields({
  busy,
  draft,
  locked,
  onCancel,
  onChange,
  onSave,
  saveLabel,
}: {
  readonly busy: boolean;
  readonly draft: BlockDraft;
  readonly locked: boolean;
  readonly onCancel: () => void;
  readonly onChange: (draft: BlockDraft) => void;
  readonly onSave: () => Promise<void>;
  readonly saveLabel: string;
}) {
  const variant = variantField(draft.type);

  return (
    <div className={styles.inlineForm}>
      <div className={styles.formRow}>
        <SelectField
          label="Block type"
          onChange={(event) => {
            const next = asBlockType(event.target.value);
            onChange({
              type: next,
              text: next === "divider" ? "" : draft.text,
              variant: defaultVariant(next),
            });
          }}
          options={BLOCK_TYPES.map((type) => ({
            value: type,
            label: BLOCK_TYPE_LABEL[type],
          }))}
          value={draft.type}
        />
        {variant.kind === "select" ? (
          <SelectField
            label={variant.label}
            onChange={(event) =>
              onChange({ ...draft, variant: event.target.value })
            }
            options={variant.options}
            value={draft.variant}
          />
        ) : null}
        {variant.kind === "text" ? (
          <TextField
            label={variant.label}
            maxLength={160}
            onChange={(event) =>
              onChange({ ...draft, variant: event.target.value })
            }
            placeholder={variant.placeholder}
            value={draft.variant}
          />
        ) : null}
      </div>

      {draft.type === "divider" ? (
        <p className={shared.meta}>A divider has no text of its own.</p>
      ) : draft.type === "rich_text" && draft.variant === "markdown" ? (
        // The real editor: toolbar, keyboard shortcuts and a live preview of
        // exactly what the learner will see.
        <MarkdownEditor
          help="Written for learners."
          label="Text"
          onChange={(markdown) => onChange({ ...draft, text: markdown })}
          value={draft.text}
        />
      ) : (
        <TextAreaField
          help={
            draft.type === "list"
              ? "One item per line. Empty lines are dropped."
              : draft.type === "rich_text"
                ? "Stored and shown exactly as typed. Switch the format to Rich text for headings, lists, links and emphasis."
                : undefined
          }
          label={draft.type === "list" ? "Items" : "Text"}
          maxLength={20000}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
          rows={draft.type === "heading" ? 2 : 5}
          value={draft.text}
        />
      )}

      <div className={styles.formActions}>
        <Button
          disabled={locked && !busy}
          loading={busy}
          loadingLabel="Saving…"
          onClick={() => void onSave()}
          variant="primary"
        >
          {saveLabel}
        </Button>
        <Button disabled={busy} onClick={onCancel} variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Small controls                                                            */
/* ------------------------------------------------------------------------ */

function InlineRename({
  busy,
  disabled,
  label,
  onCancel,
  onSave,
  value,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSave: (next: string) => Promise<void>;
  readonly value: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | undefined>(undefined);

  function submit() {
    const invalid = titleError(draft);
    if (invalid !== undefined) {
      setError(invalid);
      return;
    }
    setError(undefined);
    void onSave(draft);
  }

  return (
    <div className={styles.grow}>
      <TextField
        autoFocus
        error={error}
        label={label}
        maxLength={160}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        value={draft}
      />
      <div className={styles.formActions}>
        <Button
          disabled={disabled && !busy}
          loading={busy}
          loadingLabel="Saving…"
          onClick={submit}
          size="sm"
          variant="primary"
        >
          Save
        </Button>
        <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function MoveButtons({
  disabled,
  first,
  id,
  label,
  last,
  onMove,
}: {
  readonly disabled: boolean;
  readonly first: boolean;
  readonly id: string;
  readonly label: string;
  readonly last: boolean;
  readonly onMove: (delta: -1 | 1) => void;
}) {
  return (
    <span
      aria-label={`Reorder ${label}`}
      className={styles.moveGroup}
      role="group"
    >
      <button
        className={styles.moveButton}
        disabled={disabled || first}
        id={`move-up-${id}`}
        onClick={() => onMove(-1)}
        type="button"
      >
        <span aria-hidden="true">↑</span>
        <span className={styles.srOnly}>Move {label} up</span>
      </button>
      <button
        className={styles.moveButton}
        disabled={disabled || last}
        id={`move-down-${id}`}
        onClick={() => onMove(1)}
        type="button"
      >
        <span aria-hidden="true">↓</span>
        <span className={styles.srOnly}>Move {label} down</span>
      </button>
    </span>
  );
}

function DangerConfirm({
  busy,
  disabled,
  label,
  onConfirm,
  question,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onConfirm: () => Promise<void>;
  readonly question: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <Button
        disabled={disabled}
        onClick={() => setArmed(true)}
        size="sm"
        variant="ghost"
      >
        {label}
      </Button>
    );
  }

  return (
    <span aria-label={question} className={styles.confirm} role="group">
      <span className={styles.confirmText}>{question}</span>
      <Button
        autoFocus
        loading={busy}
        loadingLabel="Deleting…"
        onClick={() => {
          void onConfirm().then(() => setArmed(false));
        }}
        size="sm"
        variant="danger"
      >
        Delete
      </Button>
      <Button
        disabled={busy}
        onClick={() => setArmed(false)}
        size="sm"
        variant="ghost"
      >
        Keep
      </Button>
    </span>
  );
}

/* ------------------------------------------------------------------------ */
/* Revision history                                                          */
/* ------------------------------------------------------------------------ */

function RevisionHistoryView({
  api,
  onClose,
}: {
  readonly api: EditorApi;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [history, setHistory] = useState<CourseRevisionHistory | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Reload after every accepted mutation, since each one appends a revision.
  const versionSignal = api.busyKey;

  useEffect(() => {
    if (versionSignal !== null) return;
    let active = true;
    setState("loading");
    void (async () => {
      const response = await postAuthoring<CourseRevisionHistory>({
        action: "course.revisions",
        courseId: api.courseId,
      });
      if (!active) return;
      if (!response.ok) {
        setFailure(
          ERROR_COPY[response.code] ?? ERROR_COPY.request_failed ?? null,
        );
        setState("failed");
        return;
      }
      setHistory(response.data);
      setState("ready");
    })();
    return () => {
      active = false;
    };
  }, [api.courseId, reloadToken, versionSignal]);

  async function rollback(revisionId: string) {
    const result = await api.run(`rollback-${revisionId}`, {
      action: "course.rollback",
      courseId: api.courseId,
      targetRevisionId: revisionId,
    });
    if (result !== null) setReloadToken((value) => value + 1);
  }

  return (
    <PanelFrame
      description="Every accepted edit appends an immutable revision. Restoring one appends a new revision — nothing in the history is ever rewritten."
      eyebrow="Course history"
      modal={false}
      onClose={onClose}
      side="inline"
      title="Revision history"
    >
      {state === "loading" ? (
        <p className={shared.loading} role="status">
          Loading the durable revision history…
        </p>
      ) : null}

      {state === "failed" ? (
        <div className={styles.failure} role="alert">
          <span className={styles.messageBody}>
            {failure ?? "The revision history could not be read."}
          </span>
          <Button
            onClick={() => setReloadToken((value) => value + 1)}
            size="sm"
          >
            Try again
          </Button>
        </div>
      ) : null}

      {state === "ready" && history !== null ? (
        history.revisions.length === 0 ? (
          <EmptyState
            compact
            description="Revisions appear here as soon as this course is edited."
            headline="No revisions recorded yet"
          />
        ) : (
          <div className={styles.scroller}>
            <ol className={styles.recordList}>
              {history.revisions.map((revision) => {
                const current =
                  revision.revisionId === history.headRevisionId;
                return (
                  <li
                    className={cx(
                      styles.recordRow,
                      current && styles.recordCurrent,
                    )}
                    key={revision.revisionId}
                  >
                    <span className={styles.recordText}>
                      <b>
                        #{revision.revisionNumber} ·{" "}
                        {revision.revisionKind.replace("_", " ")}
                        {current ? " (current)" : ""}
                      </b>
                      <small>
                        {new Date(revision.createdAt).toLocaleString()}
                        {revision.rollbackTargetRevisionNumber !== null
                          ? ` · restored #${revision.rollbackTargetRevisionNumber}`
                          : ""}
                      </small>
                      {revision.auditNote !== null ? (
                        <small>{revision.auditNote}</small>
                      ) : null}
                    </span>
                    {!current ? (
                      <DangerConfirm
                        busy={api.busyKey === `rollback-${revision.revisionId}`}
                        disabled={api.locked}
                        label="Restore"
                        onConfirm={() => rollback(revision.revisionId)}
                        question={`Restore the course to revision #${revision.revisionNumber}?`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        )
      ) : null}
    </PanelFrame>
  );
}

/* ------------------------------------------------------------------------ */
/* Uploads                                                                   */
/* ------------------------------------------------------------------------ */

const UPLOAD_COPY: Readonly<
  Record<UploadProcessingState, { label: string; detail: string }>
> = {
  awaiting_upload: {
    label: "Awaiting the file",
    detail:
      "A private upload slot exists, but the file has not arrived in quarantine yet.",
  },
  awaiting_processing: {
    label: "Uploaded, not processed",
    detail:
      "The file is stored in this workspace’s private quarantine. Nothing has extracted it, so none of it is learning content and the assistant cannot use it.",
  },
  processing: {
    label: "Processing",
    detail:
      "An ingestion job is running. The file does not become learning content until that job finishes.",
  },
  blocked: {
    label: "Blocked",
    detail:
      "This upload was stopped before processing and will not become learning content.",
  },
  ready: {
    label: "Processed",
    detail: "Ingestion reported success for this file.",
  },
};

/**
 * Honest upload reporting. `services/learning/` ships no ingestion worker, so
 * confirmed uploads stay at `awaiting_processing` with
 * `becameLearningContent: false`. This view says exactly that instead of
 * implying the file is live.
 */
function UploadStateReportView() {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [report, setReport] = useState<UploadStateReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setState("loading");
    void (async () => {
      const response = await postAuthoring<UploadStateReport>({
        action: "uploads.state",
      });
      if (!active) return;
      if (!response.ok) {
        setFailure(ERROR_COPY[response.code] ?? ERROR_COPY.request_failed ?? null);
        setState("failed");
        return;
      }
      setReport(response.data);
      setState("ready");
    })();
    return () => {
      active = false;
    };
  }, [reloadToken]);

  return (
    <div className={styles.editorRoot}>
      <div className={shared.sectionHead}>
        <div>
          <p className={shared.eyebrow}>Upload state</p>
          <h4 className={shared.subtitle}>What happened to your files</h4>
        </div>
        <Button
          disabled={state === "loading"}
          onClick={() => setReloadToken((value) => value + 1)}
          size="sm"
        >
          Refresh
        </Button>
      </div>

      {state === "loading" ? (
        <p className={shared.loading} role="status">
          Reading the durable upload state…
        </p>
      ) : null}

      {state === "failed" ? (
        <div className={styles.failure} role="alert">
          <span className={styles.messageBody}>
            {failure ?? "The upload state could not be read."}
          </span>
        </div>
      ) : null}

      {state === "ready" && report !== null ? (
        <>
          {!report.ingestionObserved ? (
            <p className={styles.notice}>
              <span className={styles.messageBody}>
                <strong>No file here has become learning content.</strong>
                No ingestion worker is running for this workspace, so uploaded
                files stay in private quarantine. They are safely stored, they
                are not searchable, and the assistant cannot answer from them.
              </span>
            </p>
          ) : null}

          {report.items.length === 0 ? (
            <EmptyState
              compact
              description="Files you upload above appear here with their real state."
              headline="No uploads yet"
            />
          ) : (
            <ul className={styles.recordList}>
              {report.items.map((item) => {
                const copy = UPLOAD_COPY[item.processingState];
                return (
                  <li className={styles.recordRow} key={item.intentId}>
                    <span className={styles.recordText}>
                      <b>{item.filename}</b>
                      <small>
                        {item.mediaType} ·{" "}
                        {Math.max(
                          1,
                          Math.round(item.declaredSizeBytes / 1024),
                        ).toLocaleString()}{" "}
                        KB · uploaded{" "}
                        {new Date(item.createdAt).toLocaleString()}
                      </small>
                      <small>{copy.detail}</small>
                    </span>
                    <span
                      className={cx(
                        styles.pill,
                        item.becameLearningContent
                          ? styles.pillPositive
                          : styles.pillWarning,
                      )}
                    >
                      {copy.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

export default CoursePanel;
