"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LEGACY_OVERLAP_WORDS,
  LEGACY_TARGET_WORDS,
} from "@course-ai/learning-pipeline";

import styles from "./page.module.css";

type ValidationIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  lessonId?: string;
  blockId?: string;
};

type AuthoringSnapshot = {
  course: {
    courseId: string;
    title: string;
    status: "draft" | "published" | "archived";
    version: number;
    modules: Array<{
      moduleId: string;
      title: string;
      lessons: Array<{
        lessonId: string;
        title: string;
        status: string;
        estimatedMinutes?: number;
        blocks: readonly unknown[];
      }>;
    }>;
  };
  lesson: {
    lessonId: string;
    title: string;
    status: string;
    estimatedMinutes?: number;
    blocks: readonly unknown[];
  };
  editorContent: string;
  validation: { valid: boolean; issues: ValidationIssue[] };
  publishValidation: { valid: boolean; issues: ValidationIssue[] };
  revisions: Array<{
    revisionId: string;
    version: number;
    kind: "created" | "edited" | "published" | "rolled_back";
    auditNote?: string;
    createdAt: string;
    rollbackTargetVersion?: number;
  }>;
  diagramCandidate: {
    candidateId: string;
    suggestedAltText?: string;
    suggestedCaption?: string;
    approved: boolean;
  };
  importWarnings?: readonly string[];
};

type NoticeTone = "neutral" | "success" | "error";

type LearningObjective = {
  id: string;
  text: string;
  covered: boolean;
};

type MasteryCheck = {
  id: string;
  prompt: string;
  evidence: "draft" | "reviewed";
};

type EvidenceState = "known" | "partial" | "blocked";

type KnowledgeQualitySnapshot = {
  chunkQuality: {
    state: EvidenceState;
    chunkCount: number;
    usableChunkCount: number;
  };
  objectiveAlignment: {
    state: EvidenceState;
    objectives: Array<{ state: EvidenceState }>;
  };
  retrievalReadiness: {
    state: EvidenceState;
    readyChunkCount: number;
    chunks: readonly unknown[];
  };
};

const initialContent =
  "A Minimum Day is the smallest credible version of your practice.\n\nOn a disrupted day, open your plan, choose one priority, and stop after two intentional minutes. This protects the restart loop without turning the minimum into the permanent target.\n\nAfter two consistent days, rebuild the fuller practice. Diagram: Disruption -> Minimum Day -> Evidence -> Momentum.";

