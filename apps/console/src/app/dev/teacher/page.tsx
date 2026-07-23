"use client";

import { useState } from "react";

import styles from "../creator/page.module.css";

const cohort = [
  { name: "Maya Chen", progress: 58, momentum: "Rising", lastSeen: "Development session" },
];

export default function TeacherConsole() {
  const [selectedLearner, setSelectedLearner] = useState(cohort[0]!.name);
  const [notice, setNotice] = useState(
    "Verified cohort context · direct outreach remains a human decision",
  );
  const learner = cohort.find((item) => item.name === selectedLearner) ?? cohort[0]!;

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <a className={styles.brand} href="/"><span>L</span><b>Learning OS</b></a>
        <p className={styles.workspaceLabel}>Teacher workspace</p>
        <strong>Momentum Method · Cohort 7</strong>
        <nav aria-label="Teacher navigation">
          <a className={styles.active} href="/dev/teacher">Cohort pulse</a>
          <a href="#questions">Questions</a>
          <a href="#learners">Learners</a>
          <a href="/dev/learning">Course</a>
          <a href="/dev/chat">Student preview</a>
        </nav>
        <div className={styles.profile}><span>EM</span><div><b>Emiel</b><small>Teacher</small></div></div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Momentum Method / Cohort 7</p>
            <h1>Cohort pulse</h1>
            <p>See where learners are progressing, restarting, or asking for clarity.</p>
          </div>
          <div className={styles.headerActions}>
            <a href="/dev/learning">Open course</a>
          </div>
        </header>

        <div className={styles.notice}><span />{notice}</div>

        <section className={styles.metrics} aria-label="Cohort metrics">
          <article><p>Seeded learners</p><strong>1</strong><span>Verified development identity</span></article>
          <article><p>Course progress</p><strong>58%</strong><span>7 of 12 lessons complete</span></article>
          <article><p>Current lesson</p><strong>2.3</strong><span>Minimum Day</span></article>
          <article><p>Human review</p><strong>0</strong><span>No automated outreach</span></article>
        </section>

        <div className={styles.mainGrid}>
          <section className={styles.signals} id="questions">
            <div className={styles.sectionHeading}>
              <div><p className={styles.eyebrow}>Selected learner</p><h2>{learner.name}</h2></div>
              <span>{learner.progress}% complete</span>
            </div>
            <div className={styles.signalLayout}>
              <div className={styles.signalList}>
                {cohort.map((item) => (
                  <button
                    className={selectedLearner === item.name ? styles.signalSelected : styles.signal}
                    key={item.name}
                    onClick={() => setSelectedLearner(item.name)}
                  >
                    <div><b>{item.name}</b><small>{item.progress}% · last active {item.lastSeen}</small></div>
                    <span>{item.momentum}</span>
                  </button>
                ))}
              </div>
              <article className={styles.signalDetail}>
                <div className={styles.confidence}><span>Evidence quality</span><strong>Verified</strong></div>
                <p className={styles.question}>
                  {learner.momentum === "Needs attention"
                    ? "Three missed learning sessions followed an earlier restart."
                    : "Learning pace and question confidence are within the expected range."}
                </p>
                <div className={styles.answer}>
                  <span>Evidence, not a diagnosis</span>
                  <p>
                    Progress combines verified lesson completion and recent learning activity.
                    It does not infer personal circumstances or authorize automatic contact.
                  </p>
                  <small>Policy v18 · refreshed 6 minutes ago</small>
                </div>
                <div className={styles.detailActions}>
                  <button onClick={() => setNotice(`Private-note UI preview opened for ${learner.name} · persistence is not connected yet`)}>Preview private note</button>
                  <button className={styles.resolve} onClick={() => setNotice(`Follow-up preview updated for ${learner.name} · no outreach or audit write occurred`)}>Preview follow-up</button>
                </div>
              </article>
            </div>
          </section>

          <aside className={styles.nextAction}>
            <p className={styles.eyebrow}>Teaching opportunity</p>
            <span className={styles.spark}>✦</span>
            <h2>Add one concrete restart example.</h2>
            <p>The seeded learner is currently on Minimum Day. A shared example can clarify the lesson without inferring personal circumstances.</p>
            <dl>
              <div><dt>Learners in evidence</dt><dd>1</dd></div>
              <div><dt>Evidence coverage</dt><dd>High</dd></div>
              <div><dt>Personal data exposed</dt><dd>None</dd></div>
            </dl>
            <a href="/dev/learning">Review supporting lesson <span>→</span></a>
          </aside>
        </div>

        <section className={styles.learners} id="learners">
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>Cohort roster</p><h2>Progress and momentum</h2></div>
            <button onClick={() => setNotice("Safe cohort view exported without direct contact fields")}>Export safe view</button>
          </div>
          <div className={styles.table} role="table" aria-label="Cohort learners">
            <div className={styles.tableHeader} role="row"><span>Learner</span><span>Progress</span><span>Momentum</span><span>Last active</span></div>
            {cohort.map((item) => (
              <div className={styles.tableRow} role="row" key={item.name}>
                <span><i>{item.name.split(" ").map((part) => part[0]).join("")}</i><b>{item.name}</b></span>
                <span><em><i style={{ width: `${item.progress}%` }} /></em>{item.progress}%</span>
                <span className={item.momentum === "Needs attention" ? styles.attention : styles.momentum}>{item.momentum}</span>
                <span>{item.lastSeen}</span>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
