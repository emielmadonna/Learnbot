"use client";

import { useState } from "react";

import styles from "./page.module.css";

const lessons = [
  { id: "01", title: "Welcome & orientation", meta: "6 min · Ready" },
  { id: "02", title: "The three motion systems", meta: "12 min · Ready" },
  { id: "03", title: "Build a movement map", meta: "18 min · Editing" },
  { id: "04", title: "Reducing wasted effort", meta: "9 min · Ready" },
  { id: "05", title: "Practice: your first audit", meta: "14 min · Ready" }
];

const initialContent =
  "A movement map helps you see where energy is spent across a system.\n\nStart by naming the trigger, the action that follows, and the result it creates. Then look for repeated effort, unclear ownership, or a handoff that slows the system down.\n\nThe goal is not to remove every step. It is to make each step intentional.";

export default function LearningWorkspace() {
  const [selected, setSelected] = useState("03");
  const [content, setContent] = useState(initialContent);
  const [saved, setSaved] = useState(initialContent);
  const [sourceCount, setSourceCount] = useState(8);
  const [job, setJob] = useState<"ready" | "running" | "published">("ready");
  const [notice, setNotice] = useState("Draft v12 · autosaved just now");

  function addLearning() {
    setSourceCount((count) => count + 1);
    setJob("running");
    setNotice("New source added · extracting content");
  }

  function cleanContent() {
    const cleaned = content
      .replace(/\s+/g, " ")
      .replace(/\. /g, ".\n\n")
      .trim();
    setContent(cleaned);
    setNotice("Cleaned formatting · review before publishing");
  }

  function reingest() {
    setJob("running");
    setSaved(content);
    setNotice("Selective re-ingest started for this lesson");
  }

  function publish() {
    setSaved(content);
    setJob("published");
    setNotice("Version 12 published · students see the update");
  }

  function rollback() {
    setContent(saved);
    setJob("ready");
    setNotice("Rolled back to the last published lesson");
  }

  const stages = [
    ["Received", "8 sources"],
    ["Extracted", "214 sections"],
    ["Structured", "5 modules"],
    ["Indexed", job === "running" ? "Updating…" : "1,842 chunks"],
    ["Ready", job === "published" ? "Published" : "Draft v12"]
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
          <a href="#assistant">Assistant</a>
          <a href="#students">Students</a>
        </nav>
        <div className={styles.tenant}>
          <span>AC</span>
          <div><strong>Atlas Collective</strong><small>Creator workspace</small></div>
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>Courses / Sustainable systems</p>
            <h1>Sustainable Motion Systems</h1>
          </div>
          <div className={styles.headerActions}>
            <button className={styles.secondary} onClick={rollback}>Rollback</button>
            <button className={styles.publish} onClick={publish}>Publish changes</button>
          </div>
        </header>

        <div className={styles.statusbar}>
          <span className={job === "running" ? styles.pulse : styles.dot} />
          <strong>{notice}</strong>
          <span>5 modules</span><span>{sourceCount} sources</span><span>98% coverage</span>
        </div>

        <section className={styles.pipeline} aria-label="Ingestion pipeline">
          <div className={styles.pipelineHeading}>
            <div><p className={styles.eyebrow}>Learning pipeline</p><h2>Course knowledge</h2></div>
            <button className={styles.add} onClick={addLearning}>＋ Add learning</button>
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

        <div className={styles.editorGrid}>
          <aside className={styles.outline}>
            <div className={styles.panelTitle}>
              <div><p className={styles.eyebrow}>Course outline</p><h2>Module 2</h2></div>
              <button aria-label="Add lesson">＋</button>
            </div>
            <p className={styles.moduleLabel}>Design the system</p>
            {lessons.map((lesson) => (
              <button
                className={selected === lesson.id ? styles.lessonSelected : styles.lesson}
                key={lesson.id}
                onClick={() => setSelected(lesson.id)}
              >
                <span>{lesson.id}</span>
                <div><strong>{lesson.title}</strong><small>{lesson.meta}</small></div>
              </button>
            ))}
          </aside>

          <section className={styles.editor}>
            <div className={styles.editorHeading}>
              <div>
                <p className={styles.eyebrow}>Lesson {selected} · Rich text</p>
                <h2>{lessons.find((lesson) => lesson.id === selected)?.title}</h2>
              </div>
              <span className={styles.health}>Grounding healthy</span>
            </div>
            <div className={styles.toolbar} aria-label="Formatting toolbar">
              <button><b>B</b></button><button><i>I</i></button><button>H2</button>
              <button>☷</button><span /><small>184 words · 3 chunks</small>
            </div>
            <textarea
              aria-label="Lesson content"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setNotice("Unsaved draft changes");
              }}
            />
            <div className={styles.suggestion}>
              <span>✦</span>
              <div><strong>One cleanup suggested</strong><p>Normalize spacing and split this lesson into clearer retrieval sections.</p></div>
              <button onClick={cleanContent}>Clean content</button>
            </div>
            <footer className={styles.editorFooter}>
              <p>Only this lesson will be reprocessed. The live version stays available.</p>
              <div><button className={styles.secondary} onClick={() => setNotice("Preview ready · 3 grounded test answers")}>Preview</button>
              <button className={styles.reingest} onClick={reingest}>↻ Re-ingest lesson</button></div>
            </footer>
          </section>

          <aside className={styles.inspector}>
            <p className={styles.eyebrow}>Lesson intelligence</p>
            <h2>Ready to publish</h2>
            <div className={styles.score}><strong>98</strong><span>Retrieval<br />coverage</span></div>
            <dl>
              <div><dt>Source</dt><dd>Module 2 transcript</dd></div>
              <div><dt>Last indexed</dt><dd>4 minutes ago</dd></div>
              <div><dt>Diagrams</dt><dd>2 candidates</dd></div>
              <div><dt>Warnings</dt><dd className={styles.good}>None</dd></div>
            </dl>
            <div className={styles.diagram}>
              <span>Trigger</span><i>→</i><span>Action</span><i>→</i><span>Result</span>
            </div>
            <button className={styles.full}>Review diagram candidates</button>
          </aside>
        </div>
      </section>
    </main>
  );
}
