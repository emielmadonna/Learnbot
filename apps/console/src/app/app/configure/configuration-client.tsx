"use client";

import { useState } from "react";

import {
  ICON_OPTIONS,
  PROVIDERS,
  type TenantConfiguration,
  type VoiceId,
} from "../../../lib/tenant-configuration";
import styles from "./configuration-section.module.css";

const VOICES: Array<{ id: VoiceId; label: string; note: string }> = [
  { id: "harbor", label: "Harbor", note: "Steady and reassuring" },
  { id: "meadow", label: "Meadow", note: "Warm and encouraging" },
  { id: "sol", label: "Sol", note: "Bright and direct" },
];

type Draft = Pick<TenantConfiguration, "provider" | "voiceGuide" | "assistant" | "featureGates">;

function draftFrom(configuration: TenantConfiguration): Draft {
  return {
    provider: configuration.provider,
    voiceGuide: configuration.voiceGuide,
    assistant: configuration.assistant,
    featureGates: configuration.featureGates,
  };
}

export function ConfigurationSection({ initial }: { initial: TenantConfiguration | null }) {
  if (!initial) {
    return <section className={styles.unavailable} id="configuration"><div><p className={styles.eyebrow}>Workspace configuration</p><h2>Configuration is unavailable.</h2><p>Only a tenant owner or administrator can load this durable control surface. No browser fallback was used.</p></div><span>Unavailable</span></section>;
  }
  return <ConfigurationForm initial={initial} />;
}

function ConfigurationForm({ initial }: { initial: TenantConfiguration }) {
  const [configuration, setConfiguration] = useState(initial);
  const [draft, setDraft] = useState(() => draftFrom(initial));
  const [status, setStatus] = useState("Loaded from the durable tenant boundary");
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(configuration));

  function update<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus("Unsaved changes");
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setStatus("Saving tenant configuration…");
    try {
      const response = await fetch("/api/app/configure", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedTenantRevision: configuration.revision.tenant,
          expectedBrandingRevision: configuration.revision.branding,
          ...draft,
        }),
      });
      const result = (await response.json()) as TenantConfiguration | { message?: string };
      if (!response.ok || !("version" in result)) throw new Error("message" in result && result.message ? result.message : "Configuration was not saved.");
      setConfiguration(result);
      setDraft(draftFrom(result));
      setStatus("Saved to the durable tenant configuration");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Configuration was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.section} id="configuration" aria-labelledby="configuration-heading">
      <header className={styles.header}><div><p className={styles.eyebrow}>One control surface</p><h2 id="configuration-heading">Shape the assistant for {configuration.tenant.displayName}.</h2><p>Branding, provider routing, voice guidance, and feature gates stay together with the learning workspace.</p></div><div className={styles.actions}><span className={dirty ? styles.draft : styles.saved}>{dirty ? "Draft" : "Saved"}</span><button type="button" onClick={() => { setDraft(draftFrom(configuration)); setStatus("Draft reset"); }} disabled={!dirty || saving}>Reset</button><button className={styles.primary} type="button" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "Saving…" : "Save changes"}</button></div></header>
      <p className={styles.status} role="status"><span />{status}</p>
      <div className={styles.grid}>
        <article className={styles.card}><h3>Provider and model</h3><div className={styles.fields}><label>Provider<select value={draft.provider.provider} onChange={(event) => update("provider", { ...draft.provider, provider: event.target.value as TenantConfiguration["provider"]["provider"] })}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label>Model<input value={draft.provider.model} onChange={(event) => update("provider", { ...draft.provider, model: event.target.value })} /></label></div><div className={styles.boundary}><strong>{configuration.credentials.configured ? "Provider access: available" : "Provider access: not configured"}</strong><span>{configuration.credentials.vaultReferencePresent ? "A tenant Vault reference exists, but its server-side resolver is unavailable." : "No tenant Vault reference is registered yet."}</span><small>Tenant-scoped secret storage is not available until the server-side Vault resolver is connected. Raw credentials are never accepted, returned, or stored in the browser.</small></div></article>
        <article className={styles.card}><h3>Voice guide</h3><label className={styles.toggle}><span><b>Voice conversations</b><small>Tenant voice availability.</small></span><input type="checkbox" checked={draft.voiceGuide.enabled} onChange={(event) => update("voiceGuide", { ...draft.voiceGuide, enabled: event.target.checked })} /></label><div className={styles.options}>{VOICES.map((voice) => <label className={draft.voiceGuide.voice === voice.id ? styles.selected : ""} key={voice.id}><input type="radio" name="voice" checked={draft.voiceGuide.voice === voice.id} onChange={() => update("voiceGuide", { ...draft.voiceGuide, voice: voice.id })} /><b>{voice.label}</b><small>{voice.note}</small></label>)}</div><label>How the assistant sounds<textarea value={draft.voiceGuide.guide} maxLength={2_000} onChange={(event) => update("voiceGuide", { ...draft.voiceGuide, guide: event.target.value })} /></label></article>
        <article className={styles.card}><h3>Assistant</h3><div className={styles.fields}><label>Name<input value={draft.assistant.name} maxLength={80} onChange={(event) => update("assistant", { ...draft.assistant, name: event.target.value })} /></label><label>Welcome<input value={draft.assistant.welcome} maxLength={500} onChange={(event) => update("assistant", { ...draft.assistant, welcome: event.target.value })} /></label></div><p className={styles.label}>Assistant Icon</p><div className={styles.icons}>{ICON_OPTIONS.map((icon) => <label className={draft.assistant.icon === icon.id ? styles.selected : ""} key={icon.id}><input type="radio" name="icon" checked={draft.assistant.icon === icon.id} onChange={() => update("assistant", { ...draft.assistant, icon: icon.id })} /><span aria-hidden="true">{icon.glyph}</span><small>{icon.label}</small></label>)}</div><div className={styles.colors}>{(["primaryColor", "accentColor", "surfaceColor", "textColor"] as const).map((key) => <label key={key}><span>{key.replace("Color", "")}</span><input type="color" value={draft.assistant[key]} onChange={(event) => update("assistant", { ...draft.assistant, [key]: event.target.value })} /></label>)}</div></article>
        <article className={`${styles.card} ${styles.gates}`}><h3>Feature gates</h3>{(["analytics", "voice", "uploads", "contextMapping"] as const).map((key) => <label className={styles.toggle} key={key}><span><b>{key === "contextMapping" ? "Context mapping" : key[0]!.toUpperCase() + key.slice(1)}</b><small>{key === "analytics" ? "Tenant-scoped usage signals and progress summaries." : "Available when the server capability is enabled."}</small></span><input type="checkbox" checked={draft.featureGates[key]} onChange={(event) => update("featureGates", { ...draft.featureGates, [key]: event.target.checked })} /></label>)}<p className={styles.helper}>Turning a gate off changes availability; it does not delete existing records.</p></article>
      </div>
    </section>
  );
}
