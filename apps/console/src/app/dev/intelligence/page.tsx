"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  IntelligenceApiResponse,
  IntelligenceDemoSnapshot,
  IntelligenceMutation,
} from "../../../lib/intelligence-demo/types";

import WorkspaceShell from "../../../components/workspace-shell";
import styles from "./page.module.css";

type MetricKey = keyof IntelligenceDemoSnapshot["metrics"];

const metricMeta: Readonly<
  Record<
    MetricKey,
    { readonly eyebrow: string; readonly title: string; readonly context: string }
  >
> = {
  confusion: {
    eyebrow: "Lesson signal",
    title: "Confusion",
    context: "Attributed questions per active learner",
  },
  contentGap: {
    eyebrow: "Knowledge coverage",
    title: "Content gap",
    context: "30-day retrieval confidence",
  },
  stall: {
    eyebrow: "Learner signal",
    title: "Stall",
    context: "Activity and verified progress",
  },
  velocity: {
    eyebrow: "Cohort comparison",
    title: "Module velocity",
    context: "Lessons per week vs same-tenant median",
  },
};

function formatDateTime(value: string | undefined): string {
  if (value === undefined) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatReason(value: string): string {
  return value
    .replaceAll(":", " · ")
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function metricValue(
  _key: MetricKey,
  metric: IntelligenceDemoSnapshot["metrics"][MetricKey],
): string {
  if (metric.state === "unknown") return "Not known";
  const value = metric.value;
  if ("questionsPerActiveStudent" in value) {
    return `${value.questionsPerActiveStudent.toFixed(2)} q / learner`;
  }
  if ("clusterId" in value) {
    return value.isContentGap === undefined
      ? "Pending"
      : value.isContentGap
        ? "Potential gap"
        : "Covered";
  }
  if ("stalled" in value) {
    return value.stalled ? "Stall observed" : "No stall observed";
  }
  return `${value.lessonsPerWeek.toFixed(1)} lessons / week`;
}

function metricDetail(
  _key: MetricKey,
  metric: IntelligenceDemoSnapshot["metrics"][MetricKey],
): string {
  if (metric.state === "unknown") {
    return metric.limitations.map(formatReason).join(" · ");
  }
  const value = metric.value;
  if ("questionsAttributed" in value) {
    return `${value.questionsAttributed} questions across ${value.activeStudents} active learners`;
  }
  if ("questionCount" in value) {
    return value.averageRetrievalConfidence === undefined
      ? `${value.questionCount} questions · confidence incomplete`
      : `${value.questionCount} questions · ${(value.averageRetrievalConfidence * 100).toFixed(0)}% observed confidence`;
  }
  if ("activeDaysInFourteenDayWindow" in value) {
    return `${value.activeDaysInFourteenDayWindow} active days · ${value.inactiveDays} inactive days`;
  }
  return `${value.comparison} than ${value.sameTenantCohortMedian.toFixed(1)} lesson cohort median`;
}

function availableTransitions(
  status: IntelligenceDemoSnapshot["opportunity"]["status"],
): Array<{
  readonly status: IntelligenceDemoSnapshot["opportunity"]["status"];
  readonly label: string;
}> {
  if (status === "new") {
    return [
      { status: "seen", label: "Mark reviewed" },
      { status: "actioned", label: "Record action taken" },
      { status: "dismissed", label: "Dismiss" },
    ];
  }
  if (status === "seen") {
    return [
      { status: "actioned", label: "Record action taken" },
      { status: "dismissed", label: "Dismiss" },
    ];
  }
  if (status === "actioned") {
    return [
      { status: "converted", label: "Mark outcome" },
      { status: "dismissed", label: "Dismiss" },
    ];
  }
  return [];
}

export default function IntelligencePage() {
  const [data, setData] = useState<IntelligenceApiResponse>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const response = await fetch("/api/dev/intelligence", {
        cache: "no-store",
      });
      const body = (await response.json()) as
        | IntelligenceApiResponse
        | { readonly message?: string };
      if (!response.ok || !("snapshot" in body)) {
        throw new Error(
          "message" in body && body.message
            ? body.message
            : "Intelligence could not be loaded.",
        );
      }
      setData(body);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Intelligence could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (input: IntelligenceMutation, successMessage: string) => {
      setBusy(
        input.action === "status"
          ? `status:${input.nextStatus}`
          : `feedback:${input.kind}`,
      );
      setError(undefined);
      try {
        const response = await fetch("/api/dev/intelligence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = (await response.json()) as
          | IntelligenceApiResponse
          | { readonly message?: string };
        if (!response.ok || !("snapshot" in body)) {
          throw new Error(
            "message" in body && body.message
              ? body.message
              : "The review action could not be saved.",
          );
        }
        setData(body);
        setNotice(successMessage);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "The review action could not be saved.",
        );
      } finally {
        setBusy(undefined);
      }
    },
    [],
  );

  const transitions = useMemo(
    () =>
      data === undefined
        ? []
        : availableTransitions(data.snapshot.opportunity.status),
    [data],
  );

  if (data === undefined && error === undefined) {
    return (
      <main className={styles.statePage} aria-busy="true">
        <div className={styles.loader} />
        <p>Assembling tenant-scoped intelligence…</p>
      </main>
    );
  }

  if (data === undefined) {
    return (
      <main className={styles.statePage}>
        <div className={styles.errorMark}>!</div>
        <h1>Intelligence is unavailable</h1>
        <p>{error}</p>
        <button onClick={() => void load()}>Try again</button>
      </main>
    );
  }

  const { snapshot } = data;
  const completeSources = snapshot.health.sources.filter(
    (source) => source.state === "complete",
  ).length;
  const identityCoverage = snapshot.health.identityCoverage.ratio;

  return (
    <WorkspaceShell active="people">
      <main className={`${styles.shell} unified-page`}>
      <section className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className={styles.overline}>
              {snapshot.course.title} / {snapshot.course.module}
            </p>
            <h1>Learning intelligence</h1>
            <p>
              Evidence-backed patterns, with uncertainty left visible.
            </p>
          </div>
          <div className={styles.headerMeta}>
            <span className={styles.tenantDot} />
            <div>
              <strong>{snapshot.tenantName}</strong>
              <small>Data through {formatDateTime(snapshot.health.dataThrough)}</small>
            </div>
          </div>
        </header>

        {(notice !== undefined || error !== undefined) && (
          <div
            className={error === undefined ? styles.notice : styles.errorNotice}
            role={error === undefined ? "status" : "alert"}
          >
            <span>{error === undefined ? "✓" : "!"}</span>
            <p>{error ?? notice}</p>
            <button
              aria-label="Dismiss notification"
              onClick={() => {
                setNotice(undefined);
                setError(undefined);
              }}
            >
              ×
            </button>
          </div>
        )}

        <section className={styles.healthStrip} aria-label="Source health">
          <div className={styles.healthLead}>
            <span
              className={`${styles.stateBadge} ${styles[snapshot.health.state]}`}
            >
              {snapshot.health.state}
            </span>
            <div>
              <h2>Source coverage</h2>
              <p>
                {completeSources} of {snapshot.health.sources.length} sources
                complete ·{" "}
                {identityCoverage === undefined
                  ? "identity coverage unknown"
                  : `${Math.round(identityCoverage * 100)}% identity coverage`}
              </p>
            </div>
          </div>
          <div className={styles.sources}>
            {snapshot.health.sources.map((source) => (
              <div className={styles.source} key={source.source}>
                <span className={styles[source.state]} />
                <div>
                  <strong>{source.source}</strong>
                  <small>{source.state}</small>
                </div>
                <time>{formatDateTime(source.dataThrough)}</time>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.metrics} aria-label="Learning metrics">
          {(
            Object.entries(snapshot.metrics) as Array<
              [
                MetricKey,
                IntelligenceDemoSnapshot["metrics"][MetricKey],
              ]
            >
          ).map(([key, metric]) => (
            <article className={styles.metricCard} key={key}>
              <div className={styles.metricTop}>
                <p>{metricMeta[key].eyebrow}</p>
                <span
                  className={`${styles.metricState} ${styles[metric.state]}`}
                >
                  {metric.state}
                </span>
              </div>
              <h2>{metricMeta[key].title}</h2>
              <strong>{metricValue(key, metric)}</strong>
              <p className={styles.metricDetail}>
                {metricDetail(key, metric)}
              </p>
              <footer>
                <span>{metricMeta[key].context}</span>
                <time>{formatDateTime(metric.dataThrough)}</time>
              </footer>
            </article>
          ))}
        </section>

        <div className={styles.mainGrid}>
          <section className={styles.opportunity}>
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.overline}>Human review queue</p>
                <h2>Support may help {snapshot.learner.displayName}</h2>
              </div>
              <div className={styles.opportunityBadges}>
                <span>{snapshot.opportunity.identityTier}</span>
                <span>{snapshot.opportunity.status}</span>
              </div>
            </div>

            <div className={styles.opportunitySummary}>
              <div>
                <small>Confidence</small>
                <strong>
                  {Math.round(snapshot.opportunity.confidence * 100)}%
                </strong>
              </div>
              <p>
                This record has no computed score or matched offer. It asks a
                Creator to review learning evidence and choose whether anything
                should be recorded.
              </p>
            </div>

            <div className={styles.evidence}>
              <h3>Supporting evidence</h3>
              {snapshot.opportunity.evidence.map((item) => (
                <article key={`${item.kind}:${item.refId}`}>
                  <span>{item.kind}</span>
                  <div>
                    <p>{item.fact}</p>
                    {item.excerpt !== undefined && (
                      <blockquote>“{item.excerpt}”</blockquote>
                    )}
                    <small>
                      Captured {formatDateTime(item.capturedAt)} · {item.refId}
                    </small>
                  </div>
                </article>
              ))}
            </div>

            <div className={styles.reviewActions}>
              <div>
                <small>Lifecycle</small>
                <p>
                  Records review state only. It cannot message a learner or
                  change access.
                </p>
              </div>
              <div className={styles.buttonRow}>
                {transitions.length === 0 ? (
                  <span className={styles.terminal}>
                    Lifecycle is {snapshot.opportunity.status}
                  </span>
                ) : (
                  transitions.map((transition) => (
                    <button
                      className={
                        transition.status === "dismissed"
                          ? styles.secondaryButton
                          : styles.primaryButton
                      }
                      disabled={busy !== undefined}
                      key={transition.status}
                      onClick={() =>
                        void mutate(
                          {
                            action: "status",
                            idempotencyKey: crypto.randomUUID(),
                            opportunityId: snapshot.opportunity.id,
                            expectedStatus: snapshot.opportunity.status,
                            nextStatus: transition.status,
                            reason:
                              "Human review recorded in the Creator intelligence surface.",
                          },
                          `${transition.label} was audited. No outreach was sent.`,
                        )
                      }
                    >
                      {busy === `status:${transition.status}`
                        ? "Saving…"
                        : transition.label}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className={styles.feedback}>
              <span>Was this useful?</span>
              {(
                [
                  ["helpful", "Helpful"],
                  ["dismissed_false_positive", "False positive"],
                  ["wrong_offer", "Wrong context"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  disabled={busy !== undefined}
                  key={kind}
                  onClick={() =>
                    void mutate(
                      {
                        action: "feedback",
                        idempotencyKey: crypto.randomUUID(),
                        opportunityId: snapshot.opportunity.id,
                        kind,
                        note: "Human feedback from the Creator intelligence surface.",
                      },
                      `${label} feedback was stored separately from observed behavior.`,
                    )
                  }
                >
                  {busy === `feedback:${kind}` ? "Saving…" : label}
                </button>
              ))}
              <small>{snapshot.feedback.length} feedback records</small>
            </div>
          </section>

          <aside className={styles.sideColumn}>
            <section className={styles.policyCard}>
              <div className={styles.lockIcon}>◇</div>
              <p className={styles.overline}>Policy boundary</p>
              <h2>O-09 remains unresolved</h2>
              <p>{snapshot.policyBoundary.note}</p>
              <dl>
                <div>
                  <dt>Score computed</dt>
                  <dd>No</dd>
                </div>
                <div>
                  <dt>Offer matched</dt>
                  <dd>No</dd>
                </div>
                <div>
                  <dt>Autonomous outreach</dt>
                  <dd>Never</dd>
                </div>
              </dl>
              <small>{snapshot.policyBoundary.opportunityPolicyVersion}</small>
            </section>

            <section className={styles.suppressionCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <p className={styles.overline}>Eligibility gates</p>
                  <h2>Suppressed safely</h2>
                </div>
                <span>{snapshot.suppressed.length}</span>
              </div>
              <div className={styles.suppressionList}>
                {snapshot.suppressed.map((item) => (
                  <div key={item.candidateId}>
                    <span>—</span>
                    <p>
                      <strong>{item.label}</strong>
                      <small>{item.reasons.map(formatReason).join(" · ")}</small>
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>

        <section className={styles.auditSection}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.overline}>Human activity</p>
              <h2>Audit trail</h2>
            </div>
            <span>{snapshot.audit.length} records</span>
          </div>
          {snapshot.audit.length === 0 ? (
            <div className={styles.emptyAudit}>
              <span>◎</span>
              <div>
                <strong>No review actions yet</strong>
                <p>Status and feedback actions will appear here with the human actor.</p>
              </div>
            </div>
          ) : (
            <div className={styles.auditList}>
              {snapshot.audit
                .slice()
                .reverse()
                .map((entry) => (
                  <div key={entry.id}>
                    <span />
                    <p>
                      <strong>
                        {entry.action === "status_changed"
                          ? `${entry.fromStatus} → ${entry.toStatus}`
                          : "Feedback recorded"}
                      </strong>
                      <small>
                        {entry.actor.role} · {entry.actor.actorId} ·{" "}
                        {formatDateTime(entry.occurredAt)}
                      </small>
                    </p>
                  </div>
                ))}
            </div>
          )}
        </section>

        <footer className={styles.pageFooter}>
          <p>
            Development reference · In-memory intelligence only · Production
            persistence, RLS, and O-09 approval remain required.
          </p>
          <a href="/dev/learning">Review Minimum Day lesson →</a>
        </footer>
      </section>
      </main>
    </WorkspaceShell>
  );
}
