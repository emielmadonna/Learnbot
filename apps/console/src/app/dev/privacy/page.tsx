"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  PrivacyDemoOperation,
  PrivacyDemoSnapshot,
  PrivacyPreview,
} from "../../../lib/privacy-demo/types";
import styles from "./page.module.css";

type Job = PrivacyDemoSnapshot["jobs"][number];

function operationPurpose(operation: PrivacyDemoOperation) {
  return operation === "retention"
    ? "retention_enforcement"
    : "tenant_privacy_administration";
}

function shortHash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function statusClass(status: Job["status"]) {
  if (status === "completed") return styles.completed;
  if (status === "partial" || status === "blocked") return styles.attention;
  if (status === "failed") return styles.failed;
  return styles.running;
}

export default function PrivacyOperationsPage() {
  const [snapshot, setSnapshot] = useState<PrivacyDemoSnapshot | null>(null);
  const [operation, setOperation] = useState<PrivacyDemoOperation>("access");
  const [subjectId, setSubjectId] = useState("student_maya_demo");
  const [dataThrough, setDataThrough] = useState("2026-07-23T20:00:00.000Z");
  const [preview, setPreview] = useState<PrivacyPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading tenant-safe privacy fixtures…");
  const [busy, setBusy] = useState(false);

  async function loadSnapshot(message?: string) {
    const response = await fetch("/api/dev/privacy", { cache: "no-store" });
    const body = (await response.json()) as PrivacyDemoSnapshot & {
      message?: string;
    };
    if (!response.ok) throw new Error(body.message ?? "Privacy snapshot unavailable.");
    setSnapshot(body);
    setSelectedJobId((current) => current ?? body.jobs[0]?.jobId ?? null);
    setStatus(message ?? "Membership-derived tenant scope verified");
  }

  useEffect(() => {
    void loadSnapshot().catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : "Privacy snapshot unavailable."),
    );
  }, []);

  useEffect(() => {
    setPreview(null);
    setConfirmation("");
    setAcknowledged(false);
  }, [operation, subjectId, dataThrough]);

  async function mutation(body: Record<string, unknown>) {
    const response = await fetch("/api/dev/privacy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        ...(snapshot ? { tenantId: snapshot.tenant.tenantId } : {}),
      }),
    });
    const payload = (await response.json()) as {
      message?: string;
      preview?: PrivacyPreview;
      job?: Job;
      verification?: { valid: boolean; checkedItems: number; issues: string[] };
    };
    if (!response.ok) throw new Error(payload.message ?? "Privacy operation failed.");
    return payload;
  }

  async function runPreview() {
    setBusy(true);
    setStatus("Creating scoped impact preview…");
    try {
      const payload = await mutation({
        action: "preview",
        operation,
        purpose: operationPurpose(operation),
        ...(operation === "retention" ? { dataThrough } : { subjectId }),
      });
      setPreview(payload.preview ?? null);
      setStatus("Preview ready · no records changed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createJob() {
    setBusy(true);
    setStatus("Creating privacy job…");
    try {
      const dangerous = operation === "delete" || operation === "retention";
      const payload = await mutation({
        action: "create",
        operation,
        purpose: operationPurpose(operation),
        idempotencyKey: `privacy-ui-${operation}-${Date.now()}`,
        ...(operation === "retention" ? { dataThrough } : { subjectId }),
        ...(dangerous && preview
          ? {
              previewToken: preview.previewToken,
              confirmationPhrase: confirmation,
            }
          : {}),
      });
      setSelectedJobId(payload.job?.jobId ?? null);
      setPreview(null);
      setConfirmation("");
      setAcknowledged(false);
      await loadSnapshot("Job queued with exact grant and tenant scope");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Job creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function executeJob(jobId: string) {
    setBusy(true);
    setStatus(`Processing ${jobId}…`);
    try {
      const payload = await mutation({ action: "execute", jobId });
      await loadSnapshot(
        payload.job?.status === "completed"
          ? "Job completed and audit evidence committed"
          : `Job ${payload.job?.status ?? "updated"} · held or retryable items preserved`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Job execution failed.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyManifest(manifestId: string) {
    setBusy(true);
    setStatus("Recomputing manifest and artifact hashes…");
    try {
      const payload = await mutation({ action: "verify_manifest", manifestId });
      await loadSnapshot(
        payload.verification?.valid
          ? `Manifest valid · ${payload.verification.checkedItems} artifacts checked`
          : `Manifest invalid · ${payload.verification?.issues.join(", ")}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  const selectedJob = useMemo(
    () => snapshot?.jobs.find((job) => job.jobId === selectedJobId) ?? null,
    [selectedJobId, snapshot],
  );
  const dangerous = operation === "delete" || operation === "retention";
  const exactConfirmation =
    !dangerous ||
    (preview !== null &&
      acknowledged &&
      confirmation === preview.requiredConfirmationPhrase);
  const counts = useMemo(() => {
    const jobs = snapshot?.jobs ?? [];
    return {
      completed: jobs.filter((job) => job.status === "completed").length,
      held: jobs.filter(
        (job) => job.status === "partial" || job.status === "blocked",
      ).length,
      manifests: snapshot?.manifests.filter(
        (manifest) => manifest.verification?.valid,
      ).length ?? 0,
      tombstones: snapshot?.tombstones.length ?? 0,
    };
  }, [snapshot]);

  if (!snapshot) {
    return (
      <main className={styles.loading}>
        <span />
        <p>{status}</p>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <a href="/" className={styles.brand}>
          <span>P</span>
          <div><b>Platform Ops</b><small>Privacy lifecycle</small></div>
        </a>
        <p>CONTROL PLANE</p>
        <nav>
          <a href="/dev/admin">Tenant overview</a>
          <a href="/dev/privacy" className={styles.active}>Privacy operations</a>
          <a href="/dev/branding">Branding</a>
          <a href="/dev/widget">Widget Lab</a>
        </nav>
        <div className={styles.tenantIdentity}>
          <span>N</span>
          <div>
            <b>{snapshot.tenant.tenantSlug}</b>
            <small>{snapshot.tenant.membershipRole} · verified fixture</small>
          </div>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>PLATFORM OWNER · PRIVACY CONTROL PLANE</p>
            <h1>Privacy operations</h1>
            <p>Observable access, export, deletion, and retention jobs with exact authorization evidence.</p>
          </div>
          <div className={styles.scope}>
            <span />
            <div><b>Tenant locked</b><small>{snapshot.tenant.tenantId}</small></div>
          </div>
        </header>

        <div className={styles.fixtureBanner}>
          <b>{snapshot.fixture.label}</b>
          <span>In-memory · reversible by server restart · never production compliance evidence</span>
        </div>

        <section className={styles.metrics}>
          <article><span>Completed jobs</span><strong>{counts.completed}</strong><small>Audited outcomes</small></article>
          <article><span>Held / partial</span><strong>{counts.held}</strong><small>Never false success</small></article>
          <article><span>Verified exports</span><strong>{counts.manifests}</strong><small>Manifest + item hashes</small></article>
          <article><span>Tombstones</span><strong>{counts.tombstones}</strong><small>No personal payload retained</small></article>
        </section>

        <div className={styles.primaryGrid}>
          <section className={styles.card}>
            <div className={styles.cardHeading}>
              <div><span>PRIVACY REQUEST WORKBENCH</span><h2>Create a scoped job</h2></div>
              <i>PREVIEW FIRST</i>
            </div>
            <div className={styles.operationTabs}>
              {(["access", "export", "delete", "retention"] as const).map((value) => (
                <button
                  key={value}
                  className={operation === value ? styles.selectedOperation : ""}
                  onClick={() => setOperation(value)}
                >
                  {value}
                </button>
              ))}
            </div>

            {operation !== "retention" ? (
              <label className={styles.field}>
                <span>Exact subject target</span>
                <select value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
                  {snapshot.subjects.map((subject) => (
                    <option key={subject.subjectId} value={subject.subjectId}>
                      {subject.displayName} · {subject.identityTier}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className={styles.field}>
                <span>Explicit data-through timestamp</span>
                <input
                  value={dataThrough}
                  onChange={(event) => setDataThrough(event.target.value)}
                />
              </label>
            )}

            <dl className={styles.grantSummary}>
              <div><dt>Purpose</dt><dd>{operationPurpose(operation)}</dd></div>
              <div><dt>Actor</dt><dd>{snapshot.tenant.actorDisplayName ?? snapshot.tenant.actorId}</dd></div>
              <div><dt>Role</dt><dd>owner</dd></div>
              <div><dt>Grant policy</dt><dd>{snapshot.exactGrantPolicyVersion}</dd></div>
            </dl>

            <button className={styles.previewButton} disabled={busy} onClick={runPreview}>
              {busy ? "Working…" : "Preview impact"}
            </button>

            {preview ? (
              <div className={styles.preview}>
                <div className={styles.previewHeading}>
                  <span>NO MUTATION</span>
                  <b>{preview.impactedRecordCount} records in scope</b>
                </div>
                <dl>
                  <div><dt>Exact grant</dt><dd>{preview.exactGrant.operation}</dd></div>
                  <div><dt>Target</dt><dd>{preview.exactGrant.target}</dd></div>
                  {preview.policyVersion ? <div><dt>Policy</dt><dd>{preview.policyId} · {preview.policyVersion}</dd></div> : null}
                  <div><dt>Legal hold</dt><dd>{preview.heldRecordIds.length ? `${preview.heldRecordIds.length} record(s) suppressed` : "No affected records held"}</dd></div>
                  <div><dt>Expires</dt><dd>{new Date(preview.expiresAt).toLocaleTimeString()}</dd></div>
                </dl>
                <p>{preview.warning}</p>
                {dangerous ? (
                  <>
                    <label className={styles.confirmField}>
                      <span>Type the exact confirmation phrase</span>
                      <code>{preview.requiredConfirmationPhrase}</code>
                      <input
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                        placeholder="Exact phrase required"
                      />
                    </label>
                    <label className={styles.acknowledge}>
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      <span>I understand this mutates only in-memory development fixtures.</span>
                    </label>
                  </>
                ) : null}
                <button
                  className={styles.createButton}
                  disabled={busy || !exactConfirmation}
                  onClick={createJob}
                >
                  Create queued {operation} job
                </button>
              </div>
            ) : null}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeading}>
              <div><span>EXPLICIT DEMO POLICY</span><h2>Retention boundary</h2></div>
              <i className={styles.fixtureTag}>FIXTURE</i>
            </div>
            <div className={styles.policyIdentity}>
              <div><span>Policy version</span><b>{snapshot.policies.retention.version}</b></div>
              <div><span>Region</span><b>{snapshot.policies.region}</b></div>
              <div><span>Approved by</span><b>{snapshot.policies.retention.approvedBy}</b></div>
            </div>
            <div className={styles.openDecisions}>
              <div><b>O-07 · Voice recording</b><span>Collection blocked pending decision</span></div>
              <div><b>Raw audio duration</b><span>Not set · no invented default</span></div>
              <div><b>O-13 · Retention</b><span>Durations below are demo fixtures only</span></div>
            </div>
            <div className={styles.rules}>
              <div className={styles.ruleHeader}><span>Data class</span><span>Duration</span><span>Disposition</span></div>
              {snapshot.policies.retention.rules.map((rule) => (
                <div key={rule.dataClass}>
                  <b>{rule.dataClass}</b>
                  <span>{rule.retentionDays} days</span>
                  <em>{rule.disposition}</em>
                </div>
              ))}
            </div>
            <div className={styles.deletionPolicy}>
              <span>Deletion policy</span>
              <b>{snapshot.policies.deletion.policyId} · {snapshot.policies.deletion.version}</b>
              <small>Legal-hold mode: {snapshot.policies.deletion.legalHoldMode}</small>
            </div>
          </section>
        </div>

        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <div><span>ASYNCHRONOUS + IDEMPOTENT</span><h2>Privacy jobs</h2></div>
            <p>{status}</p>
          </div>
          <div className={styles.jobTable}>
            <div className={styles.jobHeader}>
              <span>Job / kind</span><span>Target</span><span>Progress</span><span>Evidence</span><span>Status</span><span />
            </div>
            {snapshot.jobs.map((job) => (
              <button
                key={job.jobId}
                className={selectedJobId === job.jobId ? styles.selectedJob : ""}
                onClick={() => setSelectedJobId(job.jobId)}
              >
                <span><b>{job.kind}</b><small>{job.jobId}</small></span>
                <span><b>{job.subjectId ?? snapshot.tenant.tenantSlug}</b><small>{job.requestedBy.purpose}</small></span>
                <span><b>{job.completedRecordIds.length}/{job.targetRecordIds.length}</b><small>{job.stage}</small></span>
                <span><b>{job.heldRecordIds.length ? `${job.heldRecordIds.length} held` : "clear"}</b><small>{job.failures.length} failures</small></span>
                <span><i className={statusClass(job.status)}>{job.status}</i><small>v{job.version}</small></span>
                <span>›</span>
              </button>
            ))}
          </div>

          {selectedJob ? (
            <div className={styles.jobDetail}>
              <div>
                <span>Authorization evidence</span>
                <b>{selectedJob.requestedBy.role} · {selectedJob.requestedBy.purpose}</b>
                <small>{selectedJob.policyRef ? `${selectedJob.policyRef.policyId} · ${selectedJob.policyRef.version}` : "No mutation policy required"}</small>
              </div>
              <div>
                <span>Blocked / partial state</span>
                <b>{selectedJob.blockedReasons.length ? selectedJob.blockedReasons.join(", ") : "No block reason"}</b>
                <small>{selectedJob.heldRecordIds.length ? `Held: ${selectedJob.heldRecordIds.join(", ")}` : "No held records"}</small>
              </div>
              <div>
                <span>Result evidence</span>
                <b>
                  {selectedJob.result?.kind === "delete"
                    ? `${selectedJob.result.deleted} deleted · tombstoned`
                    : selectedJob.result?.kind === "export"
                      ? `${selectedJob.result.itemCount} artifacts · ${selectedJob.result.totalBytes} bytes`
                      : selectedJob.result?.kind === "access"
                        ? `${selectedJob.result.recordCount} records enumerated`
                        : selectedJob.result?.kind === "retention"
                          ? `${selectedJob.result.deleted} deleted · ${selectedJob.result.deidentified} deidentified`
                          : "Result pending"}
                </b>
                <small>{selectedJob.result ? `Data through ${selectedJob.dataThrough}` : "Draft and target plan preserved"}</small>
              </div>
              {(selectedJob.status === "queued" ||
                selectedJob.status === "running" ||
                (selectedJob.status === "partial" && selectedJob.retryable)) ? (
                <button disabled={busy} onClick={() => executeJob(selectedJob.jobId)}>
                  Resume bounded batch
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <div className={styles.evidenceGrid}>
          <section className={styles.card}>
            <div className={styles.cardHeading}>
              <div><span>EXPORT INTEGRITY</span><h2>Manifest verification</h2></div>
            </div>
            {snapshot.manifests.map((manifest) => (
              <article className={styles.manifest} key={manifest.manifestId}>
                <div><b>{manifest.manifestId}</b><span>{manifest.itemCount} canonical artifacts · {manifest.totalBytes} bytes</span></div>
                <code>{shortHash(manifest.rootSha256)}</code>
                <i className={manifest.verification?.valid ? styles.valid : styles.attention}>
                  {manifest.verification?.valid ? `VALID · ${manifest.verification.checkedItems} checked` : "UNVERIFIED"}
                </i>
                <button disabled={busy} onClick={() => verifyManifest(manifest.manifestId)}>Verify again</button>
              </article>
            ))}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeading}>
              <div><span>MINIMIZED IDENTITY EVIDENCE</span><h2>Tombstone result</h2></div>
            </div>
            {snapshot.tombstones.map((tombstone) => (
              <article className={styles.tombstone} key={tombstone.subjectId}>
                <div><span>Tombstoned subject</span><b>{tombstone.subjectId}</b></div>
                <div><span>Policy / job</span><b>{tombstone.policyVersion} · {tombstone.jobId}</b></div>
                <div><span>One-way digest</span><code>{shortHash(tombstone.subjectDigest)}</code></div>
                <p>No profile, email, message, transcript, vector, or asset payload retained.</p>
              </article>
            ))}
          </section>
        </div>

        <div className={styles.evidenceGrid}>
          <section className={styles.card}>
            <div className={styles.cardHeading}>
              <div><span>AUTHORITATIVE SUPPRESSION</span><h2>Legal holds</h2></div>
            </div>
            {snapshot.holds.map((hold) => (
              <article className={styles.hold} key={hold.holdId}>
                <span>ACTIVE</span>
                <div><b>{hold.holdId}</b><small>{hold.reason}</small></div>
                <dl><dt>Subject</dt><dd>{hold.subjectId ?? "tenant-wide"}</dd><dt>Records</dt><dd>{hold.recordIds?.join(", ") ?? "all matching"}</dd></dl>
              </article>
            ))}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeading}>
              <div><span>MINIMIZED + TENANT SCOPED</span><h2>Audit evidence</h2></div>
              <i>{snapshot.audit.length} entries</i>
            </div>
            <div className={styles.audit}>
              {snapshot.audit.slice(0, 9).map((entry) => (
                <div key={entry.auditId}>
                  <span>{entry.action}</span>
                  <p><b>{entry.operation}</b><small>{entry.targetType}: {entry.targetRef}</small></p>
                  <em>{entry.resultCode}</em>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
