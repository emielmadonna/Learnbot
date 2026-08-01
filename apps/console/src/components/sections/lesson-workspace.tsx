"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AuthoringBlockType,
  CourseRevisionHistory,
  LessonReceptionEntry,
  LessonReceptionReport,
} from "../../lib/supabase/authoring-rpc";
import type {
  LearningBlock,
  LearningLesson,
  LearningModule,
} from "../../lib/supabase/learning-rpc";
import { Button, EmptyState, StatTile } from "../ui";
import { isMarkdownBlockContent, learningBlockPreview } from "../ui/rich-text";
import {
  AddBlockForm,
  BlockRow,
  ERROR_COPY,
  asBlockType,
  cx,
  postAuthoring,
  type EditorApi,
} from "./course-panel";
import panelStyles from "./course-panel.module.css";
import shared from "./sections.module.css";
import styles from "./lesson-workspace.module.css";

/* ------------------------------------------------------------------------ */
/* The mockup — v2-learning.html — is a three-pane document editor: a course */
/* tree on the left, one continuous lesson document in the centre, and a    */
/* per-lesson rail on the right. Every block type the product supports      */
/* (text, rich_text, image, video, link) renders inline in document order   */
/* by reusing `BlockRow` from course-panel.tsx unchanged — same save path,  */
/* same optimistic-concurrency handling, same conflict banner upstream.     */
/* Nothing here talks to the authoring API directly except the compact      */
/* "Versions" rollback, which goes through the same `api.run` every other   */
/* mutation in this course uses.                                           */
/* ------------------------------------------------------------------------ */

type FlatLesson = {
  readonly module: LearningModule;
  readonly moduleIndex: number;
  readonly lesson: LearningLesson;
  readonly lessonIndexInModule: number;
};

