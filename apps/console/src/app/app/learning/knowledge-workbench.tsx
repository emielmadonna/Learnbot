"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  allDiagramFlagsReviewed,
  prepareKnowledgeDraft,
  reviewDiagramFlag,
} from "../../../lib/knowledge-ingestion";
import type {
  DiagramReviewState,
  KnowledgeSourceFormat,
} from "../../../lib/knowledge-ingestion";
import styles from "./page.module.css";

const initialText = `# The learning loop

Use a short cycle to turn a new idea into a reliable habit.

1. Notice the idea
2. Try it in a small situation
3. Reflect on what changed
4. Repeat with one adjustment`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default function KnowledgeWorkbench({
  assistantName,
  tenantName,
}: {
  assistantName: string;
  tenantName: string;
}) {
  const [format, setFormat] = useState<KnowledgeSourceFormat>("markdown");
  const [sourceName, setSourceName] = useState("Pasted course material");
  const [rawText, setRawText] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [moduleTitle, setModuleTitle] = useState("Imported material");
  const [lessonTitle, setLessonTitle] = useState("Cleaned course knowledge");
  const [diagramTitle, setDiagramTitle] = useState("");
  const [diagramSteps, setDiagramSteps] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparedCourseId, setPreparedCourseId] = useState<string | null>(null);
  const [diagramReviews, setDiagramReviews] = useState<Record<string, DiagramReviewState>>({});
  const draft = useMemo(
    () =>
      prepareKnowledgeDraft({
        sourceName,
        format,
        text: rawText,
        title,
        description,
      }),
    [description, format, rawText, sourceName, title],
  );
  const reviewedDraft = useMemo(
    () =>
      Object.entries(diagramReviews).reduce(
        (current, [flagId, state]) =>
          state === "pending" ? current : reviewDiagramFlag(current, flagId, state),
        draft,
      ),
    [diagramReviews, draft],
  );

  function setText(value: string, nextSourceName = sourceName) {
    setRawText(value);
    setSourceName(nextSourceName);
    setPreparedCourseId(null);
    setMessage(null);
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.toLocaleLowerCase().split(".").at(-1);
    setFormat(extension === "csv" ? "csv" : extension === "md" || extension === "markdown" ? "markdown" : "text");
    setText(await file.text(), file.name);
  }

  function review(flagId: string, state: Exclude<DiagramReviewState, "pending">) {
    setDiagramReviews((current) => ({ ...current, [flagId]: state }));
    setMessage(state === "accepted" ? "Diagram candidate kept for review." : "Diagram candidate dismissed.");
  }

  async function prepareVersion() {
    if (!reviewedDraft.normalizedText || reviewedDraft.stats.wordCount < 4) {
      setMessage("Add a little more course material before preparing a draft.");
      return;
    }
    if (!allDiagramFlagsReviewed(reviewedDraft)) {
      setMessage("Review each diagram-worthy flag before preparing the course draft.");
      return;
    }
    setBusy(true);
    setMessage("Preparing a private course draft…");
    try {
      const response = await fetch("/api/learning/knowledge/prepare", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: reviewedDraft.title,
          description: reviewedDraft.description,
          moduleTitle,
          lessonTitle,
          lessonContent: [
            reviewedDraft.normalizedText,
            diagramTitle.trim() && diagramSteps.trim()
              ? `\n\n\`\`\`diagram\n${diagramTitle.trim()}\n${diagramSteps.trim()}\n\`\`\``
              : "",
          ].filter(Boolean).join(""),
          sourceName: reviewedDraft.sourceName,
          sourceFormat: reviewedDraft.format,
          diagramReview: reviewedDraft.diagramFlags,
        }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isRecord(payload) || typeof payload.courseId !== "string") {
        throw new Error(
          isRecord(payload) && payload.code === "tenant_selection_required"
            ? "Select a client workspace before preparing knowledge."
            : "The private course draft could not be prepared.",
        );
      }
      setPreparedCourseId(payload.courseId);
      setMessage("Private course draft prepared. Embeddings were not requested in this lane.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The course draft could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <div>
          <Link className={styles.back} href="/app">← Workspace</Link>
          <p className={styles.eyebrow}>Client knowledge lane</p>
          <h1>Prepare knowledge for teaching</h1>
        </div>
        <div className={styles.identity}>
          <span className={styles.logo}>{assistantName.slice(0, 1)}</span>
          <span><b>{assistantName}</b><small>{tenantName}</small></span>
        </div>
      </header>

      <section className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>Import · clean · review · prepare</p>
          <h2>Turn course material into a reviewable draft.</h2>
          <p>
            Paste or import text, Markdown, or CSV. This workspace normalizes the material locally,
            calls out likely gaps, duplicates, and noise, and makes diagram-worthy sections explicit
            before anything becomes a course draft.
          </p>
        </div>
        <aside>
          <strong>Provider boundary</strong>
          <p>Cleaning and flags run locally. Embeddings and retrieval are not available in this flow unless a separate configured ingestion worker is enabled.</p>
        </aside>
      </section>

      <section className={styles.grid}>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>01</span><div><p className={styles.eyebrow}>Source</p><h2>Bring in the material</h2></div></div>
          <label className={styles.fileDrop}>
            <span>Choose a text, Markdown, or CSV file</span>
            <small>Nothing is published by importing it here.</small>
            <input type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv" onChange={(event) => void loadFile(event.target.files?.[0])} />
          </label>
          <div className={styles.controls}>
            <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as KnowledgeSourceFormat)}><option value="text">Plain text</option><option value="markdown">Markdown</option><option value="csv">CSV</option></select></label>
            <label><span>Source label</span><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
          </div>
          <label><span>Paste course material</span><textarea value={rawText} onChange={(event) => setText(event.target.value)} placeholder={initialText} /></label>
          <button className={styles.secondaryButton} type="button" onClick={() => setText(initialText, "Example learning loop.md")}>Use a small example</button>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHeader}><span>02</span><div><p className={styles.eyebrow}>Cleaned preview</p><h2>See what will be prepared</h2></div></div>
          <div className={styles.stats}>
            <div><strong>{reviewedDraft.stats.wordCount}</strong><small>words</small></div>
            <div><strong>{reviewedDraft.sections.length}</strong><small>sections</small></div>
            <div><strong>{reviewedDraft.issues.length}</strong><small>flags</small></div>
          </div>
          <div className={styles.preview}><pre>{draft.normalizedText || "Your cleaned preview will appear here."}</pre></div>
          <div className={styles.boundaryNote}><span>Local cleaning complete</span><small>Deterministic normalization only · no embeddings requested</small></div>
        </article>
      </section>

      <section className={styles.reviewGrid}>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>03</span><div><p className={styles.eyebrow}>Quality review</p><h2>Resolve what needs attention</h2></div></div>
          {reviewedDraft.issues.length ? <div className={styles.issueList}>{reviewedDraft.issues.map((issue) => <div className={styles.issue} data-severity={issue.severity} key={issue.issueId}><span>{issue.severity === "error" ? "!" : "·"}</span><div><strong>{issue.message}</strong><small>{issue.kind.replaceAll("_", " ")}{issue.evidence ? ` · ${issue.evidence}` : ""}</small></div></div>)}</div> : <p className={styles.empty}>No missing, duplicate, or noisy sections were found.</p>}
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>04</span><div><p className={styles.eyebrow}>Diagram review</p><h2>Decide what deserves a visual</h2></div></div>
          {reviewedDraft.diagramFlags.length ? <div className={styles.diagramList}>{reviewedDraft.diagramFlags.map((flag) => <div className={styles.diagramFlag} key={flag.flagId}><div><strong>{flag.title}</strong><small>{flag.evidence}</small></div><div className={styles.flagActions}><button type="button" data-active={flag.state === "accepted"} onClick={() => review(flag.flagId, "accepted")}>Keep</button><button type="button" data-active={flag.state === "dismissed"} onClick={() => review(flag.flagId, "dismissed")}>Dismiss</button></div></div>)}</div> : <p className={styles.empty}>No diagram-worthy structures were detected. That is okay for a text-first lesson.</p>}
          <p className={styles.muted}>Keep detected diagram-worthy ideas, or add a simple teaching diagram manually below. It stays in the private draft until you publish.</p>
          <div className={styles.diagramEditor}>
            <strong>Add a diagram manually</strong>
            <small>Use arrows between steps, for example: Notice → Try → Reflect → Repeat.</small>
            <input value={diagramTitle} onChange={(event) => setDiagramTitle(event.target.value)} placeholder="Diagram title" />
            <textarea value={diagramSteps} onChange={(event) => setDiagramSteps(event.target.value)} placeholder="Notice → Try → Reflect → Repeat" rows={3} />
          </div>
        </article>
      </section>

      <section className={styles.prepareCard}>
        <div><p className={styles.eyebrow}>05 · Publishable version</p><h2>Prepare a private course draft</h2><p>Set the course framing, then save the cleaned material through the existing client-scoped learning RPC. Publishing remains a separate explicit action.</p></div>
        <div className={styles.formGrid}><label><span>Course title</span><input value={title || draft.title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Description</span><input value={description || draft.description} onChange={(event) => setDescription(event.target.value)} /></label><label><span>Module</span><input value={moduleTitle} onChange={(event) => setModuleTitle(event.target.value)} /></label><label><span>Lesson</span><input value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} /></label></div>
        <footer><p role="status">{message ?? "Review the flags, then prepare a private draft for this client workspace."}</p><button className={styles.primaryButton} type="button" disabled={busy || !rawText.trim() || !allDiagramFlagsReviewed(reviewedDraft)} onClick={() => void prepareVersion()}>{busy ? "Preparing…" : "Prepare private draft"}</button></footer>
        {preparedCourseId ? <div className={styles.success}><strong>Draft ready.</strong><span>Open the workspace to inspect it and publish when the content is ready.</span><Link href="/app#courses">Open course workspace →</Link></div> : null}
      </section>
    </main>
  );
}