export default function LearningWorkspace() {
  const [authoring, setAuthoring] = useState<AuthoringSnapshot>();
  const [selected, setSelected] = useState("lesson_minimum_day");
  const [content, setContent] = useState(initialContent);
  const [serverContent, setServerContent] = useState(initialContent);
  const [sourceCount, setSourceCount] = useState(1);
  const [job, setJob] = useState<"ready" | "running" | "published">("ready");
  const [notice, setNotice] = useState("Loading tenant-scoped authoring state…");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("neutral");
  const [tenantName, setTenantName] = useState("Northstar Academy");
  const [documentCount, setDocumentCount] = useState(1);
  const [chunkCount, setChunkCount] = useState(1);
  const [diagramCount, setDiagramCount] = useState(1);
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [newCourseTitle, setNewCourseTitle] = useState("");
  const [showIntake, setShowIntake] = useState(false);
  const [intakeKind, setIntakeKind] = useState<"notes" | "link">("notes");
  const [intakeTitle, setIntakeTitle] = useState("");
  const [intakeBody, setIntakeBody] = useState("");
  const [showNewLesson, setShowNewLesson] = useState(false);
  const [newLessonTitle, setNewLessonTitle] = useState("");
  const [importFormat, setImportFormat] = useState<"plain_text" | "markdown">(
    "plain_text",
  );
  const [embedUrl, setEmbedUrl] = useState("");
  const [diagramAltText, setDiagramAltText] = useState("");
  const [diagramCaption, setDiagramCaption] = useState("");
  const [activeVersionId, setActiveVersionId] = useState<string>();
  const [previousActiveVersionId, setPreviousActiveVersionId] =
    useState<string>();
  const [draftVersionId, setDraftVersionId] = useState<string>();
  const [objectiveDraft, setObjectiveDraft] = useState("");
  const [checkDraft, setCheckDraft] = useState("");
  const [retrievalQuery, setRetrievalQuery] = useState(
    "What should I do when my normal routine is disrupted?",
  );
  const [pipelineQuality, setPipelineQuality] =
    useState<KnowledgeQualitySnapshot>();
  const [objectives, setObjectives] = useState<LearningObjective[]>([
    {
      id: "objective_restart",
      text: "Choose a credible minimum action after disruption",
      covered: true,
    },
    {
      id: "objective_rebuild",
      text: "Explain when to rebuild the fuller practice",
      covered: true,
    },
  ]);
  const [masteryChecks, setMasteryChecks] = useState<MasteryCheck[]>([
    {
      id: "check_scenario",
      prompt: "Apply the Minimum Day to a disrupted-day scenario",
      evidence: "reviewed",
    },
    {
      id: "check_explain",
      prompt: "Explain why the minimum must not become the permanent target",
      evidence: "draft",
    },
  ]);

  const allLessons = useMemo(
    () =>
      authoring?.course.modules.flatMap((module) =>
        module.lessons.map((lesson) => ({
          ...lesson,
          moduleId: module.moduleId,
          moduleTitle: module.title,
        })),
      ) ?? [],
    [authoring],
  );
  const currentLesson =
    allLessons.find((lesson) => lesson.lessonId === selected) ?? allLessons[0];
  const currentModule =
    authoring?.course.modules.find((module) =>
      module.lessons.some((lesson) => lesson.lessonId === currentLesson?.lessonId),
    ) ?? authoring?.course.modules[0];
  const issues = authoring?.publishValidation.issues ?? [];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const dirty = content !== serverContent;
  const words = useMemo(
    () => content.trim().split(/\s+/u).filter(Boolean),
    [content],
  );
  const previewChunkCount =
    words.length <= LEGACY_TARGET_WORDS
      ? 1
      : 1 +
        Math.ceil(
          (words.length - LEGACY_TARGET_WORDS) /
            (LEGACY_TARGET_WORDS - LEGACY_OVERLAP_WORDS),
        );
  const coveredObjectives = objectives.filter((objective) => objective.covered).length;
  const reviewedChecks = masteryChecks.filter(
    (check) => check.evidence === "reviewed",
  ).length;
  const readinessChecks = [
    {
      label: "Knowledge",
      detail: pipelineQuality
        ? `${pipelineQuality.chunkQuality.usableChunkCount}/${pipelineQuality.chunkQuality.chunkCount} usable · ${pipelineQuality.chunkQuality.state}`
        : "Measuring active chunks",
      ready: pipelineQuality?.chunkQuality.state === "known",
    },
    {
      label: "Retrieval",
      detail: pipelineQuality
        ? `${pipelineQuality.retrievalReadiness.readyChunkCount}/${pipelineQuality.retrievalReadiness.chunks.length} ready · ${pipelineQuality.retrievalReadiness.state}`
        : "Checking provenance",
      ready: pipelineQuality?.retrievalReadiness.state === "known",
    },
    {
      label: "Grounding",
      detail: pipelineQuality
        ? `${pipelineQuality.objectiveAlignment.objectives.filter((objective) => objective.state === "known").length}/${pipelineQuality.objectiveAlignment.objectives.length} evidenced · ${pipelineQuality.objectiveAlignment.state}`
        : "Checking objective evidence",
      ready: pipelineQuality?.objectiveAlignment.state === "known",
    },
    {
      label: "Objectives",
      detail: `${coveredObjectives}/${objectives.length} mapped`,
      ready: objectives.length > 0 && coveredObjectives === objectives.length,
    },
    {
      label: "Mastery",
      detail: `${reviewedChecks}/${masteryChecks.length} reviewed`,
      ready:
        masteryChecks.length > 0 && reviewedChecks === masteryChecks.length,
    },
    {
      label: "Validation",
      detail: errors.length === 0 ? "No blockers" : `${errors.length} blocker(s)`,
      ready: errors.length === 0,
    },
  ];
  const readyCount = readinessChecks.filter((check) => check.ready).length;

  const previewChunks = useMemo(() => {
    const chunkSize = LEGACY_TARGET_WORDS;
    const overlap = LEGACY_OVERLAP_WORDS;
    const chunks: string[] = [];
    for (let start = 0; start < words.length && chunks.length < 3; start += chunkSize - overlap) {
      chunks.push(words.slice(start, start + chunkSize).join(" "));
    }
    return chunks.length > 0 ? chunks : ["No lesson text is available to preview."];
  }, [content]);

  const queryTerms = useMemo(
    () =>
      new Set(
        retrievalQuery
          .toLocaleLowerCase()
          .match(/[\p{L}\p{N}]+/gu)
          ?.filter((term) => term.length > 3) ?? [],
      ),
    [retrievalQuery],
  );

  const rankedPreviewChunks = useMemo(
    () =>
      previewChunks
        .map((chunk, index) => {
          const chunkTerms = new Set(
            chunk.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
          );
          const matched = [...queryTerms].filter((term) => chunkTerms.has(term));
          return { chunk, index, matched };
        })
        .sort((a, b) => b.matched.length - a.matched.length),
    [previewChunks, queryTerms],
  );

  function applySnapshot(snapshot: AuthoringSnapshot, replaceEditor = true) {
    setAuthoring(snapshot);
    setSelected(snapshot.lesson.lessonId);
    if (replaceEditor) {
      setContent(snapshot.editorContent);
      setServerContent(snapshot.editorContent);
    }
    if (!diagramAltText && snapshot.diagramCandidate.suggestedAltText) {
      setDiagramAltText(snapshot.diagramCandidate.suggestedAltText);
    }
    if (!diagramCaption && snapshot.diagramCandidate.suggestedCaption) {
      setDiagramCaption(snapshot.diagramCandidate.suggestedCaption);
    }
  }

  function showNotice(message: string, tone: NoticeTone = "neutral") {
    setNotice(message);
    setNoticeTone(tone);
  }

  function addObjective() {
    const text = objectiveDraft.trim();
    if (!text) return;
    setObjectives((current) => [
      ...current,
      { id: `objective_${crypto.randomUUID()}`, text, covered: false },
    ]);
    setObjectiveDraft("");
    showNotice("Objective added to this local review draft.");
  }

  function addMasteryCheck() {
    const prompt = checkDraft.trim();
    if (!prompt) return;
    setMasteryChecks((current) => [
      ...current,
      { id: `check_${crypto.randomUUID()}`, prompt, evidence: "draft" },
    ]);
    setCheckDraft("");
    showNotice("Mastery check added to this local review draft.");
  }

  async function parseAuthoringResponse(
    response: Response,
  ): Promise<AuthoringSnapshot> {
    const payload = (await response.json()) as AuthoringSnapshot & {
      code?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(
        `${payload.message ?? "Authoring command failed"}${
          payload.code ? ` · ${payload.code}` : ""
        }`,
      );
    }
    return payload;
  }

  async function postAuthoring(
    body: Record<string, unknown>,
  ): Promise<AuthoringSnapshot> {
    return parseAuthoringResponse(
      await fetch("/api/dev/authoring", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  useEffect(() => {
    void Promise.all([
      fetch("/api/dev/ingestion", { cache: "no-store" }).then((response) =>
        response.json(),
      ),
      fetch("/api/dev/platform", { cache: "no-store" }).then((response) =>
        response.json(),
      ),
      fetch("/api/dev/authoring", { cache: "no-store" }).then(
        parseAuthoringResponse,
      ),
    ])
      .then(([pipeline, platform, authoringSnapshot]) => {
        const ingestion = pipeline as {
          active?: {
            versionId: string;
            sequence: number;
            documents: Array<{ body: string }>;
            chunks: readonly unknown[];
            diagrams: readonly unknown[];
          };
          quality?: KnowledgeQualitySnapshot;
        };
        const tenant = platform as { tenant: { displayName: string } };
        setTenantName(tenant.tenant.displayName);
        applySnapshot(authoringSnapshot);
        setActiveVersionId(ingestion.active?.versionId);
        setPipelineQuality(ingestion.quality);
        if (ingestion.active) {
          setDocumentCount(ingestion.active.documents.length);
          setSourceCount(ingestion.active.documents.length);
          setChunkCount(ingestion.active.chunks.length);
          setDiagramCount(ingestion.active.diagrams.length);
          showNotice(
            `Course v${authoringSnapshot.course.version} and knowledge v${ingestion.active.sequence} verified`,
            "success",
          );
        }
      })
      .catch((error: unknown) =>
        showNotice(
          error instanceof Error ? error.message : "Authoring runtime unavailable.",
          "error",
        ),
      );
    // Development runtime is intentionally loaded once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadLesson(lessonId: string) {
    try {
      const snapshot = await parseAuthoringResponse(
        await fetch(
          `/api/dev/authoring?lessonId=${encodeURIComponent(lessonId)}`,
          { cache: "no-store" },
        ),
      );
      applySnapshot(snapshot);
      showNotice(`Loaded ${snapshot.lesson.title} from course v${snapshot.course.version}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Lesson could not load.", "error");
    }
  }

  async function saveDraft(
    version = authoring?.course.version,
  ): Promise<AuthoringSnapshot> {
    if (!authoring || version === undefined) {
      throw new Error("Authoring state is still loading.");
    }
    if (!dirty) return authoring;
    const snapshot = await postAuthoring({
      action: "import",
      lessonId: selected,
      expectedVersion: version,
      format: importFormat,
      content,
      idempotencyKey: `lesson-import-${crypto.randomUUID()}`,
    });
    applySnapshot(snapshot);
    return snapshot;
  }

  async function createCourse() {
    const title = newCourseTitle.trim();
    if (!title) {
      showNotice("Name the course before creating its private draft.", "error");
      return;
    }
    try {
      const response = await fetch("/api/dev/courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title,
          description: "New course draft",
          idempotencyKey: `course-create-${crypto.randomUUID()}`,
        }),
      });
      const payload = (await response.json()) as {
        course?: { version: number };
        message?: string;
      };
      if (!response.ok || !payload.course) {
        throw new Error(payload.message ?? "Course draft was not created.");
      }
      setShowNewCourse(false);
      setNewCourseTitle("");
      showNotice(
        `${title} created as private draft v${payload.course.version} · open it from Courses`,
        "success",
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Course creation failed.", "error");
    }
  }

  async function addLesson() {
    if (!authoring) return;
    try {
      const snapshot = await postAuthoring({
        action: "add_lesson",
        expectedVersion: authoring.course.version,
        title: newLessonTitle,
        idempotencyKey: `lesson-add-${crypto.randomUUID()}`,
      });
      applySnapshot(snapshot);
      setNewLessonTitle("");
      setShowNewLesson(false);
      showNotice(
        `${snapshot.lesson.title} added as a private draft in course v${snapshot.course.version}`,
        "success",
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Lesson was not added.", "error");
    }
  }

  async function formatLesson(
    format: "bold" | "italic" | "heading" | "list",
  ) {
    if (!authoring) return;
    try {
      const saved = await saveDraft();
      const snapshot = await postAuthoring({
        action: "format",
        lessonId: selected,
        expectedVersion: saved.course.version,
        format,
        idempotencyKey: `format-${format}-${crypto.randomUUID()}`,
      });
      applySnapshot(snapshot);
      showNotice(
        `${format} saved as structured blocks in draft v${snapshot.course.version}`,
        "success",
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Formatting failed.", "error");
    }
  }

  async function cleanContent() {
    if (!authoring) return;
    const cleaned = content
      .replace(/[ \t]+/gu, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    try {
      const snapshot = await postAuthoring({
        action: "import",
        lessonId: selected,
        expectedVersion: authoring.course.version,
        format: "plain_text",
        content: cleaned,
        idempotencyKey: `clean-import-${crypto.randomUUID()}`,
      });
      applySnapshot(snapshot);
      showNotice(
        `Content sanitized and saved in draft v${snapshot.course.version}`,
        "success",
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Content was not saved.", "error");
    }
  }

  async function addEmbed() {
    if (!authoring) return;
    try {
      const saved = await saveDraft();
      const snapshot = await postAuthoring({
        action: "add_embed",
        lessonId: selected,
        expectedVersion: saved.course.version,
        url: embedUrl,
        idempotencyKey: `embed-add-${crypto.randomUUID()}`,
      });
      applySnapshot(snapshot);
      setEmbedUrl("");
      showNotice(
        `HTTPS embed approved and saved in draft v${snapshot.course.version}`,
        "success",
      );
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Unsafe embed rejected.",
        "error",
      );
    }
  }

  async function approveDiagram() {
    if (!authoring) return;
    try {
      const saved = await saveDraft();
      const snapshot = await postAuthoring({
        action: "approve_diagram",
        lessonId: selected,
        expectedVersion: saved.course.version,
        altText: diagramAltText,
        caption: diagramCaption,
        idempotencyKey: `diagram-approve-${crypto.randomUUID()}`,
      });
      applySnapshot(snapshot);
      showNotice(
        `Diagram approved with accessible text in draft v${snapshot.course.version}`,
        "success",
      );
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Diagram approval failed.",
        "error",
      );
    }
  }

  async function addLearning() {
    const title = intakeTitle.trim();
    const body = intakeBody.trim();
    if (!title || !body) {
      showNotice("Name the source and add its notes or link before continuing.", "error");
      return;
    }
    if (intakeKind === "link" && !/^https:\/\//iu.test(body)) {
      showNotice("Links must use HTTPS so the source can be reviewed safely.", "error");
      return;
    }
    setJob("running");
    showNotice(
      intakeKind === "link"
        ? "Saving the reviewed link in the lesson…"
        : "New source added · validating, scanning and extracting",
    );
    try {
      if (intakeKind === "link") {
        const saved = await saveDraft();
        const snapshot = await postAuthoring({
          action: "add_embed",
          lessonId: selected,
          expectedVersion: saved.course.version,
          url: body,
          idempotencyKey: `source-link-${crypto.randomUUID()}`,
        });
        applySnapshot(snapshot);
        setShowIntake(false);
        setIntakeTitle("");
        setIntakeBody("");
        setJob("ready");
        showNotice(`${title} linked in the lesson draft · review before publishing`, "success");
        return;
      }
      const response = await fetch("/api/dev/ingestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "start",
          title,
          body,
          idempotencyKey: `source-${crypto.randomUUID()}`,
        }),
      });
      if (!response.ok) throw new Error("Ingestion failed.");
      const result = (await response.json()) as {
        job: {
          draftVersionId?: string;
          artifacts: { chunks: readonly unknown[] };
        };
      };
      setSourceCount((count) => count + 1);
      setDraftVersionId(result.job.draftVersionId);
      window.localStorage.setItem(
        "learningbot.dev.pendingKnowledge",
        JSON.stringify({ title, text: body }),
      );
      setShowIntake(false);
      setIntakeTitle("");
      setIntakeBody("");
      setJob("ready");
      showNotice(
        `Source ready · ${result.job.artifacts.chunks.length} chunks in a reviewable draft`,
        "success",
      );
    } catch {
      setJob("ready");
      showNotice("Source failed safely · active learning was not changed", "error");
    }
  }

  async function reingest() {
    if (!authoring) return;
    setJob("running");
    showNotice("Saving the authoring draft before selective re-ingest…");
    try {
      await saveDraft();
      const response = await fetch("/api/dev/ingestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reprocess",
          body: content,
          idempotencyKey: `lesson-reprocess-${crypto.randomUUID()}`,
        }),
      });
      if (!response.ok) throw new Error("Re-ingest failed.");
      const result = (await response.json()) as {
        result: {
          preview: { estimatedEmbeddingWrites: number };
          draftVersion: { versionId: string; sequence: number };
        };
      };
      setDraftVersionId(result.result.draftVersion.versionId);
      setJob("ready");
      showNotice(
        `Knowledge draft v${result.result.draftVersion.sequence} ready · ${result.result.preview.estimatedEmbeddingWrites} affected embeddings`,
        "success",
      );
    } catch (error) {
      setJob("ready");
      showNotice(
        error instanceof Error
          ? error.message
          : "Selective re-ingest failed safely.",
        "error",
      );
    }
  }

  async function previewValidation() {
    try {
      const saved = await saveDraft();
      showNotice(
        saved.publishValidation.valid
          ? `Validation passed · ${saved.publishValidation.issues.length} non-blocking warning(s)`
          : `Validation blocked · ${saved.publishValidation.issues.filter((issue) => issue.severity === "error").length} error(s)`,
        saved.publishValidation.valid ? "success" : "error",
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Validation failed.", "error");
    }
  }

  async function publish() {
    if (!authoring) return;
    showNotice("Validating and publishing the tenant course revision…");
    try {
      const saved = await saveDraft();
      if (!saved.publishValidation.valid) {
        applySnapshot(saved);
        showNotice(
          `Publish blocked by ${saved.publishValidation.issues.filter((issue) => issue.severity === "error").length} validation error(s)`,
          "error",
        );
        return;
      }
      if (
        draftVersionId &&
        (!pipelineQuality ||
          pipelineQuality.chunkQuality.state !== "known" ||
          pipelineQuality.retrievalReadiness.state !== "known")
      ) {
        showNotice(
          "Publish blocked: the knowledge draft is not retrieval-ready. Review or reprocess the source first.",
          "error",
        );
        return;
      }
      const published = await postAuthoring({
        action: "publish",
        expectedVersion: saved.course.version,
        auditNote: "Published from the Northstar creator workspace.",
        idempotencyKey: `course-publish-${crypto.randomUUID()}`,
      });
      applySnapshot(published);

      if (draftVersionId) {
        const response = await fetch("/api/dev/ingestion", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "publish",
            draftVersionId,
            expectedActiveVersionId: activeVersionId,
          }),
        });
        if (!response.ok) {
          showNotice(
            `Course v${published.course.version} published; knowledge publication conflicted and stayed unchanged`,
            "error",
          );
          return;
        }
        const result = (await response.json()) as {
          published: { versionId: string; sequence: number };
          quality?: KnowledgeQualitySnapshot;
        };
        setPreviousActiveVersionId(activeVersionId);
        setActiveVersionId(result.published.versionId);
        setDraftVersionId(undefined);
        setPipelineQuality(result.quality);
        const pendingKnowledge = window.localStorage.getItem(
          "learningbot.dev.pendingKnowledge",
        );
        if (pendingKnowledge) {
          window.localStorage.setItem(
            "learningbot.dev.activeKnowledge",
            pendingKnowledge,
          );
          window.localStorage.removeItem("learningbot.dev.pendingKnowledge");
        }
        showNotice(
          `Course v${published.course.version} and knowledge v${result.published.sequence} published`,
          "success",
        );
      } else {
        showNotice(
          `Course v${published.course.version} published · no knowledge re-index was pending`,
          "success",
        );
      }
      setJob("published");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Publish failed.", "error");
    }
  }

  async function rollbackTo(targetVersion: number) {
    if (!authoring) return;
    try {
      const snapshot = await postAuthoring({
        action: "rollback",
        expectedVersion: authoring.course.version,
        targetVersion,
        auditNote: `Rolled back to reviewed course revision v${targetVersion}.`,
        idempotencyKey: `course-rollback-${targetVersion}-${crypto.randomUUID()}`,
      });
      applySnapshot(snapshot);
      showNotice(
        `Course restored from v${targetVersion} as new draft v${snapshot.course.version}`,
        "success",
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Rollback failed.", "error");
    }
  }

  async function rollback() {
    const previous =
      authoring?.revisions
        .filter((revision) => revision.version < (authoring?.course.version ?? 0))
        .at(-1)?.version;
    if (previous === undefined) {
      showNotice("No prior authoring revision is available.", "error");
      return;
    }
    await rollbackTo(previous);
    if (previousActiveVersionId && activeVersionId) {
      try {
        const response = await fetch("/api/dev/ingestion", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "rollback",
            targetVersionId: previousActiveVersionId,
            expectedActiveVersionId: activeVersionId,
          }),
        });
        if (response.ok) {
          const result = (await response.json()) as {
            rolledBack: { versionId: string };
            quality?: KnowledgeQualitySnapshot;
          };
          setActiveVersionId(result.rolledBack.versionId);
          setPreviousActiveVersionId(undefined);
          setPipelineQuality(result.quality);
        }
      } catch {
        showNotice(
          `Course rolled back; knowledge rollback could not be confirmed`,
          "error",
        );
      }
    }
  }

  const stages = [
    ["Sources", `${sourceCount} accepted`],
    ["Safety", "Fixture boundary"],
    ["Extracted", `${documentCount} document${documentCount === 1 ? "" : "s"}`],
    [
      "Chunked",
      job === "running"
        ? "Updating…"
        : `${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`,
    ],
    ["Retrieval", draftVersionId ? "Draft to review" : "Active version"],
    ["Learning", `${coveredObjectives}/${objectives.length} objectives`],
  ];

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.logo}>L</span>
          <span>Learning OS</span>
        </div>
        <nav aria-label="Workspace">
          <a href="/">Overview</a>
          <a className={styles.active} href="/dev/learning">Courses</a>
          <a href="#sources">Sources</a>
          <a href="/dev/chat">Assistant</a>
          <a href="/dev/teacher">Students</a>
        </nav>
        <div className={styles.tenant}>
          <span>NA</span>
          <div><strong>{tenantName}</strong><small>Creator workspace</small></div>
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>Courses / {authoring?.course.status ?? "loading"}</p>
            <h1>{authoring?.course.title ?? "Momentum Method"}</h1>
          </div>
          <div className={styles.headerActions}>
            <button className={styles.secondary} onClick={() => void rollback()}>Rollback</button>
            <button className={styles.publish} onClick={() => void publish()}>Publish changes</button>
          </div>
        </header>

        <div
          className={`${styles.statusbar} ${
            noticeTone === "error"
              ? styles.statusError
              : noticeTone === "success"
                ? styles.statusSuccess
                : ""
          }`}
          role={noticeTone === "error" ? "alert" : "status"}
        >
          <span className={job === "running" ? styles.pulse : styles.dot} />
          <strong>{notice}</strong>
          <span>{dirty ? "Unsaved editor" : "Draft saved"}</span>
          <span>{errors.length} blocking</span>
          <span>{warnings.length} warnings</span>
        </div>

        <section className={styles.readiness} aria-label="Learning readiness">
          <div className={styles.readinessIntro}>
            <div>
              <p className={styles.eyebrow}>Evidence review · local fixture</p>
              <h2>{readyCount === readinessChecks.length ? "Ready for human publish review" : "Learning review in progress"}</h2>
            </div>
            <strong>{readyCount}/{readinessChecks.length}</strong>
          </div>
          <div className={styles.readinessChecks}>
            {readinessChecks.map((check) => (
              <div className={check.ready ? styles.readinessReady : styles.readinessPending} key={check.label}>
                <span aria-hidden="true">{check.ready ? "✓" : "○"}</span>
                <div><strong>{check.label}</strong><small>{check.detail}</small></div>
              </div>
            ))}
          </div>
          <p className={styles.fixtureNote}>
            This workspace uses tenant-scoped development fixtures. Readiness reflects the loaded fixture and local review state, not live learner outcomes or production vector evaluation.
          </p>
        </section>

        {showNewCourse ? (
          <section className={styles.quickCreate} aria-label="Create course">
            <div><p className={styles.eyebrow}>Private by default</p><h2>Create a course draft</h2></div>
            <input aria-label="New course title" placeholder="Course title" value={newCourseTitle} onChange={(event) => setNewCourseTitle(event.target.value)} />
            <button className={styles.secondary} onClick={() => setShowNewCourse(false)}>Cancel</button>
            <button className={styles.publish} onClick={() => void createCourse()}>Create draft</button>
          </section>
        ) : null}

        <section className={styles.pipeline} id="sources" aria-label="Ingestion pipeline">
          <div className={styles.pipelineHeading}>
            <div>
              <p className={styles.eyebrow}>Source → knowledge → training</p>
              <h2>Course knowledge pipeline</h2>
              <p className={styles.sectionCopy}>Active retrieval stays on the last published version while changes are cleaned, chunked and reviewed.</p>
            </div>
            <div className={styles.headerActions}>
              <button className={styles.secondary} onClick={() => setShowNewCourse(true)}>＋ New course</button>
              <button className={styles.add} onClick={() => setShowIntake((current) => !current)}>＋ Add learning</button>
            </div>
          </div>
          <div className={styles.stages}>
            {stages.map(([label, value], index) => (
              <div className={styles.stage} key={label}>
                <span className={index === 3 && job === "running" ? styles.spinner : styles.check}>
                  {index === 3 && job === "running" ? "" : "✓"}
                </span>
                <div><strong>{label}</strong><small>{value}</small></div>
                {index < stages.length - 1 && <i />}
              </div>
            ))}
          </div>
        </section>

        {showIntake ? (
          <section className={styles.intakePanel} aria-label="Add learning source">
            <div>
              <p className={styles.eyebrow}>Simple source intake</p>
              <h2>Bring in something useful.</h2>
              <p>LearningBot will keep the source attached, clean it into reviewable knowledge, and leave publishing in your hands.</p>
            </div>
            <div className={styles.intakeModes} role="tablist" aria-label="Source type">
              <button className={intakeKind === "notes" ? styles.intakeModeActive : ""} onClick={() => setIntakeKind("notes")} role="tab" aria-selected={intakeKind === "notes"}>Paste or write</button>
              <button className={intakeKind === "link" ? styles.intakeModeActive : ""} onClick={() => setIntakeKind("link")} role="tab" aria-selected={intakeKind === "link"}>Add a link</button>
              <a href="/dev/admin#mcp">Connect MCP <span aria-hidden="true">↗</span></a>
            </div>
            <div className={styles.intakeFields}>
              <label>Source name<input value={intakeTitle} onChange={(event) => setIntakeTitle(event.target.value)} placeholder="e.g. Customer onboarding notes" /></label>
              <label>{intakeKind === "link" ? "HTTPS link" : "Source material"}<textarea value={intakeBody} onChange={(event) => setIntakeBody(event.target.value)} placeholder={intakeKind === "link" ? "https://…" : "Paste notes, a transcript, or a clean draft…"} /></label>
            </div>
            <div className={styles.intakeFooter}><span>Private draft · human review before publish</span><div><button className={styles.secondary} onClick={() => setShowIntake(false)}>Cancel</button><button className={styles.publish} onClick={() => void addLearning()}>Clean &amp; add</button></div></div>
          </section>
        ) : null}

        <section className={styles.knowledgeLab} aria-label="Knowledge and training review">
          <article className={styles.objectivesPanel}>
            <div className={styles.labHeading}>
              <div><p className={styles.eyebrow}>Teach with intent</p><h2>Objectives &amp; mastery</h2></div>
              <span>{coveredObjectives}/{objectives.length} review-mapped</span>
            </div>
            <p className={styles.sectionCopy}>Every lesson should state what changes for the learner and how a reviewer can verify it.</p>

            <div className={styles.learningColumns}>
              <div>
                <h3>Learning objectives</h3>
                <div className={styles.reviewList}>
                  {objectives.map((objective) => (
                    <label key={objective.id}>
                      <input
                        type="checkbox"
                        checked={objective.covered}
                        onChange={() =>
                          setObjectives((current) =>
                            current.map((item) =>
                              item.id === objective.id
                                ? { ...item, covered: !item.covered }
                                : item,
                            ),
                          )
                        }
                      />
                      <span>{objective.text}<small>{objective.covered ? "Mapped to lesson evidence" : "Needs lesson evidence"}</small></span>
                    </label>
                  ))}
                </div>
                <div className={styles.compactComposer}>
                  <input
                    aria-label="New learning objective"
                    placeholder="Learner can…"
                    value={objectiveDraft}
                    onChange={(event) => setObjectiveDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addObjective();
                    }}
                  />
                  <button onClick={addObjective}>Add</button>
                </div>
              </div>

              <div>
                <h3>Mastery checks</h3>
                <div className={styles.reviewList}>
                  {masteryChecks.map((check) => (
                    <button
                      className={styles.masteryRow}
                      key={check.id}
                      onClick={() =>
                        setMasteryChecks((current) =>
                          current.map((item) =>
                            item.id === check.id
                              ? {
                                  ...item,
                                  evidence:
                                    item.evidence === "reviewed" ? "draft" : "reviewed",
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <span>{check.evidence === "reviewed" ? "✓" : "○"}</span>
                      <strong>{check.prompt}<small>{check.evidence === "reviewed" ? "Evidence reviewed" : "Needs answer criteria"}</small></strong>
                    </button>
                  ))}
                </div>
                <div className={styles.compactComposer}>
                  <input
                    aria-label="New mastery check"
                    placeholder="Ask the learner to…"
                    value={checkDraft}
                    onChange={(event) => setCheckDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addMasteryCheck();
                    }}
                  />
                  <button onClick={addMasteryCheck}>Add</button>
                </div>
              </div>
            </div>
          </article>

          <article className={styles.retrievalPanel}>
            <div className={styles.labHeading}>
              <div><p className={styles.eyebrow}>Grounding check</p><h2>Retrieval preview</h2></div>
              <span>Local lexical preview</span>
            </div>
            <p className={styles.sectionCopy}>Test whether lesson language can support a representative learner question before re-indexing.</p>
            <label className={styles.queryField}>
              <span>Representative learner question</span>
              <textarea
                value={retrievalQuery}
                onChange={(event) => setRetrievalQuery(event.target.value)}
              />
            </label>
            <div className={styles.chunkMeta}>
              <span><strong>{previewChunkCount}</strong> preview chunk{previewChunkCount === 1 ? "" : "s"}</span>
              <span><strong>{LEGACY_TARGET_WORDS}</strong> words / chunk</span>
              <span><strong>{LEGACY_OVERLAP_WORDS}</strong> word overlap</span>
            </div>
            <div className={styles.chunkResults}>
              {rankedPreviewChunks.slice(0, 2).map((result, rank) => (
                <div key={`${result.index}:${result.chunk.slice(0, 20)}`}>
                  <span>#{rank + 1} · lesson chunk {result.index + 1}</span>
                  <p>{result.chunk}</p>
                  <small>
                    {result.matched.length > 0
                      ? `Shared terms: ${result.matched.join(", ")}`
                      : "No meaningful shared terms · revise the lesson or query"}
                  </small>
                </div>
              ))}
            </div>
            <p className={styles.fixtureNote}>This quick check is deterministic and local. It does not claim semantic similarity, embedding quality or production retrieval readiness.</p>
          </article>
        </section>

        <div className={styles.editorGrid}>
          <aside className={styles.outline}>
            <div className={styles.panelTitle}>
              <div><p className={styles.eyebrow}>Course outline</p><h2>{currentModule?.title ?? "Build Your Rhythm"}</h2></div>
              <button aria-label="Add lesson" onClick={() => setShowNewLesson(true)}>＋</button>
            </div>
            {showNewLesson ? (
              <div className={styles.inlineForm}>
                <input aria-label="New lesson title" placeholder="Lesson title" value={newLessonTitle} onChange={(event) => setNewLessonTitle(event.target.value)} />
                <div><button onClick={() => setShowNewLesson(false)}>Cancel</button><button onClick={() => void addLesson()}>Add</button></div>
              </div>
            ) : null}
            <p className={styles.moduleLabel}>{currentModule?.title ?? "Build Your Rhythm"}</p>
            {allLessons.map((lesson, index) => (
              <button
                className={selected === lesson.lessonId ? styles.lessonSelected : styles.lesson}
                key={lesson.lessonId}
                onClick={() => void loadLesson(lesson.lessonId)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{lesson.title}</strong><small>{lesson.estimatedMinutes ?? "—"} min · {lesson.status}</small></div>
              </button>
            ))}
          </aside>

          <section className={styles.editor}>
            <div className={styles.editorHeading}>
              <div>
                <p className={styles.eyebrow}>Lesson authoring · {importFormat.replace("_", " ")}</p>
                <h2>{currentLesson?.title ?? "Minimum Day"}</h2>
              </div>
              <span className={styles.health}>{dirty ? "Unsaved draft" : "Version controlled"}</span>
            </div>
            <div className={styles.toolbar} aria-label="Formatting toolbar">
              <button aria-label="Bold lesson text" onClick={() => void formatLesson("bold")}><b>B</b></button>
              <button aria-label="Italicize lesson text" onClick={() => void formatLesson("italic")}><i>I</i></button>
              <button aria-label="Make first block a heading" onClick={() => void formatLesson("heading")}>H2</button>
              <button aria-label="Convert lesson to list" onClick={() => void formatLesson("list")}>☷</button>
              <select aria-label="Import format" value={importFormat} onChange={(event) => setImportFormat(event.target.value as "plain_text" | "markdown")}>
                <option value="plain_text">Plain text</option>
                <option value="markdown">Markdown</option>
              </select>
              <span />
              <small>{words.length} words · {currentLesson?.blocks.length ?? 0} blocks · ⌘S save</small>
            </div>
            <textarea
              aria-label="Lesson content"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                showNotice("Unsaved editor changes · live course remains unchanged");
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
                  event.preventDefault();
                  void saveDraft()
                    .then((snapshot) =>
                      showNotice(
                        `Lesson saved in private course draft v${snapshot.course.version}`,
                        "success",
                      ),
                    )
                    .catch((error: unknown) =>
                      showNotice(
                        error instanceof Error ? error.message : "Lesson could not save.",
                        "error",
                      ),
                    );
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void previewValidation();
                }
              }}
            />
            <div className={styles.suggestion}>
              <span>✦</span>
              <div><strong>Safe import boundary</strong><p>Formatting is sanitized and saved as provider-neutral rich-text blocks.</p></div>
              <button onClick={() => void cleanContent()}>Clean &amp; save</button>
            </div>
            <footer className={styles.editorFooter}>
              <p>⌘S saves the lesson. ⌘↵ validates. Authoring and retrieval versions remain separate and rollback-safe.</p>
              <div>
                <button className={styles.secondary} onClick={() => void previewValidation()}>Validate</button>
                <button className={styles.reingest} onClick={() => void reingest()}>↻ Re-ingest lesson</button>
              </div>
            </footer>
          </section>

          <aside className={styles.inspector}>
            <p className={styles.eyebrow}>Validation &amp; revisions</p>
            <h2>{authoring?.publishValidation.valid ? "Ready to publish" : `${errors.length} blockers`}</h2>
            <div className={styles.score}><strong>{currentLesson?.blocks.length ?? 0}</strong><span>Structured authoring<br />blocks</span></div>

            <div className={styles.issueList}>
              {issues.length === 0 ? <p className={styles.good}>No validation issues</p> : issues.slice(0, 4).map((issue) => (
                <p className={issue.severity === "error" ? styles.issueError : styles.issueWarning} key={`${issue.code}:${issue.blockId ?? issue.lessonId ?? ""}`}>
                  <strong>{issue.severity}</strong> {issue.message}
                </p>
              ))}
            </div>

            <div className={styles.safetyPanel}>
              <strong>External embed</strong>
              <input aria-label="External embed URL" placeholder="https://youtube.com/…" value={embedUrl} onChange={(event) => setEmbedUrl(event.target.value)} />
              <button className={styles.full} onClick={() => void addEmbed()}>Validate &amp; add embed</button>
              <small>HTTPS allowlist only. Unsafe schemes, private hosts, and unapproved providers fail visibly.</small>
            </div>

            <div className={styles.diagram}>
              <span>Disruption</span><i>→</i><span>Minimum</span><i>→</i><span>Evidence</span><i>→</i><span>Momentum</span>
            </div>
            <div className={styles.safetyPanel}>
              <strong>{authoring?.diagramCandidate.approved ? "Diagram approved" : "Diagram candidate"}</strong>
              <input aria-label="Diagram alt text" placeholder="Meaningful alt text required" value={diagramAltText} onChange={(event) => setDiagramAltText(event.target.value)} disabled={authoring?.diagramCandidate.approved} />
              <input aria-label="Diagram caption" placeholder="Caption required" value={diagramCaption} onChange={(event) => setDiagramCaption(event.target.value)} disabled={authoring?.diagramCandidate.approved} />
              <button className={styles.full} onClick={() => void approveDiagram()} disabled={authoring?.diagramCandidate.approved}>
                {authoring?.diagramCandidate.approved ? "Approved with accessibility text" : "Approve diagram"}
              </button>
            </div>

            <div className={styles.revisions}>
              <strong>Immutable revisions</strong>
              {[...(authoring?.revisions ?? [])].reverse().slice(0, 4).map((revision, index) => (
                <div key={revision.revisionId}>
                  <span>v{revision.version} · {revision.kind.replace("_", " ")}</span>
                  {index > 0 ? <button onClick={() => void rollbackTo(revision.version)}>Restore</button> : <small>current</small>}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