function flattenLessons(modules: readonly LearningModule[]): readonly FlatLesson[] {
  const flat: FlatLesson[] = [];
  modules.forEach((module, moduleIndex) => {
    module.lessons.forEach((lesson, lessonIndexInModule) => {
      flat.push({ module, moduleIndex, lesson, lessonIndexInModule });
    });
  });
  return flat;
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export type LessonWorkspaceProps = {
  readonly api: EditorApi;
  readonly assistantName: string;
  readonly canEdit: boolean;
  /** Already filtered of optimistically-removed rows and reorder-arranged. */
  readonly modules: readonly LearningModule[];
  readonly onAskAssistant: (lessonId: string) => void;
  /** Builds a real, right-clickable, copy-link-able URL for a lesson. */
  readonly lessonHref: (lessonId: string) => string;
  readonly onOpenFullHistory: () => void;
  readonly onOpenManage: () => void;
  readonly onRemovedBlock: (id: string) => void;
  readonly onSelectLesson: (lessonId: string) => void;
  readonly removed: ReadonlySet<string>;
  readonly selectedLessonId: string | null;
};

/**
 * The three-pane workspace. Lesson selection is owned by the URL one level up
 * (`course-panel.tsx` reads/writes the `lessonId` query param through
 * `usePanelRouter`); this component only resolves that id against the current
 * outline and falls back to the first lesson when it is missing or stale —
 * e.g. right after the lesson it pointed at was deleted.
 */
export function LessonWorkspace({
  api,
  assistantName,
  canEdit,
  modules,
  onAskAssistant,
  lessonHref,
  onOpenFullHistory,
  onOpenManage,
  onRemovedBlock,
  onSelectLesson,
  removed,
  selectedLessonId,
}: LessonWorkspaceProps) {
  const flatLessons = useMemo(() => flattenLessons(modules), [modules]);
  const selected =
    flatLessons.find((entry) => entry.lesson.lessonId === selectedLessonId) ??
    flatLessons[0];

  useEffect(() => {
    if (selected === undefined) return;
    if (selected.lesson.lessonId === selectedLessonId) return;
    onSelectLesson(selected.lesson.lessonId);
  }, [selected, selectedLessonId, onSelectLesson]);

  return (
    <div className={styles.workspace}>
      <LessonTree
        canEdit={canEdit}
        flatLessons={flatLessons}
        lessonHref={lessonHref}
        modules={modules}
        onOpenManage={onOpenManage}
        onSelectLesson={onSelectLesson}
        selectedLessonId={selected?.lesson.lessonId ?? null}
      />

      {selected === undefined ? (
        <div className={styles.document}>
          <EmptyState
            compact
            description="Add a lesson to a module to start writing its document."
            headline="No lesson to show yet"
          />
        </div>
      ) : (
        <LessonDocument
          api={api}
          assistantName={assistantName}
          canEdit={canEdit}
          lesson={selected.lesson}
          lessonIndexInModule={selected.lessonIndexInModule}
          moduleIndex={selected.moduleIndex}
          onAskAssistant={onAskAssistant}
          onRemovedBlock={onRemovedBlock}
          removed={removed}
        />
      )}

      <LessonRail
        api={api}
        canEdit={canEdit}
        lessonId={selected?.lesson.lessonId ?? null}
        onOpenFullHistory={onOpenFullHistory}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Left: course tree                                                         */
/* ------------------------------------------------------------------------ */

function LessonTree({
  canEdit,
  flatLessons,
  lessonHref,
  modules,
  onOpenManage,
  onSelectLesson,
  selectedLessonId,
}: {
  readonly canEdit: boolean;
  readonly flatLessons: readonly FlatLesson[];
  readonly lessonHref: (lessonId: string) => string;
  readonly modules: readonly LearningModule[];
  readonly onOpenManage: () => void;
  readonly onSelectLesson: (lessonId: string) => void;
  readonly selectedLessonId: string | null;
}) {
  const [query, setQuery] = useState("");
  // Below ~1100px the workspace collapses to one column (see .workspace in
  // lesson-workspace.module.css) and this pane becomes a disclosure rather
  // than a fixed sidebar. The toggle button is only visually a control at
  // that width — `.treeBody` has no `display: none` rule outside the narrow
  // media query, so on a wide screen this state is inert and the tree stays
  // fully visible regardless of what the button says.
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const owning = flatLessons.find(
      (entry) => entry.lesson.lessonId === selectedLessonId,
    );
    return owning === undefined
      ? new Set<string>()
      : new Set([owning.module.moduleId]);
  });

  // The module containing the current lesson stays expanded even when the
  // selection changed somewhere other than a click in this tree — a fresh
  // deep link, or a lesson picked from a stale request elsewhere.
  useEffect(() => {
    const owning = flatLessons.find(
      (entry) => entry.lesson.lessonId === selectedLessonId,
    );
    if (owning === undefined) return;
    setExpanded((previous) =>
      previous.has(owning.module.moduleId)
        ? previous
        : new Set([...previous, owning.module.moduleId]),
    );
  }, [selectedLessonId, flatLessons]);

  function toggleModule(moduleId: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  }

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;

  return (
    <nav aria-label="Course outline" className={styles.tree}>
      <div className={styles.treeHead}>
        <button
          aria-controls="lesson-tree-body"
          aria-expanded={narrowOpen}
          className={cx(styles.treeHeadTitle, styles.treeDisclosureToggle)}
          onClick={() => setNarrowOpen((value) => !value)}
          type="button"
        >
          <span aria-hidden="true" className={styles.treeChevron} />
          Course
        </button>
        {canEdit ? (
          <button
            aria-label="Add a module"
            className={styles.treeAdd}
            onClick={onOpenManage}
            title="Add a module"
            type="button"
          >
            +
          </button>
        ) : null}
      </div>

      <div
        className={cx(styles.treeBody, narrowOpen && styles.treeBodyOpen)}
        id="lesson-tree-body"
      >
        <div className={styles.searchBox}>
          <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
            <path
              d="M16 16l4 4"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="2"
            />
          </svg>
          <input
            aria-label="Search lessons"
            className={styles.searchInput}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search lessons"
            type="search"
            value={query}
          />
        </div>

        {modules.length === 0 ? (
          <p className={shared.meta}>No modules yet.</p>
        ) : (
          <ol className={styles.moduleList}>
            {modules.map((module, moduleIndex) => {
              const indexedLessons = module.lessons.map((lesson, lessonIndexInModule) => ({
                lesson,
                lessonIndexInModule,
              }));
              const moduleMatches = module.title
                .toLowerCase()
                .includes(normalizedQuery);
              const matchingLessons = indexedLessons.filter(({ lesson }) =>
                lesson.title.toLowerCase().includes(normalizedQuery),
              );
              if (searching && !moduleMatches && matchingLessons.length === 0) {
                return null;
              }
              const isExpanded = searching || expanded.has(module.moduleId);
              const visibleLessons =
                searching && !moduleMatches ? matchingLessons : indexedLessons;

              return (
                <li key={module.moduleId}>
                  <button
                    aria-expanded={isExpanded}
                    className={cx(
                      styles.moduleRow,
                      isExpanded && styles.moduleRowActive,
                    )}
                    onClick={() => toggleModule(module.moduleId)}
                    type="button"
                  >
                    <span>
                      {moduleIndex + 1} · {module.title}
                    </span>
                    {module.status === "published" ? (
                      <span className={styles.moduleCount}>
                        {module.lessons.length}
                      </span>
                    ) : (
                      <span
                        className={
                          module.status === "archived"
                            ? styles.archivedPill
                            : styles.draftPill
                        }
                      >
                        {module.status === "archived" ? "ARCHIVED" : "DRAFT"}
                      </span>
                    )}
                  </button>

                  {isExpanded && visibleLessons.length > 0 ? (
                    <ol className={styles.lessonSublist}>
                      {visibleLessons.map(({ lesson, lessonIndexInModule }) => {
                        const isSelected = lesson.lessonId === selectedLessonId;
                        return (
                          <li key={lesson.lessonId}>
                            <a
                              aria-current={isSelected ? "true" : undefined}
                              className={cx(
                                styles.lessonRow,
                                isSelected && styles.lessonRowActive,
                              )}
                              href={lessonHref(lesson.lessonId)}
                              onClick={(event) => {
                                if (
                                  event.button !== 0 ||
                                  event.metaKey ||
                                  event.ctrlKey ||
                                  event.shiftKey ||
                                  event.altKey
                                )
                                  return;
                                event.preventDefault();
                                onSelectLesson(lesson.lessonId);
                              }}
                            >
                              {lesson.status !== "published" ? (
                                <i
                                  aria-hidden="true"
                                  className={styles.lessonDraftDot}
                                  title="Not visible to learners"
                                />
                              ) : null}
                              <span className={styles.lessonRowLabel}>
                                {moduleIndex + 1}.{lessonIndexInModule + 1}{" "}
                                {lesson.title}
                              </span>
                            </a>
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        <hr className={styles.treeDivider} />
        {/*
          The workspace payload this panel receives (`LearningWorkspace`) carries
          no Q&A or review-queue counts, and question intelligence lives behind a
          separate analytics RPC this panel does not call. Rather than invent a
          number, these rows stay plain, uncounted labels — see the build report
          for exactly what would need to be wired for a real count to appear.
        */}
        <div className={styles.qaRow}>
          <span>Questions &amp; answers</span>
        </div>
        <div className={styles.qaRow}>
          <span>Waiting for review</span>
        </div>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------------ */
/* Centre: the lesson document                                              */
/* ------------------------------------------------------------------------ */

type ActiveEditor = {
  readonly blockId: string;
  readonly node: HTMLLIElement;
  readonly isMarkdown: boolean;
};

/**
 * Finds the real, already-working formatting toolbar that `MarkdownEditor`
 * renders inside the block currently being edited, and clicks the button
 * matching `glyph` — the same DOM element `BlockFields` already wired to
 * `applyRichTextCommand` with full selection and caret handling. This document
 * toolbar never reimplements that logic; it only locates and activates it, so
 * there is exactly one place formatting commands are applied.
 */
function clickMarkdownTool(root: HTMLElement, glyph: string): boolean {
  const toolbar = root.querySelector('[role="toolbar"]');
  if (!(toolbar instanceof HTMLElement)) return false;
  const button = Array.from(
    toolbar.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.querySelector('span[aria-hidden="true"]')?.textContent?.trim() ===
      glyph,
  );
  if (button === undefined || button.disabled) return false;
  button.click();
  return true;
}

function ListGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
      <path
        d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
      <rect
        height="15"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="2"
        width="17"
        x="3.5"
        y="4.5"
      />
      <path
        d="M3.5 15l4.5-4 4 3.5 3-2.5 5 4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="9" cy="9" r="1.4" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function VideoGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
      <rect
        height="16"
        rx="3"
        stroke="currentColor"
        strokeWidth="2"
        width="20"
        x="2"
        y="4"
      />
      <polygon fill="currentColor" points="10,8.5 16,12 10,15.5" />
    </svg>
  );
}

/**
 * The mockup's toolbar (B / I / H2 / H3 · divider · bulleted list / image /
 * video). B/I/H2/H3 and the bulleted-list button drive whichever block is
 * currently open for editing below, via `clickMarkdownTool`; they are
 * honestly disabled — with a stated reason — when nothing is being edited or
 * the active block does not use rich-text formatting. Image and video insert
 * are always available to a canEdit viewer: they open the exact same
 * "Add block" flow the bottom of the document already uses, pre-set to that
 * type.
 */
function DocumentToolbar({
  activeEditor,
  onInsertImage,
  onInsertVideo,
}: {
  readonly activeEditor: ActiveEditor | null;
  readonly onInsertImage: () => void;
  readonly onInsertVideo: () => void;
}) {
  const disabledReason =
    activeEditor === null
      ? "Click Edit on a block below to format it."
      : !activeEditor.isMarkdown
        ? "This block does not use rich-text formatting."
        : undefined;
  const formatDisabled = disabledReason !== undefined;

  function runFormat(glyph: string) {
    if (activeEditor === null) return;
    clickMarkdownTool(activeEditor.node, glyph);
  }

  return (
    <div aria-label="Text formatting" className={styles.docToolbar} role="group">
      <button
        aria-label="Bold"
        className={styles.docToolButton}
        disabled={formatDisabled}
        onClick={() => runFormat("B")}
        title={disabledReason ?? "Bold"}
        type="button"
      >
        <strong>B</strong>
      </button>
      <button
        aria-label="Italic"
        className={styles.docToolButton}
        disabled={formatDisabled}
        onClick={() => runFormat("I")}
        title={disabledReason ?? "Italic"}
        type="button"
      >
        <em>I</em>
      </button>
      <button
        aria-label="Heading"
        className={styles.docToolButton}
        disabled={formatDisabled}
        onClick={() => runFormat("H2")}
        title={disabledReason ?? "Heading"}
        type="button"
      >
        H2
      </button>
      <button
        aria-label="Subheading"
        className={styles.docToolButton}
        disabled={formatDisabled}
        onClick={() => runFormat("H3")}
        title={disabledReason ?? "Subheading"}
        type="button"
      >
        H3
      </button>
      <span aria-hidden="true" className={styles.docToolDivider} />
      <button
        aria-label="Bulleted list"
        className={styles.docToolButton}
        disabled={formatDisabled}
        onClick={() => runFormat("•—")}
        title={disabledReason ?? "Bulleted list"}
        type="button"
      >
        <ListGlyph />
      </button>
      <button
        aria-label="Add an image block"
        className={styles.docToolButton}
        onClick={onInsertImage}
        title="Add an image block"
        type="button"
      >
        <ImageGlyph />
      </button>
      <button
        aria-label="Add a video block"
        className={styles.docToolButton}
        onClick={onInsertVideo}
        title="Add a video block"
        type="button"
      >
        <VideoGlyph />
      </button>
    </div>
  );
}

function LessonDocument({
  api,
  assistantName,
  canEdit,
  lesson,
  lessonIndexInModule,
  moduleIndex,
  onAskAssistant,
  onRemovedBlock,
  removed,
}: {
  readonly api: EditorApi;
  readonly assistantName: string;
  readonly canEdit: boolean;
  readonly lesson: LearningLesson;
  readonly lessonIndexInModule: number;
  readonly moduleIndex: number;
  readonly onAskAssistant: (lessonId: string) => void;
  readonly onRemovedBlock: (id: string) => void;
  readonly removed: ReadonlySet<string>;
}) {
  const blocks = lesson.blocks.filter(
    (block) => !removed.has(block.contentBlockId),
  );

  const wordCount = useMemo(
    () =>
      blocks.reduce((sum, block) => {
        const preview = learningBlockPreview(block.type, block.content);
        return sum + preview.split(/\s+/u).filter((word) => word.length > 0).length;
      }, 0),
    [blocks],
  );

  const [activeEditor, setActiveEditor] = useState<ActiveEditor | null>(null);
  const [requestedBlockType, setRequestedBlockType] = useState<{
    readonly type: AuthoringBlockType;
    readonly token: number;
  } | null>(null);
  const addBlockRef = useRef<HTMLDivElement>(null);

  function handleEditingChange(
    block: LearningBlock,
    editing: boolean,
    node: HTMLLIElement | null,
  ) {
    if (editing && node !== null) {
      setActiveEditor({
        blockId: block.contentBlockId,
        node,
        isMarkdown:
          asBlockType(block.type) === "rich_text" &&
          isMarkdownBlockContent(block.content),
      });
      return;
    }
    setActiveEditor((previous) =>
      previous?.blockId === block.contentBlockId ? null : previous,
    );
  }

  function requestAddBlock(type: AuthoringBlockType) {
    setRequestedBlockType((previous) => ({
      type,
      token: (previous?.token ?? 0) + 1,
    }));
    addBlockRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const isLive = lesson.status === "published";
  // The mockup's pill just says "Live" (plus an "answering since <date>" this
  // product has no data for — see the brief; inventing a date was refused).
  const statusLabel = isLive
    ? "Live"
    : lesson.status === "archived"
      ? "Archived — hidden from learners"
      : "Draft — not visible to learners";

  return (
    <div className={styles.document}>
      <div className={styles.breadcrumbRow}>
        <span className={styles.crumb}>Module {moduleIndex + 1}</span>
        <span aria-hidden="true" className={styles.crumbSlash}>
          /
        </span>
        <span className={styles.crumb}>
          Lesson {moduleIndex + 1}.{lessonIndexInModule + 1}
        </span>
        <span
          className={cx(
            styles.statusPill,
            isLive ? styles.statusPillLive : styles.statusPillDraft,
          )}
        >
          <i aria-hidden="true" className={styles.statusDot} />
          {statusLabel}
        </span>
      </div>

      <h1 className={styles.lessonTitle}>{lesson.title}</h1>
      {/*
        The mockup's line here ("Last edited by you, 12 June · 1,140 words ·
        cited in 118 answers") mixes a real word count with two figures this
        product does not record yet (an editor identity/timestamp, and a
        citation count). Only the honestly computable half survives: block and
        word counts, both derived from the blocks actually rendered below.
      */}
      <p className={styles.lessonMeta}>
        {plural(blocks.length, "block")}
        {wordCount > 0
          ? ` · ~${wordCount.toLocaleString()} ${wordCount === 1 ? "word" : "words"}`
          : ""}
      </p>

      {canEdit ? (
        <DocumentToolbar
          activeEditor={activeEditor}
          onInsertImage={() => requestAddBlock("image")}
          onInsertVideo={() => requestAddBlock("video")}
        />
      ) : null}

      <div className={cx(panelStyles.editorRoot, styles.documentCard)}>
        {blocks.length === 0 ? (
          <EmptyState
            compact
            description={
              canEdit
                ? "Add a block to give this lesson content."
                : "This lesson has no content yet."
            }
            headline="No content blocks"
          />
        ) : (
          <ul className={cx(panelStyles.blockList, panelStyles.docBody)}>
            {blocks.map((block) => (
              <BlockRow
                api={api}
                block={block}
                canEdit={canEdit}
                key={block.contentBlockId}
                onEditingChange={(editing, node) =>
                  handleEditingChange(block, editing, node)
                }
                onRemoved={onRemovedBlock}
              />
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className={styles.addBlockSlot} ref={addBlockRef}>
            {/* Same honest limit as the outline editor: the authoring
                contract has no reorder RPC for blocks, only for modules and
                lessons, so none is offered here either. */}
            <p className={shared.meta}>
              Blocks keep their creation order — add, edit, and delete are
              reachable below; there is no reorder for blocks yet.
            </p>
            <AddBlockForm
              api={api}
              lessonId={lesson.lessonId}
              requestedOpen={requestedBlockType}
            />
          </div>
        ) : null}
      </div>

      {/* Preserved from the previous accordion view, unconditionally — every
          role could mark progress and ask the assistant from here, not just
          an author. */}
      <div className={shared.lessonActions}>
        <form action="/app/progress" method="post">
          <input name="lessonId" type="hidden" value={lesson.lessonId} />
          <input
            name="state"
            type="hidden"
            value={
              lesson.progressState === "completed" ? "in_progress" : "completed"
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
  );
}

/* ------------------------------------------------------------------------ */
/* Right: this lesson in the wild + versions                                */
/* ------------------------------------------------------------------------ */

type RevisionsState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly history: CourseRevisionHistory };

/** Same read `RevisionHistoryView` uses, kept independent so this compact
 *  rail can render without the full panel being open. `enabled` is false for
 *  a read-only viewer — the hook still runs (Rules of Hooks), it just never
 *  issues the request, since course revisions are an authoring concern the
 *  RPC itself only grants to an authoring role. */
function useCompactRevisions(api: EditorApi, enabled: boolean): RevisionsState {
  const [state, setState] = useState<RevisionsState>({ kind: "loading" });
  const versionSignal = api.busyKey;

  useEffect(() => {
    if (!enabled) return;
    if (versionSignal !== null) return;
    let active = true;
    setState({ kind: "loading" });
    void (async () => {
      const response = await postAuthoring<CourseRevisionHistory>({
        action: "course.revisions",
        courseId: api.courseId,
      });
      if (!active) return;
      if (!response.ok) {
        setState({
          kind: "failed",
          message:
            ERROR_COPY[response.code] ?? "The revision history could not be read.",
        });
        return;
      }
      setState({ kind: "ready", history: response.data });
    })();
    return () => {
      active = false;
    };
  }, [api.courseId, enabled, versionSignal]);

  return state;
}

/**
 * "This lesson in the wild" — reads `learning_lesson_reception` once per
 * course (it returns every lesson's numbers in one call) and looks up this
 * lesson's entry. The migration that defines the function may not be applied
 * to every database yet, and a lesson that was never cited simply has no key
 * in the response; both cases collapse to `entry: null` so the rail can show
 * one honest "not measured yet" state instead of guessing why the number is
 * missing.
 */
type ReceptionState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly entry: LessonReceptionEntry | null;
      /** The RPC's own reporting window, e.g. "last 90 days" — only present
       *  alongside a real entry, so it is never used to caption an absence. */
      readonly windowDays: number | null;
    };

function useLessonReception(
  api: EditorApi,
  lessonId: string | null,
): ReceptionState {
  const [state, setState] = useState<ReceptionState>({ kind: "loading" });
  const versionSignal = api.busyKey;

  useEffect(() => {
    if (lessonId === null) return;
    if (versionSignal !== null) return;
    let active = true;
    setState({ kind: "loading" });
    void (async () => {
      const response = await postAuthoring<LessonReceptionReport>({
        action: "lesson.reception",
        courseId: api.courseId,
      });
      if (!active) return;
      setState({
        kind: "ready",
        entry: response.ok ? (response.data.lessons[lessonId] ?? null) : null,
        windowDays: response.ok ? response.data.windowDays : null,
      });
    })();
    return () => {
      active = false;
    };
  }, [api.courseId, lessonId, versionSignal]);

  return state;
}

function LessonRail({
  api,
  canEdit,
  lessonId,
  onOpenFullHistory,
}: {
  readonly api: EditorApi;
  readonly canEdit: boolean;
  readonly lessonId: string | null;
  readonly onOpenFullHistory: () => void;
}) {
  const revisions = useCompactRevisions(api, canEdit);
  const reception = useLessonReception(api, lessonId);

  async function restore(revisionId: string) {
    await api.run(`rollback-${revisionId}`, {
      action: "course.rollback",
      courseId: api.courseId,
      targetRevisionId: revisionId,
    });
  }

  const entry = reception.kind === "ready" ? reception.entry : undefined;
  const windowLabel =
    reception.kind === "ready" && reception.windowDays !== null
      ? `Last ${reception.windowDays} days`
      : undefined;
  const notMeasured = "Not known — not measured yet.";

  return (
    <aside className={styles.rail}>
      <p className={styles.railKicker}>This lesson in the wild</p>
      {reception.kind === "loading" ? (
        <p className={shared.loading} role="status">
          Loading…
        </p>
      ) : (
        <div className={styles.wildCard}>
          <StatTile
            eyebrow="Retrieval"
            label="Answers cited it"
            {...(entry === null || entry === undefined
              ? { reason: notMeasured, state: "unknown" as const }
              : {
                  sublabel: windowLabel,
                  state: "known" as const,
                  value: entry.citationCount.toLocaleString(),
                })}
          />
          <StatTile
            eyebrow="Learner feedback"
            label="Rated helpful"
            {...(entry === null || entry === undefined
              ? // No entry at all: the RPC failed, or this lesson was never
                // cited (so it was never a candidate for a rating either).
                { reason: notMeasured, state: "unknown" as const }
              : entry.helpfulPercent === null
                ? // Cited, but nobody has rated an answer that cited it yet —
                  // a real, known fact, not an absent measurement. "0%" would
                  // misreport it as measured-and-bad.
                  {
                    sublabel: windowLabel,
                    state: "known" as const,
                    value: "Not rated yet",
                  }
                : {
                    sublabel: plural(entry.ratedCount, "rating"),
                    state: "known" as const,
                    value: `${entry.helpfulPercent}%`,
                  })}
          />
        </div>
      )}

      <div className={styles.calloutCard}>
        <p className={styles.calloutTitle}>Re-asked questions</p>
        <p className={styles.calloutBody}>
          Not known — this workspace does not yet detect when the same
          question keeps coming back for one specific lesson.
        </p>
      </div>

      {canEdit ? (
        <>
          {/*
            `learning_list_course_revisions` snapshots the whole course, not
            one lesson — restoring one rolls the entire outline back. "Course
            versions" says that plainly rather than implying a per-lesson
            history this RPC does not provide.
          */}
          <p className={styles.railKicker}>Course versions</p>
          {revisions.kind === "loading" ? (
            <p className={shared.loading} role="status">
              Loading versions…
            </p>
          ) : null}
          {revisions.kind === "failed" ? (
            <p className={styles.calloutBody}>{revisions.message}</p>
          ) : null}
          {revisions.kind === "ready" ? (
            revisions.history.revisions.length === 0 ? (
              <p className={styles.calloutBody}>No revisions recorded yet.</p>
            ) : (
              <ol className={styles.versionsList}>
                {revisions.history.revisions.slice(0, 3).map((revision) => {
                  const current =
                    revision.revisionId === revisions.history.headRevisionId;
                  return (
                    <li className={styles.versionRow} key={revision.revisionId}>
                      <span>
                        {new Date(revision.createdAt).toLocaleDateString(
                          undefined,
                          { day: "numeric", month: "short" },
                        )}{" "}
                        · {revision.revisionKind.replace("_", " ")}
                      </span>
                      {current ? (
                        <span className={styles.versionMeta}>current</span>
                      ) : (
                        <button
                          className={styles.versionAction}
                          disabled={api.locked}
                          onClick={() => void restore(revision.revisionId)}
                          type="button"
                        >
                          Restore
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )
          ) : null}
          <Button onClick={onOpenFullHistory} size="sm">
            Full history
          </Button>
        </>
      ) : null}
    </aside>
  );
}

export default LessonWorkspace;
