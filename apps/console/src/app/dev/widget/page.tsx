"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  HostCommand,
  HostEvent,
  SimulatorConfiguration,
} from "./protocol";
import styles from "./page.module.css";
import viewportStyles from "./viewport.module.css";

const TENANTS: Record<string, SimulatorConfiguration> = {
  northstar: {
    tenantKey: "pk_northstar_demo",
    tenantName: "Northstar Coaching",
    identityTier: "verified",
    learnerName: "Maya Chen",
    branding: {
      assistantName: "Nova",
      primaryColor: "#176b5b",
      accentColor: "#dff3ec",
      surfaceColor: "#ffffff",
      textColor: "#17211e",
      welcomeCopy: "What would you like to understand about this lesson?",
      launcherPosition: "bottom-right",
      voiceEnabled: true,
      logoPath: "/widget/northstar-mark.svg",
    },
    context: {
      status: "resolved",
      confidence: 1,
      source: "verified_host",
      course: "Momentum Method",
      module: "Build Your Rhythm",
      lesson: "Minimum Day",
    },
  },
  fieldwork: {
    tenantKey: "pk_fieldwork_demo",
    tenantName: "Fieldwork Institute",
    identityTier: "self_reported",
    learnerName: "Jordan Lee",
    branding: {
      assistantName: "Moss",
      primaryColor: "#31574e",
      accentColor: "#e8eee2",
      surfaceColor: "#fffef9",
      textColor: "#202722",
      welcomeCopy: "Where should we go deeper?",
      launcherPosition: "bottom-left",
      voiceEnabled: false,
      logoPath: "/widget/northstar-mark.svg",
    },
    context: {
      status: "ambiguous",
      confidence: 0.48,
      source: "url_mapping",
    },
  },
  atlas: {
    tenantKey: "pk_atlas_demo",
    tenantName: "Atlas Leadership",
    identityTier: "anonymous",
    learnerName: "",
    branding: {
      assistantName: "Ari",
      primaryColor: "#315a91",
      accentColor: "#e5edf8",
      surfaceColor: "#ffffff",
      textColor: "#172134",
      welcomeCopy: "Ask a question about this page.",
      launcherPosition: "bottom-right",
      voiceEnabled: true,
      logoPath: "/widget/northstar-mark.svg",
    },
    context: {
      status: "unknown",
    },
  },
};

type Activity = Extract<HostEvent, { type: "activity" }>;

function cloneConfiguration(configuration: SimulatorConfiguration): SimulatorConfiguration {
  return {
    ...configuration,
    branding: { ...configuration.branding },
    context: { ...configuration.context },
  };
}

