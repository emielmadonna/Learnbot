"use client";

import { useEffect, useRef, useState } from "react";

import { DevelopmentWidgetAdapter } from "../demo-adapter";
import {
  isHostCommand,
  type HostEvent,
  type SimulatorConfiguration,
} from "../protocol";
import {
  loadWidgetRuntime,
  type CourseAiWidgetElement,
  type WidgetConversation,
  type WidgetRuntimeAdapter,
} from "../runtime";
import styles from "./page.module.css";

const fallbackConfiguration: SimulatorConfiguration = {
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
};

function publish(event: HostEvent) {
  window.parent.postMessage(event, window.location.origin);
}

function assetBase() {
  const port = window.location.port ? `:${window.location.port}` : "";
  return `http://localhost${port}`;
}

export default function WidgetDevelopmentHost() {
  const mountRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<CourseAiWidgetElement | undefined>(undefined);
  const adapterRef = useRef<DevelopmentWidgetAdapter | undefined>(undefined);
  const configurationRef = useRef(fallbackConfiguration);
  const sessionsRef = useRef(new Map<string, WidgetConversation>());
  const [runtimeStatus, setRuntimeStatus] = useState("Loading isolated widget runtime…");

  useEffect(() => {
    let disposed = false;
    let monitor = 0;

    const report = (label: string, detail: string) => {
      publish({
        source: "widget-host",
        type: "activity",
        label,
        detail,
        at: new Date().toISOString(),
      });
    };

    const createAdapter = () =>
      new DevelopmentWidgetAdapter({
        configuration: () => configurationRef.current,
        sessions: sessionsRef.current,
        report,
        assetBase: assetBase(),
      });

    const configureWidget = async (
      widget: CourseAiWidgetElement,
      adapter: WidgetRuntimeAdapter,
    ) => {
      const configuration = configurationRef.current;
      await widget.configure({
        tenantKey: configuration.tenantKey,
        adapter,
        identity: {
          tier: configuration.identityTier,
          ...(configuration.learnerName.trim()
            ? { displayName: configuration.learnerName.trim() }
            : {}),
        },
        learningContext: configuration.context,
        branding: {
          ...configuration.branding,
          logoUrl: `${assetBase()}${configuration.branding.logoPath}`,
          fontFamily: "system",
          launcherLabel: `Open ${configuration.branding.assistantName}`,
        },
      });
    };

    const mount = async () => {
      const runtime = await loadWidgetRuntime();
      if (disposed || !mountRef.current) return;
      runtime.registerCourseAiWidget();
      const widget = document.createElement("course-ai-widget") as CourseAiWidgetElement;
      mountRef.current.replaceChildren(widget);
      widgetRef.current = widget;
      const adapter = createAdapter();
      adapterRef.current = adapter;
      await configureWidget(widget, adapter);
      setRuntimeStatus("Runtime connected · Shadow DOM active");
      publish({ source: "widget-host", type: "ready" });
      widget.open();
      window.clearInterval(monitor);
      monitor = window.setInterval(() => {
        const activeWidget = widgetRef.current;
        if (!activeWidget) return;
        publish({
          source: "widget-host",
          type: "snapshot",
          snapshot: activeWidget.getSnapshot(),
          hidden: activeWidget.style.display === "none",
        });
      }, 300);
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !isHostCommand(event.data)) return;
      const command = event.data;
      const widget = widgetRef.current;
      if (!widget) return;

      if (command.type === "configure") {
        const previous = configurationRef.current;
        sessionsRef.current.set(widget.getSnapshot().conversation.id, widget.getSnapshot().conversation);
        configurationRef.current = command.configuration;
        if (
          previous.tenantKey !== command.configuration.tenantKey ||
          previous.identityTier !== command.configuration.identityTier
        ) {
          const adapter = createAdapter();
          adapterRef.current = adapter;
          void configureWidget(widget, adapter);
        } else {
          widget.updateBranding({
            ...command.configuration.branding,
            logoUrl: `${assetBase()}${command.configuration.branding.logoPath}`,
          });
          widget.updateLearningContext(command.configuration.context);
        }
        report("Configuration applied", `${command.configuration.tenantName} · runtime update`);
        return;
      }
      if (command.type === "open") widget.open();
      if (command.type === "close") widget.close();
      if (command.type === "expand") widget.expand();
      if (command.type === "restore") widget.restore();
      if (command.type === "start-voice") void widget.startVoice();
      if (command.type === "inject-evidence") {
        adapterRef.current?.injectEvidence(widget.getSnapshot().conversation, (runtimeEvent) =>
          widget.receive(runtimeEvent),
        );
      }
      if (command.type === "force-failure") {
        void widget.configure({
          tenantKey: configurationRef.current.tenantKey,
          adapter: {
            async bootstrap() {
              throw new Error("Deliberate host-isolation probe");
            },
            async sendText() {},
            reportHealth(event) {
              report("Fail-silent probe", `${event.code} · host page remained active`);
            },
          },
        });
      }
      if (command.type === "reset") {
        mountRef.current?.replaceChildren();
        widget.disconnectedCallback();
        widgetRef.current = undefined;
        void mount();
      }
    };

    window.addEventListener("message", onMessage);
    void mount();
    return () => {
      disposed = true;
      window.clearInterval(monitor);
      window.removeEventListener("message", onMessage);
      widgetRef.current?.disconnectedCallback();
      widgetRef.current?.remove();
      widgetRef.current = undefined;
    };
  }, []);

  return (
    <div className={styles.host}>
      <header className={styles.courseHeader}>
        <a href="#" aria-label="Northstar learning home">
          <img src="/widget/northstar-mark.svg" alt="" />
          <span>Northstar</span>
        </a>
        <div className={styles.courseProgress}>
          <span>Course progress</span>
          <div><i /></div>
          <strong>58%</strong>
        </div>
      </header>

      <div className={styles.courseShell}>
        <aside>
          <p>Momentum Method</p>
          <strong>Build Your Rhythm</strong>
          <ol>
            <li className={styles.complete}>Reset Ritual</li>
            <li className={styles.active}>Minimum Day</li>
            <li>Evidence Loop</li>
            <li>Return Without Drama</li>
          </ol>
        </aside>
        <article className={styles.lesson}>
          <div className={styles.lessonMeta}>
            <span>Lesson 7 of 12</span>
            <span>8 min</span>
          </div>
          <h1>Your Minimum Day</h1>
          <p className={styles.lede}>
            Momentum is not built by perfect days. It is protected by the smallest
            promise you can keep when the day changes underneath you.
          </p>
          <div className={styles.lessonCard}>
            <span>THE PRACTICE</span>
            <h2>Define what still counts.</h2>
            <p>
              Choose one action small enough to survive disruption and specific
              enough to leave evidence. Complete it, record it, and let that proof
              carry you into tomorrow.
            </p>
          </div>
          <div className={styles.quote}>
            “The goal is not an impressive day. The goal is an unbroken relationship
            with the person you are becoming.”
          </div>
        </article>
      </div>

      <div ref={mountRef} />
      <div className={styles.runtimeStatus}>
        <span />
        {runtimeStatus}
      </div>
    </div>
  );
}
