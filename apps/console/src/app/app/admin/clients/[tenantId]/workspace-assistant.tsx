"use client";

import { useState } from "react";
import styles from "../clients.module.css";

const suggestions = [
  "Which students may need a clearer next step?",
  "What learning has this workspace published?",
  "Summarize the questions students are asking.",
];

export default function WorkspaceAssistant({ tenantId, clientName }: { tenantId: string; clientName: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(nextQuestion = question) {
    const value = nextQuestion.trim();
    if (!value || busy) return;
    setQuestion(value);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/clients/${tenantId}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ question: value }),
      });
      const payload = (await response.json()) as { answer?: unknown; message?: unknown };
      if (!response.ok || typeof payload.answer !== "string") {
        throw new Error(typeof payload.message === "string" ? payload.message : "The workspace assistant could not answer.");
      }
      setAnswer(payload.answer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workspace assistant could not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.assistantPanel} aria-labelledby="workspace-assistant-heading">
      <div className={styles.assistantCopy}>
        <p className={styles.eyebrow}>Workspace assistant</p>
        <h2 id="workspace-assistant-heading">Ask about {clientName}</h2>
        <p>Ask about this client&apos;s learners, published courses, questions, and knowledge signals. Answers stay scoped to this workspace.</p>
        <div className={styles.assistantSuggestions}>
          {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => void ask(suggestion)} disabled={busy}>{suggestion}</button>)}
        </div>
      </div>
      <div className={styles.assistantComposer}>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a workspace question…" rows={3} aria-label="Workspace question" />
        <button type="button" className={styles.assistantAction} onClick={() => void ask()} disabled={!question.trim() || busy}>{busy ? "Thinking…" : "Ask assistant"}</button>
        {error ? <p className={styles.assistantError} role="alert">{error}</p> : null}
        {answer ? <div className={styles.assistantAnswer} aria-live="polite"><span>Answer</span><p>{answer}</p></div> : null}
      </div>
    </section>
  );
}