export default function WidgetLabPage() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [configuration, setConfiguration] = useState(() =>
    cloneConfiguration(TENANTS.northstar!),
  );
  const [viewportMode, setViewportMode] = useState<"desktop" | "mobile">("desktop");
  const [snapshot, setSnapshot] = useState<Extract<HostEvent, { type: "snapshot" }> | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [hostReady, setHostReady] = useState(false);

  const send = useCallback((command: HostCommand) => {
    frameRef.current?.contentWindow?.postMessage(command, window.location.origin);
  }, []);

  const sendConfiguration = useCallback(
    (next: SimulatorConfiguration) => {
      send({ source: "widget-lab", type: "configure", configuration: next });
    },
    [send],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== window.location.origin ||
        typeof event.data !== "object" ||
        event.data === null ||
        !("source" in event.data) ||
        event.data.source !== "widget-host" ||
        !("type" in event.data)
      ) {
        return;
      }
      const hostEvent = event.data as HostEvent;
      if (hostEvent.type === "ready") {
        setHostReady(true);
      }
      if (hostEvent.type === "snapshot") setSnapshot(hostEvent);
      if (hostEvent.type === "activity") {
        setActivities((current) => [hostEvent, ...current].slice(0, 7));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (hostReady) sendConfiguration(configuration);
  }, [configuration, hostReady, sendConfiguration]);

  const updateBrand = <Key extends keyof SimulatorConfiguration["branding"]>(
    key: Key,
    value: SimulatorConfiguration["branding"][Key],
  ) => {
    setConfiguration((current) => ({
      ...current,
      branding: { ...current.branding, [key]: value },
    }));
  };

  const itemCount = snapshot?.snapshot.conversation.items.length ?? 0;
  const contextLabel = useMemo(() => {
    const context = snapshot?.snapshot.learningContext;
    if (!context) return "Waiting for host";
    if (context.status !== "resolved") return context.status;
    return context.lesson ?? context.module ?? context.course ?? "resolved";
  }, [snapshot]);

  return (
    <main className={styles.lab}>
      <header className={styles.topbar}>
        <a href="/" className={styles.brand}>
          <span>W</span>
          <div>
            <strong>Widget Lab</strong>
            <small>Real embed runtime</small>
          </div>
        </a>
        <div className={styles.runtimePill}>
          <span data-ready={hostReady} />
          {hostReady ? "Runtime connected" : "Connecting runtime"}
        </div>
        <nav aria-label="Development modules">
          <a href="/dev/chat">Chat</a>
          <a href="/dev/learning">Learning</a>
          <a href="/dev/branding">Branding</a>
        </nav>
      </header>

      <section className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>EMBED EXPERIENCE · DEVELOPMENT HOST</p>
          <h1>Test the companion where it actually lives.</h1>
          <p>
            This is the framework-free workspace bundle mounted inside a real host
            viewport. Change tenant data, resize the host, switch modalities, and
            observe one conversation survive every presentation change.
          </p>
        </div>
        <dl className={styles.gates}>
          <div><dt>Distribution</dt><dd>ESM + IIFE</dd></div>
          <div><dt>IIFE gzip</dt><dd>11.6 KB</dd></div>
          <div><dt>Isolation</dt><dd>Shadow DOM</dd></div>
        </dl>
      </section>

      <section className={`${styles.workspace} ${viewportStyles.workspace}`}>
        <aside className={styles.controls}>
          <div className={styles.panelHeading}>
            <div>
              <span>Runtime configuration</span>
              <h2>Tenant controls</h2>
            </div>
            <i>LIVE</i>
          </div>

          <label>
            <span>Tenant</span>
            <select
              value={Object.entries(TENANTS).find(([, value]) => value.tenantKey === configuration.tenantKey)?.[0] ?? "northstar"}
              onChange={(event) => {
                const preset = TENANTS[event.target.value];
                if (preset) setConfiguration(cloneConfiguration(preset));
              }}
            >
              <option value="northstar">Northstar Coaching</option>
              <option value="fieldwork">Fieldwork Institute</option>
              <option value="atlas">Atlas Leadership</option>
            </select>
          </label>

          <div className={styles.row}>
            <label>
              <span>Identity</span>
              <select
                value={configuration.identityTier}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    identityTier: event.target.value as SimulatorConfiguration["identityTier"],
                  }))
                }
              >
                <option value="verified">Verified</option>
                <option value="self_reported">Self-reported</option>
                <option value="anonymous">Anonymous</option>
              </select>
            </label>
            <label>
              <span>Context</span>
              <select
                value={configuration.context.status}
                onChange={(event) => {
                  const status = event.target.value as SimulatorConfiguration["context"]["status"];
                  setConfiguration((current) => ({
                    ...current,
                    context:
                      status === "resolved"
                        ? {
                            status,
                            confidence: 1,
                            source: "verified_host",
                            course: "Momentum Method",
                            module: "Build Your Rhythm",
                            lesson: "Minimum Day",
                          }
                        : { status },
                  }));
                }}
              >
                <option value="resolved">Resolved</option>
                <option value="ambiguous">Ambiguous</option>
                <option value="stale">Stale</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
          </div>

          <label>
            <span>Assistant name</span>
            <input
              value={configuration.branding.assistantName}
              onChange={(event) => updateBrand("assistantName", event.target.value)}
            />
          </label>
          <label>
            <span>Welcome copy</span>
            <textarea
              rows={3}
              value={configuration.branding.welcomeCopy}
              onChange={(event) => updateBrand("welcomeCopy", event.target.value)}
            />
          </label>

          <div className={styles.colorGrid}>
            {([
              ["primaryColor", "Primary"],
              ["accentColor", "Accent"],
              ["surfaceColor", "Surface"],
            ] as const).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <div className={styles.colorInput}>
                  <input
                    type="color"
                    value={configuration.branding[key]}
                    onChange={(event) => updateBrand(key, event.target.value)}
                    aria-label={`${label} color`}
                  />
                  <code>{configuration.branding[key]}</code>
                </div>
              </label>
            ))}
          </div>

          <div className={styles.toggleRows}>
            <label>
              <span><b>Voice control</b><small>Typed adapter events only</small></span>
              <input
                type="checkbox"
                checked={configuration.branding.voiceEnabled}
                onChange={(event) => updateBrand("voiceEnabled", event.target.checked)}
              />
            </label>
            <label>
              <span><b>Launcher side</b><small>{configuration.branding.launcherPosition}</small></span>
              <input
                type="checkbox"
                checked={configuration.branding.launcherPosition === "bottom-right"}
                onChange={(event) =>
                  updateBrand("launcherPosition", event.target.checked ? "bottom-right" : "bottom-left")
                }
              />
            </label>
          </div>
        </aside>

        <div className={styles.previewColumn}>
          <div className={styles.previewToolbar}>
            <div className={styles.viewportSwitch} role="group" aria-label="Preview viewport">
              <button
                className={viewportMode === "desktop" ? styles.selected : ""}
                onClick={() => setViewportMode("desktop")}
              >
                Desktop
              </button>
              <button
                className={viewportMode === "mobile" ? styles.selected : ""}
                onClick={() => setViewportMode("mobile")}
              >
                Mobile · 390
              </button>
            </div>
            <div className={styles.actionBar}>
              <button onClick={() => send({ source: "widget-lab", type: "open" })}>Open</button>
              <button onClick={() => send({ source: "widget-lab", type: "expand" })}>Expand</button>
              <button onClick={() => send({ source: "widget-lab", type: "restore" })}>Restore</button>
              <button onClick={() => send({ source: "widget-lab", type: "inject-evidence" })}>Add evidence</button>
              <button
                disabled={!configuration.branding.voiceEnabled}
                onClick={() => send({ source: "widget-lab", type: "start-voice" })}
              >
                Voice event
              </button>
            </div>
          </div>

          <div className={styles.browserFrame}>
            <div className={styles.browserChrome}>
              <span /><span /><span />
              <div>learn.northstar.example / minimum-day</div>
              <i>Host page</i>
            </div>
            <div className={viewportMode === "mobile" ? styles.mobileStage : styles.desktopStage}>
              <iframe
                ref={frameRef}
                src="/dev/widget/host"
                title="Widget host simulator"
                onLoad={() => {
                  setHostReady(false);
                }}
              />
            </div>
          </div>
        </div>

        <aside className={styles.inspector}>
          <div className={styles.panelHeading}>
            <div>
              <span>Observable state</span>
              <h2>Runtime inspector</h2>
            </div>
          </div>
          <dl className={styles.stateGrid}>
            <div><dt>Presentation</dt><dd>{snapshot?.snapshot.presentation ?? "—"}</dd></div>
            <div><dt>Modality</dt><dd>{snapshot?.snapshot.modality ?? "—"}</dd></div>
            <div><dt>Identity</dt><dd>{snapshot?.snapshot.identity.tier ?? "—"}</dd></div>
            <div><dt>Context</dt><dd>{contextLabel}</dd></div>
            <div><dt>Conversation</dt><dd>{snapshot?.snapshot.conversation.id ?? "—"}</dd></div>
            <div><dt>Thread items</dt><dd>{itemCount}</dd></div>
          </dl>

          <div className={styles.continuity}>
            <span data-pass={itemCount > 0} />
            <div>
              <b>Conversation continuity</b>
              <small>
                {itemCount > 0
                  ? `${itemCount} ordered item${itemCount === 1 ? "" : "s"} retained`
                  : "Waiting for runtime state"}
              </small>
            </div>
          </div>

          <div className={styles.activityHeading}>
            <h3>Adapter activity</h3>
            <span>sanitized</span>
          </div>
          <div className={styles.activity}>
            {activities.length ? (
              activities.map((activity, index) => (
                <div key={`${activity.at}-${index}`}>
                  <i />
                  <p><b>{activity.label}</b><span>{activity.detail}</span></p>
                  <time>{new Date(activity.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                </div>
              ))
            ) : (
              <p className={styles.emptyActivity}>Runtime events will appear here.</p>
            )}
          </div>

          <div className={styles.failureProbe}>
            <div>
              <b>Host-isolation probe</b>
              <p>Force an adapter bootstrap error. The element hides while the course remains usable.</p>
            </div>
            <div>
              <button onClick={() => send({ source: "widget-lab", type: "force-failure" })}>Force failure</button>
              <button className={styles.reset} onClick={() => send({ source: "widget-lab", type: "reset" })}>Reset widget</button>
            </div>
            {snapshot?.hidden ? <strong>Widget hidden · host unaffected</strong> : null}
          </div>
        </aside>
      </section>
    </main>
  );
}
