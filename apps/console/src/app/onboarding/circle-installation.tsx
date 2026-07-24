"use client";

import { useMemo, useState } from "react";
import {
  buildCircleSnippet,
  publicCircleAppUrl,
  validCircleUrl,
  type CircleInstallationConfig,
} from "../../lib/circle-installation";
import styles from "./circle-installation.module.css";

export function CircleInstallationPanel({
  config,
}: {
  config: CircleInstallationConfig;
}) {
  const [launcherLabel, setLauncherLabel] = useState(
    config.launcherLabel ?? `Ask ${config.assistantName}`,
  );
  const [communityUrl, setCommunityUrl] = useState(config.communityUrl ?? "");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const communityUrlIsValid = !communityUrl.trim() || validCircleUrl(communityUrl.trim());
  const snippet = useMemo(
    () =>
      buildCircleSnippet({
        ...config,
        launcherLabel,
        communityUrl,
      }),
    [communityUrl, config, launcherLabel],
  );

  async function copySnippet() {
    if (!communityUrlIsValid) {
      setCopyState("error");
      return;
    }
    try {
      await navigator.clipboard.writeText(snippet);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <section className={styles.panel} id="circle-install" aria-labelledby="circle-install-title">
      <div className={styles.heading}>
        <h2 id="circle-install-title">Circle installation</h2>
        <p>
          This snippet is scoped to the selected workspace and carries the current assistant identity into Circle. It contains no password or provider secret.
        </p>
      </div>
      <div className={styles.identity} aria-label="Snippet scope">
        <span>{config.tenantSlug}</span>
        <span>{config.assistantName}</span>
        <span>{config.primaryColor}</span>
      </div>
      <div className={styles.fields}>
        <label className={styles.field}>
          Circle community URL (optional)
          <input
            className={styles.input}
            type="url"
            value={communityUrl}
            onChange={(event) => {
              setCommunityUrl(event.target.value);
              setCopyState("idle");
            }}
            placeholder="https://community.example.com"
            aria-invalid={!communityUrlIsValid}
          />
        </label>
        <label className={styles.field}>
          Launcher label
          <input
            className={styles.input}
            value={launcherLabel}
            onChange={(event) => {
              setLauncherLabel(event.target.value.slice(0, 80));
              setCopyState("idle");
            }}
            maxLength={80}
          />
        </label>
      </div>
      {!communityUrlIsValid ? (
        <p className={styles.error} role="alert">Use an HTTPS community URL, or leave this field blank.</p>
      ) : null}
      <textarea className={styles.snippet} value={snippet} readOnly aria-label="Circle installation snippet" />
      <div className={styles.actions}>
        <button className={styles.copy} type="button" onClick={() => void copySnippet()} disabled={!communityUrlIsValid}>
          Copy Circle snippet
        </button>
        <span className={copyState === "error" ? styles.error : styles.status} role="status" aria-live="polite">
          {copyState === "copied"
            ? "Copied. Paste it into Circle Site → Code snippets → JavaScript."
            : copyState === "error"
              ? "Copy failed. Select the snippet above and copy it manually."
              : `Opens ${publicCircleAppUrl()} for the signed-in learner.`}
        </span>
      </div>
    </section>
  );
}
