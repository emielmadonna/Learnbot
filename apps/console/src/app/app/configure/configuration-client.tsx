"use client";

import { useState } from "react";

import {
  ICON_OPTIONS,
  PROVIDERS,
  type TenantConfiguration,
} from "../../../lib/tenant-configuration";
import styles from "./configure.module.css";

const VOICES = [
  { id: "harbor", label: "Harbor", note: "Steady and grounded" },
  { id: "meadow", label: "Meadow", note: "Bright and encouraging" },
  { id: "sol", label: "Sol", note: "Warm and conversational" },
] as const;

const GATES = [
  { key: "analytics", label: "Analytics", note: "Collect tenant-scoped usage signals and progress summaries." },
  { key: "voice", label: "Voice conversations", note: "Allow learners to start a voice conversation." },
  { key: "uploads", label: "Learner uploads", note: "Allow uploads where the learning workflow supports them." },
  { key: "contextMapping", label: "Context mapping", note: "Resolve the learner’s current course and lesson context." },
] as const;

type Draft = Omit<TenantConfiguration, "credentials" | "persistence" | "permissions" | "revision" | "version">;

function draftFrom(configuration: TenantConfiguration): Draft {
  return {
    tenant: configuration.tenant,
    provider: configuration.provider,
    voiceGuide: configuration.voiceGuide,
    assistant: configuration.assistant,
    featureGates: configuration.featureGates,
  };
}

export function ConfigurationSection({ initial }: { initial: TenantConfiguration | null }) {
  if (!initial) {
    return (
      <section className={styles.closed} id="configuration" aria-labelledby="configuration-unavailable">
        <p className={styles.eyebrow}>Workspace configuration</p>
        <h2 id="configuration-unavailable">Configuration is unavailable.</h2>
        <p>Only a tenant owner or administrator can load this durable control surface. No browser fallback was used.</p>
      </section>
    );
  }
  return <ConfigurationClient initial={initial} />;
}

