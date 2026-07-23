"use client";

import { useMemo, useState } from "react";

import styles from "./page.module.css";

type Signal = {
  id: string;
  learner: string;
  lesson: string;
  topic: string;
  confidence: number;
  status: "New" | "Reviewing" | "Resolved";
};

const initialSignals: Signal[] = [
  {
    id: "signal-1",
    learner: "Maya Chen",
    lesson: "2.3 · Minimum Day",
    topic: "How small is too small?",
    confidence: 94,
    status: "New"
  }
];

const learners = [
  { name: "Maya Chen", progress: 58, momentum: "Rising", lastSeen: "Development session" },
];

export default function CreatorConsole() {
  const [range, setRange] = useState<"7 days" | "30 days">("7 days");
  const [signals, setSignals] = useState(initialSignals);
  const [selectedSignal, setSelectedSignal] = useState(initialSignals[0]!.id);
  const [notice, setNotice] = useState("Development seed · one verified learner and one published course");
  const active = signals.find((signal) => signal.id === selectedSignal) ?? signals[0]!;
  const openSignals = signals.filter((signal) => signal.status !== "Resolved").length;
  const completion = useMemo(
    () => Math.round(learners.reduce((sum, learner) => sum + learner.progress, 0) / learners.length),
    []
  );

  function updateSignal(status: Signal["status"]) {
    setSignals((current) =>
      current.map((signal) => signal.id === active.id ? { ...signal, status } : signal)
    );
    setNotice(
      status === "Resolved"
        ? `${active.topic} resolved in this development review state`
        : `${active.topic} moved to local review state`
    );
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <a className={styles.brand} href="/"><span>L</span><b>Learning OS</b></a>
        <p className={styles.workspaceLabel}>Creator workspace</p>
        <strong>Northstar Academy</strong>
        <nav aria-label="Creator navigation">
          <a className={styles.active} href="/dev/creator">This week</a>
          <a href="/dev/learning">Courses</a>
          <a href="#questions">Questions</a>
          <a href="#learners">Learners</a>
          <a href="/dev/branding">Assistant</a>
        </nav>
        <div className={styles.profile}><span>EM</span><div><b>Emiel</b><small>Owner</small></div></div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Thursday, July 23</p>
            <h1>This week</h1>
            <p>What learners need, what changed, and the next best course action.</p>
          </div>
          <div className={styles.headerActions}>
            <select aria-label="Reporting range" value={range} onChange={(event) => setRange(event.target.value as typeof range)}>
              <option>7 days</option>
              <option>30 days</option>
            </select>
            <a href="/dev/learning">Edit learning</a>
          </div>
        </header>

        <div className={styles.notice}><span />{notice}</div>

        <section className={styles.metrics} aria-label={`${range} performance`}>
          <article><p>Seeded learners</p><strong>1</strong><span>Verified development identity</span></article>
          <article><p>Review signals</p><strong>{initialSignals.length}</strong><span>Scenario evidence, not production analytics</span></article>
          <article><p>Course completion</p><strong>{completion}%</strong><span>7 of 12 lessons completed</span></article>
          <article><p>Needs review</p><strong>{openSignals}</strong><span>{openSignals === 0 ? "Inbox clear" : "Creator decisions waiting"}</span></article>
        </section>

        <div className={styles.mainGrid}>
          <section className={styles.signals} id="questions">
            <div className={styles.sectionHeading}>
              <div><p className={styles.eyebrow}>Learning signals</p><h2>Questions worth your attention</h2></div>
              <span>{openSignals} open</span>
            </div>
            <div className={styles.signalLayout}>
              <div className={styles.signalList}>
                {signals.map((signal) => (
                  <button
                    className={selectedSignal === signal.id ? styles.signalSelected : styles.signal}
                    key={signal.id}
                    onClick={() => setSelectedSignal(signal.id)}
                  >
                    <div><b>{signal.topic}</b><small>{signal.learner} · {signal.lesson}</small></div>
                    <span>{signal.status}</span>
                  </button>
                ))}
              </div>
              <article className={styles.signalDetail}>
                <div className={styles.confidence}><span>Grounded confidence</span><strong>{active.confidence}%</strong></div>
                <p className={styles.question}>“I understand the Minimum Day idea, but if I make it too easy, am I really building the habit?”</p>
                <div className={styles.answer}>
                  <span>Nova answered</span>
                  <p>A Minimum Day protects the identity and restart loop. It is a floor for disrupted days, not the permanent target.</p>
                  <small>2 sources · Momentum Method lesson 2.3</small>
                </div>
                <div className={styles.detailActions}>
                  <button onClick={() => updateSignal("Reviewing")}>Review course answer</button>
                  <button className={styles.resolve} onClick={() => updateSignal("Resolved")}>Mark resolved locally</button>
                </div>
              </article>
            </div>
          </section>

          <aside className={styles.nextAction}>
            <p className={styles.eyebrow}>Recommended next action</p>
            <span className={styles.spark}>✦</span>
            <h2>Clarify the “Minimum Day” lesson.</h2>
            <p>The seeded learner asked where the floor ends and normal practice begins. One short example would improve retrieval coverage for this question.</p>
            <dl>
              <div><dt>Learners in evidence</dt><dd>1</dd></div>
              <div><dt>Evidence coverage</dt><dd>High</dd></div>
              <div><dt>Estimated edit</dt><dd>4 min</dd></div>
            </dl>
            <a href="/dev/learning">Open lesson editor <span>→</span></a>
          </aside>
        </div>

        <section className={styles.learners} id="learners">
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>Learner momentum</p><h2>People to understand</h2></div>
            <button onClick={() => setNotice("Learner list exported without direct contact fields")}>Export safe view</button>
          </div>
          <div className={styles.table} role="table" aria-label="Learner momentum">
            <div className={styles.tableHeader} role="row"><span>Learner</span><span>Progress</span><span>Momentum</span><span>Last active</span></div>
            {learners.map((learner) => (
              <div className={styles.tableRow} role="row" key={learner.name}>
                <span><i>{learner.name.split(" ").map((part) => part[0]).join("")}</i><b>{learner.name}</b></span>
                <span><em><i style={{ width: `${learner.progress}%` }} /></em>{learner.progress}%</span>
                <span className={learner.momentum === "Needs attention" ? styles.attention : styles.momentum}>{learner.momentum}</span>
                <span>{learner.lastSeen}</span>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
