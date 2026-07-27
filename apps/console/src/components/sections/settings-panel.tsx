"use client";

import type { PanelProps } from "../app-shell/contract";
import { asWorkspace } from "../app-shell/shell-data";
import { roleLabel } from "./learning-format";
import styles from "./sections.module.css";

/**
 * Settings panel.
 *
 * Read-only for now: the durable editors for brand, persona, voice and course
 * scope live in the onboarding workflow and are being moved behind dedicated
 * RPCs.
 */
// TODO(phase2/phase5): replace the read-only summary below with the durable
// agent-configuration editor once the branding/persona/voice/scope RPCs land.
export function SettingsPanel({ payload }: PanelProps) {
  const workspace = asWorkspace(payload);
  const agent = payload.agent;
  const scopeLabel =
    agent.courseScope === "all"
      ? "Every published course"
      : `${agent.courseScope.length} selected ${agent.courseScope.length === 1 ? "course" : "courses"}`;

  return (
    <div className={styles.stack}>
      <section className={styles.stackTight}>
        <p className={styles.eyebrow}>Workspace</p>
        <h3 className={styles.title}>{payload.tenant.displayName}</h3>
        <p className={styles.meta}>
          {payload.tenant.slug} · {roleLabel(workspace?.identity.role ?? payload.role)}
        </p>
        <p className={styles.lede}>
          Identity, brand, invitations, evidence and human-owned privacy policy
          decisions are managed in workspace setup.
        </p>
        <a className={styles.primaryButton} href="/onboarding">
          Open workspace setup
        </a>
      </section>

      <section className={styles.stackTight}>
        <h4 className={styles.subtitle}>Assistant</h4>
        <div className={styles.metricGrid}>
          <div className={styles.metric}>
            <span>Name</span>
            <strong>{agent.assistantName}</strong>
          </div>
          <div className={styles.metric}>
            <span>Tone</span>
            <strong>{agent.tone}</strong>
          </div>
          <div className={styles.metric}>
            <span>Voice</span>
            <strong>{agent.voice}</strong>
          </div>
          <div className={styles.metric}>
            <span>Course scope</span>
            <strong>{scopeLabel}</strong>
          </div>
        </div>
        <div className={styles.card}>
          <h5 className={styles.cardTitle}>Welcome message</h5>
          <p className={styles.cardCopy}>{agent.welcomeMessage}</p>
        </div>
      </section>

      <section className={styles.stackTight}>
        <h4 className={styles.subtitle}>Account</h4>
        <form action="/auth/sign-out" method="post">
          <button className={styles.secondaryButton} type="submit">
            Sign out
          </button>
        </form>
        <a className={styles.textAction} href="/auth/change-password">
          Change password
        </a>
      </section>

      <p className={styles.boundary}>
        <strong>Nothing is invented here.</strong> Values shown come from the
        durable branding record for this tenant. Fields that do not yet have a
        durable source are shown as workspace defaults rather than fabricated
        settings.
      </p>
    </div>
  );
}

export default SettingsPanel;