export function ConfigurationClient({ initial }: { initial: TenantConfiguration }) {
  const [configuration, setConfiguration] = useState(initial);
  const [draft, setDraft] = useState(() => draftFrom(initial));
  const [status, setStatus] = useState("Loaded from the active tenant");
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(configuration));
  const readOnly = !configuration.permissions.canManage;

  function updateDraft<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus("Unsaved changes");
  }

  async function save() {
    if (readOnly || saving || !dirty) return;
    setSaving(true);
    setStatus("Saving tenant configuration…");
    try {
      const response = await fetch("/api/app/configure", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: draft.provider.provider,
          model: draft.provider.model,
          voiceGuide: draft.voiceGuide,
          assistant: draft.assistant,
          featureGates: draft.featureGates,
          expectedTenantRevision: configuration.revision.tenant,
          expectedBrandingRevision: configuration.revision.branding,
        }),
      });
      const result = (await response.json()) as TenantConfiguration | { message?: string };
      if (!response.ok || !("version" in result)) {
        throw new Error("message" in result && result.message ? result.message : "Configuration was not saved.");
      }
      setConfiguration(result);
      setDraft(draftFrom(result));
      setStatus("Saved to the active tenant");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Configuration was not saved.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setDraft(draftFrom(configuration));
    setStatus("Draft reset to the last saved configuration");
  }

  return (
    <section className={styles.shell}>
      <aside className={styles.sidebar}>
        <a className={styles.brand} href="/app"><span className={styles.brandMark}>L</span><span><b>LearningBot</b><small>Tenant console</small></span></a>
        <p className={styles.sidebarLabel}>Workspace</p>
        <strong className={styles.tenantName}>{configuration.tenant.displayName}</strong>
        <nav className={styles.nav} aria-label="Workspace navigation"><a href="/app">Home</a><a href="/app/conversation">Assistant</a><a className={styles.activeNav} href="/app/configure">Configure</a><a href="/onboarding">Workspace setup</a></nav>
        <div className={styles.sidebarFooter}><span>{configuration.tenant.slug}</span><small>{readOnly ? "Read-only access" : "Tenant administrator"}</small></div>
      </aside>
      <section className={styles.content}>
        <header className={styles.header}><div><p className={styles.eyebrow}>One control surface</p><h1>Configure your learning assistant.</h1><p>Provider routing, voice guidance, identity, presentation, and tenant feature gates live together here.</p></div><div className={styles.headerActions}><span className={dirty ? styles.draftPill : styles.savedPill}>{dirty ? "Draft" : "Saved"}</span><button className={styles.secondaryButton} type="button" onClick={reset} disabled={!dirty || saving}>Reset</button><button className={styles.primaryButton} type="button" onClick={() => void save()} disabled={readOnly || !dirty || saving}>{saving ? "Saving…" : "Save changes"}</button></div></header>
        <p className={styles.status} role="status"><span />{status}</p>
        {readOnly ? <p className={styles.readOnlyNotice}>You can review this tenant configuration, but only a tenant owner or administrator can change it.</p> : null}
        <div className={styles.grid}>
          <section className={styles.card} aria-labelledby="provider-heading"><div className={styles.sectionHeading}><span className={styles.sectionIcon}>01</span><div><p className={styles.eyebrow}>Runtime</p><h2 id="provider-heading">Provider and model</h2></div></div><div className={styles.fieldGrid}><label className={styles.field}>Provider<select value={draft.provider.provider} disabled={readOnly} onChange={(event) => updateDraft("provider", { ...draft.provider, provider: event.target.value as Draft["provider"]["provider"] })}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label className={styles.field}>Model<input value={draft.provider.model} disabled={readOnly} onChange={(event) => updateDraft("provider", { ...draft.provider, model: event.target.value })} spellCheck={false} /></label></div><p className={styles.helper}>Model selection is stored as tenant configuration. Credentials stay behind the server boundary.</p></section>
          <section className={styles.card} aria-labelledby="credential-heading"><div className={styles.sectionHeading}><span className={styles.sectionIcon}>02</span><div><p className={styles.eyebrow}>Server boundary</p><h2 id="credential-heading">API credential status</h2></div></div><div className={styles.credentialRow}><div className={styles.credentialDot} data-configured={configuration.credentials.configured} /><div><strong>{configuration.credentials.configured ? "Server credential available" : "No tenant credential configured"}</strong><p>{configuration.credentials.vaultReferencePresent ? "A Vault reference is present, but server-side secret resolution is not connected." : "Tenant-scoped secret storage is not available in this deployment."}</p></div><span className={styles.warnPill}>Not writable</span></div><p className={styles.securityNote}>This screen never accepts, echoes, or stores a raw API key in the browser. Credential writes remain disabled until a durable server-side secret store is connected.</p></section>
          <section className={styles.card} aria-labelledby="voice-heading"><div className={styles.sectionHeading}><span className={styles.sectionIcon}>03</span><div><p className={styles.eyebrow}>Guide the experience</p><h2 id="voice-heading">Voice guide</h2></div></div><label className={styles.switchRow}><span><strong>Voice conversations</strong><small>Let the assistant speak when the voice feature gate is enabled.</small></span><input type="checkbox" checked={draft.voiceGuide.enabled} disabled={readOnly} onChange={(event) => updateDraft("voiceGuide", { ...draft.voiceGuide, enabled: event.target.checked })} /></label><div className={styles.voiceOptions}>{VOICES.map((voice) => <label className={`${styles.voiceOption} ${draft.voiceGuide.voice === voice.id ? styles.selected : ""}`} key={voice.id}><input type="radio" name="voice" value={voice.id} checked={draft.voiceGuide.voice === voice.id} disabled={readOnly} onChange={() => updateDraft("voiceGuide", { ...draft.voiceGuide, voice: voice.id })} /><span><b>{voice.label}</b><small>{voice.note}</small></span></label>)}</div><label className={styles.field}>Guide<textarea value={draft.voiceGuide.guide} disabled={readOnly} maxLength={2_000} onChange={(event) => updateDraft("voiceGuide", { ...draft.voiceGuide, guide: event.target.value })} /></label></section>
          <section className={styles.card} aria-labelledby="assistant-heading"><div className={styles.sectionHeading}><span className={styles.sectionIcon}>04</span><div><p className={styles.eyebrow}>Identity and welcome</p><h2 id="assistant-heading">Assistant</h2></div></div><div className={styles.fieldGrid}><label className={styles.field}>Assistant name<input value={draft.assistant.name} disabled={readOnly} maxLength={80} onChange={(event) => updateDraft("assistant", { ...draft.assistant, name: event.target.value })} /></label><label className={styles.field}>Welcome message<input value={draft.assistant.welcome} disabled={readOnly} maxLength={500} onChange={(event) => updateDraft("assistant", { ...draft.assistant, welcome: event.target.value })} /></label></div><p className={styles.fieldLabel}>Icon</p><div className={styles.iconOptions}>{ICON_OPTIONS.map((icon) => <label className={`${styles.iconOption} ${draft.assistant.icon === icon.id ? styles.selected : ""}`} key={icon.id}><input type="radio" name="icon" value={icon.id} checked={draft.assistant.icon === icon.id} disabled={readOnly} onChange={() => updateDraft("assistant", { ...draft.assistant, icon: icon.id })} /><span aria-hidden="true">{icon.glyph}</span><small>{icon.label}</small></label>)}</div><div className={styles.colorGrid}>{(["primaryColor", "accentColor", "surfaceColor", "textColor"] as const).map((key) => <label className={styles.colorField} key={key}><span>{key.replace("Color", "")}</span><input type="color" value={draft.assistant[key]} disabled={readOnly} onChange={(event) => updateDraft("assistant", { ...draft.assistant, [key]: event.target.value })} /></label>)}</div></section>
          <section className={`${styles.card} ${styles.gatesCard}`} aria-labelledby="gates-heading"><div className={styles.sectionHeading}><span className={styles.sectionIcon}>05</span><div><p className={styles.eyebrow}>Tenant controls</p><h2 id="gates-heading">Feature gates</h2></div></div><div className={styles.gates}>{GATES.map((gate) => <label className={styles.gate} key={gate.key}><span><strong>{gate.label}</strong><small>{gate.note}</small></span><input type="checkbox" checked={draft.featureGates[gate.key]} disabled={readOnly} onChange={(event) => updateDraft("featureGates", { ...draft.featureGates, [gate.key]: event.target.checked })} /></label>)}</div><p className={styles.helper}>These flags are tenant-scoped settings. Turning a gate off changes availability; it does not delete existing records.</p></section>
        </div>
      </section>
    </section>
  );
}
