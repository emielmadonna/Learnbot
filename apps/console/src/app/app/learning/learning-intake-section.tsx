"use client";

import { useMemo, useState } from "react";
import {
  agentAssistedStarter,
  allDiagramFlagsReviewed,
  prepareKnowledgeDraft,
  reviewDiagramFlag,
} from "../../../lib/knowledge-ingestion";
import type { DiagramReviewState, KnowledgeSourceFormat } from "../../../lib/knowledge-ingestion";
import styles from "./learning-intake-section.module.css";

type IntakePath = "agent" | "paste" | "youtube" | "file";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validYoutubeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com") || url.hostname === "youtu.be");
  } catch {
    return false;
  }
}

export function LearningIntakeSection({ tenantName }: { tenantName: string }) {
  const [path, setPath] = useState<IntakePath>("agent");
  const [format, setFormat] = useState<KnowledgeSourceFormat>("markdown");
  const [goal, setGoal] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [sourceName, setSourceName] = useState("Pasted course material");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [moduleTitle, setModuleTitle] = useState("Imported material");
  const [lessonTitle, setLessonTitle] = useState("Cleaned course knowledge");
  const [reviews, setReviews] = useState<Record<string, DiagramReviewState>>({});
  const [status, setStatus] = useState("Choose an intake path for this tenant.");
  const [busy, setBusy] = useState(false);
  const [courseId, setCourseId] = useState<string | null>(null);

  const draft = useMemo(
    () => prepareKnowledgeDraft({ sourceName, format, text, title, description }),
    [description, format, sourceName, text, title],
  );
  const reviewed = useMemo(
    () => Object.entries(reviews).reduce(
      (current, [flagId, state]) => state === "pending" ? current : reviewDiagramFlag(current, flagId, state),
      draft,
    ),
    [draft, reviews],
  );

  function replaceText(value: string, name = sourceName) {
    setText(value);
    setSourceName(name);
    setReviews({});
    setCourseId(null);
    setStatus("Material loaded locally. Review the cleaned preview.");
  }

  function selectPath(next: IntakePath) {
    setPath(next);
    setStatus(next === "youtube"
      ? "YouTube is recorded as a source pointer; transcript extraction is not enabled here."
      : "Add material to begin local cleaning.");
  }

  function createStarter() {
    replaceText(agentAssistedStarter(goal), "Agent-assisted local outline.md");
    setFormat("markdown");
    setStatus("Local starter created. No model call was made; add trusted material before publishing.");
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.toLocaleLowerCase().split(".").at(-1);
    if (extension === "docx" || extension === "pdf") {
      setStatus("This document format needs a configured extractor. Paste readable text to continue.");
      return;
    }
    setFormat(extension === "csv" ? "csv" : extension === "md" || extension === "markdown" ? "markdown" : "text");
    replaceText(await file.text(), file.name);
  }

  async function prepare() {
    if (path === "youtube" && !validYoutubeUrl(youtubeUrl)) {
      setStatus("Enter a valid HTTPS YouTube URL before preparing this source.");
      return;
    }
    if (reviewed.stats.wordCount < 4) {
      setStatus(path === "youtube"
        ? "Paste a transcript or notes alongside the URL; automatic extraction is unavailable."
        : "Add at least a few words of course material before preparing a draft.");
      return;
    }
    if (!allDiagramFlagsReviewed(reviewed)) {
      setStatus("Review each diagram-worthy flag before preparing the course draft.");
      return;
    }
    setBusy(true);
    setStatus("Preparing a private, tenant-scoped course draft…");
    try {
      const response = await fetch("/api/learning/knowledge/prepare", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: reviewed.title,
          description: reviewed.description,
          moduleTitle,
          lessonTitle,
          lessonContent: reviewed.normalizedText,
          sourceName: reviewed.sourceName,
          sourceFormat: reviewed.format,
          sourceUrl: path === "youtube" ? youtubeUrl : undefined,
          intakePath: path,
          diagramReview: reviewed.diagramFlags,
        }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isRecord(payload) || typeof payload.courseId !== "string") {
        throw new Error(isRecord(payload) && payload.code === "tenant_selection_required"
          ? "Select a client workspace before preparing knowledge."
          : "The private course draft could not be prepared.");
      }
      setCourseId(payload.courseId);
      setStatus("Private course draft prepared. Embeddings were not requested in this lane.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The course draft could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} id="learning-intake" aria-labelledby="learning-intake-heading">
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>06 · Client learning</p><h2 id="learning-intake-heading">Bring knowledge into a reviewable draft.</h2><p>Agent-assisted creation, pasted material, YouTube pointers, and text-like files all enter the same tenant-scoped cleaning and publish-readiness review for {tenantName}.</p></div>
        <div className={styles.truth}><strong>Truthful provider state</strong><span>Cleaning runs locally. Provider extraction, embeddings, and retrieval are not claimed here.</span></div>
      </header>
      <nav className={styles.tabs} aria-label="Knowledge intake paths">{(["agent", "paste", "youtube", "file"] as const).map((item) => <button type="button" key={item} data-active={path === item} onClick={() => selectPath(item)}>{item === "agent" ? "Agent-assisted" : item === "paste" ? "Paste content" : item === "youtube" ? "YouTube URL" : "Text / Markdown / CSV / doc-like"}</button>)}</nav>
      <div className={styles.intakeGrid}>
        <div className={styles.form}>
          {path === "agent" ? <><label>What should learners be able to do?<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Explain our onboarding process" /></label><button className={styles.secondary} type="button" onClick={createStarter}>Create local starter outline</button><p className={styles.helper}>This is a deterministic outline starter, not a provider response.</p></> : null}
          {path === "youtube" ? <><label>YouTube URL<input value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></label><p className={styles.helper}>{validYoutubeUrl(youtubeUrl) ? "URL recognized. Paste a transcript or notes below; automatic extraction is unavailable." : "Only an HTTPS YouTube URL is accepted."}</p></> : null}
          {path === "file" ? <label className={styles.drop}>Choose text, Markdown, CSV, or readable document-like content<input type="file" accept=".txt,.md,.markdown,.csv,.doc,.docx,.pdf,text/plain,text/markdown,text/csv" onChange={(event) => void readFile(event.target.files?.[0])} /><small>DOCX/PDF extraction needs a configured extractor; paste readable text if needed.</small></label> : null}
          {path !== "agent" || text ? <label>Readable course material<textarea value={text} onChange={(event) => replaceText(event.target.value)} placeholder="Paste a transcript, lesson, notes, or extracted document text…" /></label> : null}
          <div className={styles.fields}><label>Format<select value={format} onChange={(event) => setFormat(event.target.value as KnowledgeSourceFormat)}><option value="text">Plain text</option><option value="markdown">Markdown</option><option value="csv">CSV</option></select></label><label>Source label<input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label></div>
        </div>
        <div className={styles.preview}><div className={styles.previewHead}><span>Cleaned preview</span><small>{reviewed.stats.wordCount} words · {reviewed.sections.length} sections · {reviewed.issues.length} flags</small></div><pre>{reviewed.normalizedText || "Your normalized course material will appear here."}</pre><div className={styles.readiness}><span>✓ Cleaned</span><span data-ready={allDiagramFlagsReviewed(reviewed)}>{allDiagramFlagsReviewed(reviewed) ? "✓" : "·"} Diagram review</span><span data-ready="false">! Embeddings not requested</span></div></div>
      </div>
      <div className={styles.reviewGrid}><div><h3>Quality flags</h3>{reviewed.issues.length ? reviewed.issues.map((issue) => <div className={styles.flag} key={issue.issueId}><b>{issue.severity === "error" ? "!" : "·"}</b><span><strong>{issue.message}</strong><small>{issue.kind.replaceAll("_", " ")}{issue.evidence ? ` · ${issue.evidence}` : ""}</small></span></div>) : <p className={styles.helper}>No missing, duplicate, or noisy sections found.</p>}</div><div><h3>Diagram review</h3>{reviewed.diagramFlags.length ? reviewed.diagramFlags.map((flag) => <div className={styles.diagram} key={flag.flagId}><span><strong>{flag.title}</strong><small>{flag.evidence}</small></span><div><button type="button" data-active={flag.state === "accepted"} onClick={() => setReviews((current) => ({ ...current, [flag.flagId]: "accepted" }))}>Keep</button><button type="button" data-active={flag.state === "dismissed"} onClick={() => setReviews((current) => ({ ...current, [flag.flagId]: "dismissed" }))}>Dismiss</button></div></div>) : <p className={styles.helper}>No diagram-worthy structures detected.</p>}</div></div>
      <div className={styles.publish}><div><p className={styles.eyebrow}>Publish readiness</p><h3>Prepare a private course draft</h3><p>Saving uses the existing authenticated learning RPC. Publishing stays explicit and separate.</p></div><div className={styles.publishFields}><label>Course title<input value={title || draft.title} onChange={(event) => setTitle(event.target.value)} /></label><label>Description<input value={description || draft.description} onChange={(event) => setDescription(event.target.value)} /></label><label>Module<input value={moduleTitle} onChange={(event) => setModuleTitle(event.target.value)} /></label><label>Lesson<input value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} /></label></div><footer><p role="status">{status}</p><button className={styles.primary} type="button" disabled={busy || !text.trim() || !allDiagramFlagsReviewed(reviewed)} onClick={() => void prepare()}>{busy ? "Preparing…" : "Prepare private draft"}</button></footer>{courseId ? <div className={styles.success}><strong>Draft ready.</strong><span>Review and publish it from the learning workspace.</span><a href="/app#courses">Open course workspace →</a></div> : null}</div>
    </section>
  );
}
