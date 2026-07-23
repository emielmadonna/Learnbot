"use client";

import { useMemo, useState } from "react";

import styles from "./page.module.css";

type Branding = {
  assistantName: string;
  initials: string;
  primary: string;
  accent: string;
  surface: string;
  launcherStyle: "Pill" | "Circle" | "Minimal";
  position: "Bottom right" | "Bottom left";
  welcome: string;
  voice: "Harbor" | "Meadow" | "Sol";
  attribution: boolean;
  privacyLink: boolean;
};

const initialBranding: Branding = {
  assistantName: "Atlas Guide",
  initials: "AG",
  primary: "#1f5c46",
  accent: "#d8a653",
  surface: "#fffdf8",
  launcherStyle: "Pill",
  position: "Bottom right",
  welcome: "Hi, I’m Atlas Guide. Ask a question about this lesson, upload a file, or talk it through with me.",
  voice: "Harbor",
  attribution: true,
  privacyLink: true
};

function luminance(hex: string) {
  const rgb = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return rgb ? 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]! : 0;
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export default function BrandingStudio() {
  const [draft, setDraft] = useState(initialBranding);
  const [published, setPublished] = useState(initialBranding);
  const [status, setStatus] = useState("Published 12 minutes ago");
  const [previewOpen, setPreviewOpen] = useState(true);
  const [contextUrl, setContextUrl] = useState("/courses/sustainable-motion/module-2/lesson-3?progress=64");
  const ratio = useMemo(
    () => contrast(draft.primary, draft.surface),
    [draft.primary, draft.surface]
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(published);

  function update<Key extends keyof Branding>(key: Key, value: Branding[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus("Draft changes · autosaved");
  }

  function publish() {
    setPublished(draft);
    setStatus("Branding published just now");
  }

  function rollback() {
    setDraft(published);
    setStatus("Draft rolled back to published branding");
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.nav}>
        <div className={styles.brand}><span>L</span>Learning OS</div>
        <p>Tenant workspace</p>
        <strong>Atlas Collective</strong>
        <nav aria-label="Settings">
          <a href="/dev/learning">Courses</a>
          <a href="#assistant">Assistant</a>
          <a className={styles.active} href="/dev/branding">Branding</a>
          <a href="#install">Install</a>
          <a href="#settings">Settings</a>
        </nav>
        <div className={styles.tenant}><span>AC</span><div><b>Atlas Collective</b><small>Creator admin</small></div></div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Widget setup / Branding</p>
            <h1>Make the assistant feel like yours.</h1>
            <p>Configure one accessible identity across text, voice, files and every learning surface.</p>
          </div>
          <div className={styles.actions}>
            <span className={dirty ? styles.draft : styles.live}>{dirty ? "Draft" : "Live"}</span>
            <button className={styles.secondary} disabled={!dirty} onClick={rollback}>Rollback</button>
            <button className={styles.publish} disabled={!dirty} onClick={publish}>Publish branding</button>
          </div>
        </header>

        <div className={styles.status}><span />{status}</div>

        <div className={styles.grid}>
          <section className={styles.controls}>
            <div className={styles.sectionTitle}><span>01</span><div><h2>Identity</h2><p>Name and mark shown to learners.</p></div></div>
            <div className={styles.twoColumns}>
              <label className={styles.logoField}>
                <span>Logo</span>
                <div><b>{draft.initials || "AG"}</b><p>Square SVG or PNG</p><em>Replace</em></div>
                <input type="file" accept=".svg,.png,.jpg,.jpeg" />
              </label>
              <label>
                <span>Assistant name</span>
                <input value={draft.assistantName} onChange={(event) => update("assistantName", event.target.value)} />
              </label>
            </div>

            <div className={styles.rule} />
            <div className={styles.sectionTitle}><span>02</span><div><h2>Color</h2><p>Semantic colors with live accessibility checks.</p></div></div>
            <div className={styles.colorGrid}>
              {(["primary", "accent", "surface"] as const).map((key) => (
                <label key={key}>
                  <span>{key}</span>
                  <div className={styles.colorInput}>
                    <input type="color" value={draft[key]} onChange={(event) => update(key, event.target.value)} />
                    <input value={draft[key]} onChange={(event) => update(key, event.target.value)} />
                  </div>
                </label>
              ))}
            </div>
            <div className={ratio >= 4.5 ? styles.contrastGood : styles.contrastWarning}>
              <b>{ratio.toFixed(1)}:1</b>
              <div><strong>{ratio >= 4.5 ? "Accessible contrast" : "Contrast needs attention"}</strong>
              <p>{ratio >= 4.5 ? "Primary text passes WCAG AA on the selected surface." : "Choose a darker primary or lighter surface to reach 4.5:1."}</p></div>
            </div>

            <div className={styles.rule} />
            <div className={styles.sectionTitle}><span>03</span><div><h2>Conversation</h2><p>Launcher, greeting and voice defaults.</p></div></div>
            <div className={styles.twoColumns}>
              <label><span>Launcher style</span><select value={draft.launcherStyle} onChange={(event) => update("launcherStyle", event.target.value as Branding["launcherStyle"])}><option>Pill</option><option>Circle</option><option>Minimal</option></select></label>
              <label><span>Position</span><select value={draft.position} onChange={(event) => update("position", event.target.value as Branding["position"])}><option>Bottom right</option><option>Bottom left</option></select></label>
            </div>
            <label><span>Welcome message</span><textarea value={draft.welcome} onChange={(event) => update("welcome", event.target.value)} /></label>
            <div className={styles.voiceRow}>
              {(["Harbor", "Meadow", "Sol"] as const).map((voice) => (
                <button className={draft.voice === voice ? styles.voiceActive : styles.voice} key={voice} onClick={() => update("voice", voice)}>
                  <i>▶</i><span><b>{voice}</b><small>{voice === "Harbor" ? "Warm · grounded" : voice === "Meadow" ? "Clear · bright" : "Calm · direct"}</small></span>
                </button>
              ))}
            </div>

            <div className={styles.rule} />
            <div className={styles.sectionTitle}><span>04</span><div><h2>Trust & attribution</h2><p>Required disclosures stay clear and visible.</p></div></div>
            <label className={styles.toggle}><div><b>Platform attribution</b><small>Show “Powered by Learning OS”</small></div><input type="checkbox" checked={draft.attribution} onChange={(event) => update("attribution", event.target.checked)} /></label>
            <label className={styles.toggle}><div><b>Privacy link</b><small>Show your tenant privacy policy in the assistant</small></div><input type="checkbox" checked={draft.privacyLink} onChange={(event) => update("privacyLink", event.target.checked)} /></label>
          </section>

          <aside className={styles.previewColumn}>
            <section className={styles.preview}>
              <div className={styles.previewTop}><div><p className={styles.eyebrow}>Live companion preview</p><h2>Lesson page</h2></div><span>Desktop · 100%</span></div>
              <div className={styles.browser}>
                <div className={styles.browserBar}><i /><i /><i /><span>atlas.co/learn/module-2/lesson-3</span></div>
                <article><small>Module 2 · Lesson 3</small><h3>Build a movement map</h3><div className={styles.fakeLine} /><div className={styles.fakeLine} /><div className={styles.fakeLineShort} /></article>
                <button
                  className={`${styles.launcher} ${draft.launcherStyle === "Circle" ? styles.circle : ""} ${draft.launcherStyle === "Minimal" ? styles.minimal : ""} ${draft.position === "Bottom left" ? styles.left : ""}`}
                  style={{ background: draft.primary, color: draft.surface }}
                  onClick={() => setPreviewOpen((open) => !open)}
                >
                  <b>{draft.initials}</b>{draft.launcherStyle === "Pill" && <span>Ask {draft.assistantName}</span>}
                </button>
                {previewOpen && (
                  <div className={`${styles.companion} ${draft.position === "Bottom left" ? styles.panelLeft : ""}`} style={{ background: draft.surface }}>
                    <header style={{ background: draft.primary, color: draft.surface }}><b>{draft.initials}</b><div><strong>{draft.assistantName}</strong><small>Course companion</small></div><button onClick={() => setPreviewOpen(false)}>×</button></header>
                    <div className={styles.message} style={{ borderColor: draft.accent }}>{draft.welcome}</div>
                    <div className={styles.contextChip}>◎ Lesson 3 context connected</div>
                    <div className={styles.composer}>Ask, attach or talk… <span>＋　◉　↑</span></div>
                    {(draft.privacyLink || draft.attribution) && <footer>{draft.privacyLink && "Privacy"}{draft.privacyLink && draft.attribution && " · "}{draft.attribution && "Powered by Learning OS"}</footer>}
                  </div>
                )}
              </div>
            </section>

            <section className={styles.mapping}>
              <div className={styles.mappingHead}><div><p className={styles.eyebrow}>Learning context mapping</p><h2>URL rule preview</h2></div><span>Matched</span></div>
              <label><span>Test a learning URL</span><input value={contextUrl} onChange={(event) => setContextUrl(event.target.value)} /></label>
              <div className={styles.contextRows}>
                <div><span>Course</span><b>{contextUrl.includes("sustainable-motion") ? "Sustainable Motion Systems" : "No match"}</b></div>
                <div><span>Module</span><b>{contextUrl.includes("module-2") ? "02 · Design the system" : "Unknown"}</b></div>
                <div><span>Lesson</span><b>{contextUrl.includes("lesson-3") ? "03 · Build a movement map" : "Unknown"}</b></div>
                <div><span>Progress</span><b>{contextUrl.includes("progress=") ? `${contextUrl.split("progress=")[1]?.split("&")[0]}% complete` : "Not provided"}</b></div>
              </div>
              <p className={styles.mappingNote}>Derived server-side from the verified host URL and tenant rule. Students cannot override mapped course identity.</p>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}
