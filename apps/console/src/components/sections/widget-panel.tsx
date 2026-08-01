"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelProps } from "../app-shell/contract";
import { asWorkspace, useDataVersion } from "../app-shell/shell-data";
import { usePanelRouter } from "../app-shell/use-panel-router";
import {
  Button,
  EmptyState,
  PanelFrame,
  SelectField,
  StateBadge,
  TextAreaField,
  TextField,
  Toggle,
} from "../ui";
import { HostedPublicationControls } from "./hosted-publication-controls";
import sectionStyles from "./sections.module.css";
import styles from "./widget-panel.module.css";

/*
 * Widget — set up and install the embeddable assistant.
 *
 * Three things this file deliberately does not do:
 *
 * 1. It does not re-declare the brand. Assistant name, mark, logo and the four
 *    colours are the agent configuration; the widget inherits them so the
 *    embedded assistant cannot drift from the workspace. Those fields are shown
 *    read-only with a link to the panel that owns them.
 * 2. It does not draw a picture of a widget. The preview mounts the real
 *    `<course-ai-widget>` custom element from `@course-ai/widget-runtime`,
 *    served by the delivery route, so what is on screen is the component the
 *    visitor gets. See {@link WidgetPreview} for how, and for what is honestly
 *    different about it (the transport).
 * 3. It does not invent a key, an origin list or a saved state. Until the
 *    widget delivery migration and `/api/widget/settings` are live on this
 *    database, the surface says so and offers nothing else.
 *
 * ---------------------------------------------------------------------------
 * Delivery contract this panel codes against (owned by the widget backend):
 *
 *   GET  /api/widget/settings
 *     -> { ok: true, dataMode: "durable", tenantId, expectedVersion,
 *          settings: WidgetSettings }
 *   POST /api/widget/settings
 *        { enabled, allowedOrigins, greeting, launcherLabel, launcherPosition,
 *          presentation, anonymousAccess, expectedVersion, idempotencyKey }
 *     -> { ok: true, expectedVersion, settings: WidgetSettings }
 *
 * Writes land on `tenant_update_widget_settings` with the same optimistic
 * concurrency and idempotency envelope as `tenant_update_agent_configuration`,
 * so a 409 here means somebody else edited the widget and this panel reloads
 * rather than overwriting them.
 */

/* ------------------------------------------------------- runtime contract */

/*
 * Type-only import of the runtime's own contract.
 *
 * `@course-ai/widget-runtime` is not a console dependency and its published
 * entry point is a build artefact, so it cannot be imported for value here.
 * These are erased at compile time — nothing from the package is bundled into
 * the console — but they keep the settings below pinned to the runtime's real
 * vocabulary instead of a copy that can quietly drift.
 */
import type {
  DesktopPresentation,
  WidgetBootstrap,
  WidgetBranding,
  WidgetPresentation,
  WidgetRuntimeAdapter,
  WidgetRuntimeConfiguration,
  WidgetThreadItem,
} from "../../../../../packages/widget-runtime/src/index";

/** The element as the console uses it: create, configure, choose a form. */
type WidgetElement = HTMLElement & {
  configure(configuration: WidgetRuntimeConfiguration): Promise<void>;
  open(): void;
  close(): void;
  expand(): void;
};

const WIDGET_TAG = "course-ai-widget";

/** The delivery route that serves the runtime bundle to customer sites. */
const RUNTIME_SRC = "/widget.js";

/* -------------------------------------------------------------- constants */

const ADMIN_ROLES = new Set(["tenant_owner", "tenant_admin"]);

const MAX_ORIGINS = 20;
const MAX_GREETING = 500;
const MAX_LAUNCHER_LABEL = 40;
const MAX_GREETING_DELAY_SECONDS = 120;

/**
 * The forms the runtime can be told to take on a desktop viewport.
 *
 * `mobile-sheet` is absent on purpose: it is not a choice. The runtime switches
 * to it below 768px on its own, so offering it here would be a setting that
 * does nothing.
 */
const FORM_OPTIONS: readonly { value: DesktopPresentation; label: string }[] = [
  { value: "launcher", label: "Launcher only" },
  { value: "panel", label: "Panel — a floating window" },
];

const POSITION_OPTIONS = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
] as const;

const SHAPE_OPTIONS = [
  { value: "bubble", label: "Bubble" },
  { value: "pill", label: "Pill" },
  { value: "tab", label: "Tab" },
] as const;

const APPEARANCE_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "light", label: "Always light" },
  { value: "dark", label: "Always dark" },
] as const;

/** Server codes become sentences. A raw code is never shown to a person. */
const CODE_SENTENCES: Record<string, string> = {
  access_denied:
    "Your role cannot change the widget. Ask a workspace owner to make this change.",
  authentication_required:
    "Your sign-in expired before the change was saved. Reload the page and sign in again.",
  idempotency_conflict:
    "A different change was already recorded for this attempt. Reload and try again.",
  invalid_origin:
    "This request did not come from an address this workspace trusts, so it was refused before it reached the widget service. Open the console from its usual URL and try again — nothing was saved.",
  invalid_request:
    "The server rejected one of these values. Check the highlighted fields and try again.",
  membership_not_active:
    "Your membership of this workspace is no longer active, so the change was refused. Nothing was saved.",
  origin_invalid:
    "One of the allowed domains was rejected by the server. Remove it and try again.",
  password_change_required:
    "This account still has a temporary password, and nothing can be saved until it is changed. Set a new password, sign in again, then reopen this panel — nothing was saved.",
  request_denied: "The change was refused. Nothing was saved.",
  request_failed:
    "The widget service is unavailable right now, so nothing was saved. This is not something you did — wait a moment and try again.",
  tenant_not_found: "This workspace is no longer available.",
  tenant_selection_required:
    "No workspace is selected. Reopen the workspace and try again.",
  version_conflict:
    "These settings were changed somewhere else since you opened them. Reload the latest version before saving, so the other change is not overwritten.",
};

const CONFLICT_SENTENCE = CODE_SENTENCES.version_conflict ?? "";

function sentenceFor(code: string | null): string {
  const sentence = code === null ? undefined : CODE_SENTENCES[code];
  return sentence ?? "The change could not be completed. Nothing was saved.";
}

/* ------------------------------------------------------------------ types */

type WidgetSettings = {
  enabled: boolean;
  /** Issued by the server. Never generated, guessed or padded in the browser. */
  publicKey: string | null;
  allowedOrigins: readonly string[];
  greeting: string;
  launcherLabel: string;
  launcherPosition: WidgetBranding["launcherPosition"];
  launcherShape: WidgetBranding["launcherShape"];
  greetingBubbleEnabled: boolean;
  greetingBubbleDelaySeconds: number;
  showPoweredBy: boolean;
  appearanceMode: WidgetBranding["appearanceMode"];
  presentation: WidgetPresentation;
  anonymousAccess: boolean;
  updatedAt: string | null;
};

type ServerState = {
  expectedVersion: number;
  baseline: WidgetSettings;
};

/**
 * Editable form state.
 *
 * `openByDefault` is not a second stored field. The runtime already expresses
 * "starts closed" as the `launcher` presentation, so this pair round-trips
 * through the single `presentation` value the delivery record holds — a
 * separate flag would be a second source of truth for the same thing.
 */
type Draft = {
  enabled: boolean;
  openByDefault: boolean;
  launcherPosition: WidgetBranding["launcherPosition"];
  launcherShape: WidgetBranding["launcherShape"];
  greeting: string;
  greetingBubbleEnabled: boolean;
  greetingBubbleDelaySeconds: number;
  launcherLabel: string;
  showPoweredBy: boolean;
  appearanceMode: WidgetBranding["appearanceMode"];
  anonymousAccess: boolean;
  allowedOrigins: string[];
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; server: ServerState }
  | { status: "error"; error: LoadError };

type LoadError =
  | "unavailable"
  | "denied"
  | "authentication"
  | "unverifiable";

const LOAD_ERROR_COPY: Record<
  LoadError,
  { headline: string; description: string; tone: "restricted" | "error" }
> = {
  unavailable: {
    headline: "Widget delivery is not enabled on this database yet",
    description:
      "The widget configuration service did not answer. This is expected until the widget delivery migration has been applied to this project's database and the delivery routes are deployed. No public key, no domain list and no preview are shown in their place — none of them exist yet.",
    tone: "restricted",
  },
  denied: {
    headline: "The widget is restricted for this role",
    description:
      "Only a workspace owner or admin can read and change the embeddable assistant. Nothing is substituted for the settings you cannot see.",
    tone: "restricted",
  },
  authentication: {
    headline: "Sign in again to configure the widget",
    description:
      "The session could not be verified for this request. Reload the console and sign in to continue.",
    tone: "error",
  },
  unverifiable: {
    headline: "The widget settings could not be verified",
    description:
      "The service replied with a payload this console cannot confirm is a durable widget record, so none of it is displayed and nothing can be saved from here.",
    tone: "error",
  },
};

/* ---------------------------------------------------------------- parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string | null {
  return isRecord(value) && typeof value.code === "string" ? value.code : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function presentationOf(value: unknown): WidgetPresentation {
  return value === "panel" ? value : "launcher";
}

function positionOf(value: unknown): WidgetBranding["launcherPosition"] {
  return value === "bottom-left" ? "bottom-left" : "bottom-right";
}

function launcherShapeOf(value: unknown): WidgetBranding["launcherShape"] {
  return value === "pill" || value === "tab" ? value : "bubble";
}

function appearanceModeOf(value: unknown): WidgetBranding["appearanceMode"] {
  return value === "light" || value === "dark" ? value : "auto";
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Read the settings record out of a response envelope.
 *
 * The container is accepted under any of the three names the delivery record
 * is plausibly published as while that route lands. Field names are not
 * guessed: anything absent falls back to a neutral value and is visible as
 * such, never to an invented key or domain.
 */
function readSettings(body: Record<string, unknown>): WidgetSettings | null {
  const container = [body.settings, body.widget, body.launcher].find(isRecord);
  if (!container) return null;
  return {
    enabled: flag(container.enabled, false),
    publicKey: nullableText(container.publicKey),
    allowedOrigins: stringList(container.allowedOrigins),
    greeting: text(container.greeting, ""),
    launcherLabel: text(container.launcherLabel, ""),
    launcherPosition: positionOf(container.launcherPosition),
    launcherShape: launcherShapeOf(container.launcherShape),
    greetingBubbleEnabled: flag(container.greetingBubbleEnabled, true),
    greetingBubbleDelaySeconds: integer(
      container.greetingBubbleDelaySeconds,
      20,
    ),
    showPoweredBy: flag(container.showPoweredBy, true),
    appearanceMode: appearanceModeOf(container.appearanceMode),
    presentation: presentationOf(container.presentation),
    anonymousAccess: flag(container.anonymousAccess, false),
    updatedAt: nullableText(container.updatedAt),
  };
}

function toDraft(settings: WidgetSettings): Draft {
  const presentation = settings.presentation;
  return {
    enabled: settings.enabled,
    openByDefault: presentation === "panel",
    launcherPosition: settings.launcherPosition,
    launcherShape: settings.launcherShape,
    greeting: settings.greeting,
    greetingBubbleEnabled: settings.greetingBubbleEnabled,
    greetingBubbleDelaySeconds: settings.greetingBubbleDelaySeconds,
    launcherLabel: settings.launcherLabel,
    showPoweredBy: settings.showPoweredBy,
    appearanceMode: settings.appearanceMode,
    anonymousAccess: settings.anonymousAccess,
    allowedOrigins: [...settings.allowedOrigins],
  };
}

/** The single presentation value the delivery record stores for a draft. */
function draftPresentation(draft: Draft): DesktopPresentation {
  return draft.openByDefault ? "panel" : "launcher";
}

/** Order-sensitive identity of a draft, so "unsaved" never fires spuriously. */
function fingerprint(draft: Draft): string {
  return JSON.stringify({ ...draft, allowedOrigins: [...draft.allowedOrigins] });
}

/* ------------------------------------------------------------- validation */

type OriginResult = { origin: string } | { error: string };

/**
 * An allowed origin is a scheme and a host, and nothing else.
 *
 * Everything beyond that is rejected with a reason rather than silently
 * trimmed, because a domain list that quietly accepts `https://x.com/help` and
 * stores `https://x.com` is a security control the operator cannot read.
 */
function normalizeOrigin(value: string): OriginResult {
  const raw = value.trim();
  if (raw.length === 0) return { error: "Enter a domain." };
  if (raw.includes("*")) {
    return {
      error:
        "Wildcards are not accepted. Every domain the widget answers on has to be listed exactly.",
    };
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: "That is not a web address this console can recognise." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "Only http:// and https:// addresses can be allowed." };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { error: "Remove the credentials — an origin is only a scheme and a host." };
  }
  if (url.hostname.length === 0) {
    return { error: "That address has no domain in it." };
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    return {
      error:
        "Enter only the domain. A path, query or fragment is not part of an origin, and the browser never sends one.",
    };
  }
  return { origin: url.origin };
}

function isLoopback(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function isInsecure(origin: string): boolean {
  return origin.startsWith("http://") && !isLoopback(origin);
}

type DraftErrors = {
  greeting?: string;
  greetingBubbleDelaySeconds?: string;
  launcherLabel?: string;
};

function validate(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  const greeting = draft.greeting.trim();
  if (greeting.length === 0) {
    errors.greeting = "Visitors see this first, so it cannot be empty.";
  } else if (greeting.length > MAX_GREETING) {
    errors.greeting = `Use ${MAX_GREETING} characters or fewer (currently ${greeting.length}).`;
  }
  if (draft.launcherLabel.trim().length > MAX_LAUNCHER_LABEL) {
    errors.launcherLabel = `Use ${MAX_LAUNCHER_LABEL} characters or fewer.`;
  }
  if (
    !Number.isInteger(draft.greetingBubbleDelaySeconds) ||
    draft.greetingBubbleDelaySeconds < 0 ||
    draft.greetingBubbleDelaySeconds > MAX_GREETING_DELAY_SECONDS
  ) {
    errors.greetingBubbleDelaySeconds =
      `Choose a delay from 0 to ${MAX_GREETING_DELAY_SECONDS} seconds.`;
  }
  return errors;
}

function SegmentedChoice<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <fieldset className={styles.segmentedField}>
      <legend>{label}</legend>
      <div className={styles.segmentedControl}>
        {options.map((option) => (
          <button
            aria-pressed={value === option.value}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------- runtime delivery */

/**
 * Load the real runtime bundle once per document.
 *
 * The script is injected without `data-tenant`. That attribute is what makes
 * the bundle auto-mount a live, floating widget on whatever page loaded it,
 * and the console is not a customer site — the preview creates and configures
 * its own element instead.
 */
let runtimeLoad: Promise<boolean> | null = null;

function loadWidgetRuntime(): Promise<boolean> {
  if (typeof window === "undefined" || !window.customElements) {
    return Promise.resolve(false);
  }
  if (runtimeLoad === null) {
    runtimeLoad = new Promise<boolean>((resolve) => {
      if (window.customElements.get(WIDGET_TAG)) {
        resolve(true);
        return;
      }
      const timer = window.setTimeout(() => resolve(false), 10_000);
      const settle = (loaded: boolean) => {
        window.clearTimeout(timer);
        resolve(loaded);
      };
      void window.customElements
        .whenDefined(WIDGET_TAG)
        .then(() => settle(true), () => settle(false));

      const selector = "script[data-course-ai-widget-runtime]";
      if (document.querySelector(selector) === null) {
        const script = document.createElement("script");
        script.src = RUNTIME_SRC;
        script.async = true;
        script.dataset.courseAiWidgetRuntime = "true";
        script.addEventListener("error", () => settle(false), { once: true });
        document.head.append(script);
      }
    });
  }
  return runtimeLoad;
}

function retryWidgetRuntime() {
  runtimeLoad = null;
  document
    .querySelectorAll("script[data-course-ai-widget-runtime]")
    .forEach((node) => {
      node.remove();
    });
}

/**
 * The preview transport.
 *
 * This authenticated transport uses the same grounded provider path as the
 * assistant editor while keeping the turn ephemeral. Owners can verify a real
 * answer and its sources before enabling anonymous access on customer domains.
 */
function previewAdapter(branding: PreviewBranding): WidgetRuntimeAdapter {
  let sequence = 0;
  return {
    bootstrap: (): Promise<WidgetBootstrap> =>
      Promise.resolve({
        conversation: { id: `preview-${Date.now()}`, items: [] },
        branding,
        identity: { tier: "anonymous" as const },
        learningContext: { status: "unknown" as const },
      }),
    sendText: async (input, emit) => {
      sequence += 2;
      const itemId = `preview-reply-${sequence}`;
      emit({
        type: "thread.item",
        conversationId: input.conversationId,
        item: {
          id: itemId,
          sequence,
          role: "assistant",
          modality: "text",
          status: "pending",
          parts: [],
          createdAt: new Date().toISOString(),
        },
      });
      try {
        const response = await fetch("/api/agent/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: input.text,
            assistantName: branding.assistantName,
          }),
          signal: input.signal,
        });
        const payload = (await response.json()) as Record<string, unknown>;
        const preview =
          payload.preview && typeof payload.preview === "object"
            ? (payload.preview as Record<string, unknown>)
            : null;
        if (!response.ok || payload.ok !== true || !preview) {
          emit({
            type: "error",
            conversationId: input.conversationId,
            code: "answer_unavailable",
            recoverable: true,
          });
          return;
        }

        const parts: WidgetThreadItem["parts"] = [
          {
            kind: "text",
            text:
              typeof preview.answer === "string"
                ? preview.answer
                : "The grounded preview did not return an answer.",
          },
        ];
        if (Array.isArray(preview.sources)) {
          for (const [index, candidate] of preview.sources.entries()) {
            if (
              !candidate ||
              typeof candidate !== "object" ||
              Array.isArray(candidate)
            ) {
              continue;
            }
            const source = candidate as Record<string, unknown>;
            const title =
              typeof source.lessonTitle === "string"
                ? source.lessonTitle
                : typeof source.documentTitle === "string"
                  ? source.documentTitle
                  : null;
            if (!title) continue;
            parts.push({
              kind: "source",
              id:
                typeof source.chunkId === "string"
                  ? source.chunkId
                  : `preview-source-${index}`,
              title:
                typeof source.courseTitle === "string"
                  ? `${title} · ${source.courseTitle}`
                  : title,
              url: "",
            });
          }
        }
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: itemId,
            sequence,
            role: "assistant",
            modality: "text",
            status: "complete",
            parts,
            createdAt: new Date().toISOString(),
          },
        });
        emit({
          type: "response.complete",
          conversationId: input.conversationId,
          itemId,
        });
      } catch {
        emit({
          type: "error",
          conversationId: input.conversationId,
          code: "answer_unavailable",
          recoverable: true,
        });
      }
    },
  };
}

/* ----------------------------------------------------------------- preview */

type PreviewBranding = Partial<WidgetBranding>;

type Frame = { scale: number; width: number; height: number };

/**
 * The real `<course-ai-widget>`, mounted inside the panel.
 *
 * Two facts about the runtime make this possible without touching it. Its
 * launcher and surface are `position: fixed`, and it computes its panel
 * geometry against `window.innerWidth/innerHeight`. So the stage below is a
 * `100vw × 100vh` box carrying a `transform`, which makes it the containing
 * block for every fixed descendant — across the shadow boundary, because
 * containing blocks are a layout concept, not a style one — while the scale
 * shrinks that full viewport to whatever width the panel has. The widget lays
 * itself out in real viewport coordinates and lands exactly where it would on
 * the visitor's screen, only smaller.
 */
function WidgetPreview({
  branding,
  presentation,
  tenantKey,
  disabled,
}: {
  branding: PreviewBranding;
  presentation: DesktopPresentation;
  tenantKey: string;
  disabled: boolean;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<WidgetElement | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [runtime, setRuntime] = useState<"loading" | "ready" | "missing">(
    "loading",
  );
  /*
   * Bumped every time the element is (re)created. The configuration effect
   * depends on it because the stage can appear after the runtime is already
   * loaded — measuring the panel is what renders it — and without this the
   * effect would have run to completion before there was an element to
   * configure, leaving an unconfigured widget on the stage.
   */
  const [mountToken, setMountToken] = useState(0);

  // Measure once the panel has a width, and again whenever either the panel or
  // the browser window changes size — the widget's own geometry depends on the
  // window, so the scale has to track both.
  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null) return;
    const measure = () => {
      const available = holder.clientWidth;
      const viewportWidth = window.innerWidth || 1;
      const viewportHeight = window.innerHeight || 1;
      if (available <= 0) return;
      const scale = Math.min(1, Math.max(0.12, available / viewportWidth));
      setFrame({ scale, width: viewportWidth, height: viewportHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(holder);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadWidgetRuntime().then((loaded) => {
      if (!cancelled) setRuntime(loaded ? "ready" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create the element once the runtime is defined and the stage measured.
  const stageRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        elementRef.current?.remove();
        elementRef.current = null;
        return;
      }
      if (elementRef.current !== null || runtime !== "ready") return;
      const element = document.createElement(WIDGET_TAG) as WidgetElement;
      node.append(element);
      elementRef.current = element;
      setMountToken((value) => value + 1);
    },
    [runtime],
  );

  // Re-configure on every settings change. `configure` is the runtime's own
  // entry point and resets the conversation, which is correct here: the
  // preview is a fresh visitor each time the branding changes.
  const brandingKey = JSON.stringify(branding);
  useEffect(() => {
    const element = elementRef.current;
    if (element === null || runtime !== "ready") return;
    const timer = window.setTimeout(() => {
      const resolvedBranding = JSON.parse(brandingKey) as PreviewBranding;
      void element
        .configure({
          tenantKey,
          adapter: previewAdapter(resolvedBranding),
          branding: resolvedBranding,
        })
        .then(() => {
          if (presentation === "launcher") element.close();
          else if (presentation === "expanded") element.expand();
          else element.open();
        })
        .catch(() => undefined);
    }, 260);
    return () => {
      window.clearTimeout(timer);
    };
  }, [brandingKey, mountToken, presentation, runtime, tenantKey]);

  if (runtime === "missing") {
    return (
      <EmptyState
        action={
          <Button
            onClick={() => {
              retryWidgetRuntime();
              setRuntime("loading");
              void loadWidgetRuntime().then((loaded) =>
                setRuntime(loaded ? "ready" : "missing"),
              );
            }}
          >
            Try loading it again
          </Button>
        }
        description={`The widget runtime did not load from ${RUNTIME_SRC}, so there is nothing real to show. No mock-up is drawn in its place — a picture of a widget would tell you nothing about the one your visitors get.`}
        headline="The live preview could not start"
        tone="error"
      />
    );
  }

  return (
    <div className={styles.previewHolder} ref={holderRef}>
      <div
        className={styles.previewViewport}
        style={
          frame === null
            ? undefined
            : { height: `${Math.round(frame.height * frame.scale)}px` }
        }
      >
        {frame === null ? null : (
          <div
            className={styles.previewStage}
            ref={stageRef}
            style={{
              height: `${frame.height}px`,
              transform: `scale(${frame.scale})`,
              width: `${frame.width}px`,
            }}
          />
        )}
      </div>
      <p className={styles.previewNote}>
        This is the real <code>&lt;{WIDGET_TAG}&gt;</code> element from the
        widget runtime, scaled down from a full browser window — not a mock-up.
        Questions use the real grounded assistant in an authenticated,
        non-persisted preview; published widgets still answer only on the
        domains below.
        {disabled ? " The widget is currently switched off, so nothing like this is on your site yet." : ""}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ origins */

function OriginList({
  origins,
  disabled,
  onAdd,
  onRemove,
}: {
  origins: readonly string[];
  disabled: boolean;
  onAdd: (origin: string) => string | null;
  onRemove: (origin: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const submit = () => {
    const failure = onAdd(value);
    if (failure === null) {
      setValue("");
      setError(null);
    } else {
      setError(failure);
    }
  };

  return (
    <div className={styles.origins}>
      <div className={styles.originAdd}>
        <TextField
          autoComplete="off"
          className={styles.originInput}
          disabled={disabled || origins.length >= MAX_ORIGINS}
          {...(error === null ? {} : { error })}
          help="The exact scheme and domain, for example https://community.example.com. One entry per domain."
          id={inputId}
          label="Add a domain"
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="https://example.com"
          value={value}
        />
        <Button
          disabled={disabled || origins.length >= MAX_ORIGINS}
          onClick={submit}
        >
          Add
        </Button>
      </div>

      {origins.length === 0 ? (
        <EmptyState
          compact
          description="With no domain listed the widget answers nowhere. Add the site you are installing it on before you turn it on."
          headline="No domain is allowed yet"
          tone="restricted"
        />
      ) : (
        <ul className={styles.originList}>
          {origins.map((origin) => (
            <li className={styles.originRow} key={origin}>
              <span className={styles.originValue}>{origin}</span>
              {isInsecure(origin) ? (
                <span className={styles.originWarn}>
                  Not encrypted — anything the widget sends on this domain
                  travels in the clear.
                </span>
              ) : null}
              <Button
                disabled={disabled}
                onClick={() => onRemove(origin)}
                size="sm"
                variant="ghost"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {origins.length >= MAX_ORIGINS ? (
        <p className={styles.hint}>
          {MAX_ORIGINS} domains is the limit for one workspace. Remove one to
          add another.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ snippet */

function Snippet({
  code,
  label,
  description,
}: {
  code: string;
  label: string;
  description: string;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  return (
    <div className={styles.snippet}>
      <div className={styles.snippetHead}>
        <div>
          <strong>{label}</strong>
          <p>{description}</p>
        </div>
        <Button
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => setCopied("done"), () => setCopied("failed"));
          }}
          size="sm"
        >
          Copy
        </Button>
      </div>
      <pre className={styles.snippetCode}>
        <code>{code}</code>
      </pre>
      <p aria-live="polite" className={styles.snippetStatus}>
        {copied === "done"
          ? "Copied to the clipboard."
          : copied === "failed"
            ? "The browser refused clipboard access. Select the snippet above and copy it manually."
            : ""}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------- panel */

/**
 * Widget panel — configure and install the embeddable assistant.
 */
export function WidgetPanel({ payload, params }: PanelProps) {
  const dataVersion = useDataVersion();
  const { panelHref, openPanel } = usePanelRouter();
  const workspace = asWorkspace(payload);
  const role = workspace?.identity.role ?? payload.role;
  const canConfigure = ADMIN_ROLES.has(role);
  const requestedView = params.get("view");
  const activeView =
    requestedView === "appearance" || requestedView === "install"
      ? requestedView
      : "overview";
  const showAppearance = activeView !== "install";
  const showDelivery = activeView !== "appearance";

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (!canConfigure) return;
    let cancelled = false;
    setLoad({ status: "loading" });

    async function run() {
      let response: Response;
      try {
        response = await fetch("/api/widget/settings", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
      } catch {
        if (!cancelled) setLoad({ status: "error", error: "unavailable" });
        return;
      }
      const body = await readJson(response);
      if (cancelled) return;

      if (!response.ok) {
        const code = codeOf(body);
        const error: LoadError =
          response.status === 403 || code === "access_denied"
            ? "denied"
            : response.status === 401 || code === "authentication_required"
              ? "authentication"
              : "unavailable";
        setLoad({ status: "error", error });
        return;
      }
      if (!isRecord(body) || body.ok !== true) {
        setLoad({ status: "error", error: "unverifiable" });
        return;
      }
      const settings = readSettings(body);
      const expectedVersion =
        typeof body.expectedVersion === "number" ? body.expectedVersion : null;
      if (settings === null || expectedVersion === null) {
        setLoad({ status: "error", error: "unverifiable" });
        return;
      }
      setLoad({ status: "ready", server: { baseline: settings, expectedVersion } });
      setDraft(toDraft(settings));
      setPublicKey(settings.publicKey);
      setConflict(false);
      setSaveError(null);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [canConfigure, dataVersion, reloadToken]);

  const server = load.status === "ready" ? load.server : null;
  const errors = useMemo(
    () => (draft === null ? {} : validate(draft)),
    [draft],
  );
  const invalid = Object.keys(errors).length > 0;
  const dirty =
    draft !== null &&
    server !== null &&
    fingerprint(draft) !== fingerprint(toDraft(server.baseline));

  const update = useCallback(<Key extends keyof Draft>(key: Key, value: Draft[Key]) => {
    setSaveError(null);
    setStatus(null);
    setDraft((current) => {
      if (current === null) return current;
      const next: Draft = { ...current };
      next[key] = value;
      return next;
    });
  }, []);

  /*
   * Returns the reason it was refused, or null when it was added.
   *
   * The duplicate check reads the current draft rather than the value inside
   * the state updater: React runs that updater during the next render, so
   * anything reported from inside it would arrive after this function has
   * already returned "accepted".
   */
  const addOrigin = useCallback(
    (value: string): string | null => {
      const result = normalizeOrigin(value);
      if ("error" in result) return result.error;
      if (draft !== null && draft.allowedOrigins.includes(result.origin)) {
        return "That domain is already allowed.";
      }
      setDraft((current) =>
        current === null || current.allowedOrigins.includes(result.origin)
          ? current
          : {
              ...current,
              allowedOrigins: [...current.allowedOrigins, result.origin],
            },
      );
      setStatus(null);
      return null;
    },
    [draft],
  );

  const removeOrigin = useCallback((value: string) => {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            allowedOrigins: current.allowedOrigins.filter((entry) => entry !== value),
          },
    );
    setStatus(null);
  }, []);

  const save = useCallback(async () => {
    if (draft === null || server === null) return;
    setSaving(true);
    setSaveError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/widget/settings", {
        body: JSON.stringify({
          allowedOrigins: draft.allowedOrigins,
          anonymousAccess: draft.anonymousAccess,
          enabled: draft.enabled,
          expectedVersion: server.expectedVersion,
          greeting: draft.greeting.trim(),
          greetingBubbleDelaySeconds: draft.greetingBubbleDelaySeconds,
          greetingBubbleEnabled: draft.greetingBubbleEnabled,
          idempotencyKey: crypto.randomUUID(),
          launcherLabel: draft.launcherLabel.trim(),
          launcherPosition: draft.launcherPosition,
          launcherShape: draft.launcherShape,
          appearanceMode: draft.appearanceMode,
          presentation: draftPresentation(draft),
          showPoweredBy: draft.showPoweredBy,
        }),
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (!response.ok) {
        const code = codeOf(body);
        if (response.status === 409 || code === "version_conflict") {
          setConflict(true);
        } else {
          setSaveError(sentenceFor(code));
        }
        return;
      }
      if (!isRecord(body) || body.ok !== true) {
        setSaveError(
          "The service replied with something this console cannot confirm was a saved record, so the panel will not claim the change landed. Reload to see what is actually stored.",
        );
        return;
      }
      const settings = readSettings(body);
      const expectedVersion =
        typeof body.expectedVersion === "number"
          ? body.expectedVersion
          : server.expectedVersion + 1;
      if (settings !== null) {
        setLoad({ status: "ready", server: { baseline: settings, expectedVersion } });
        setDraft(toDraft(settings));
        setPublicKey(settings.publicKey);
      } else {
        setReloadToken((value) => value + 1);
      }
      setStatus("Saved. The widget on your site picks this up on its next load.");
    } catch {
      setSaveError(sentenceFor("request_failed"));
    } finally {
      setSaving(false);
    }
  }, [draft, server]);

  /* ------------------------------------------------------------- gating */

  if (!canConfigure) {
    return (
      <EmptyState
        description="Only a workspace owner or admin can set up the embeddable assistant, because it controls which domains may ask your learning questions."
        headline="The widget is configured by a workspace owner"
        tone="restricted"
      />
    );
  }

  if (load.status === "loading") {
    return <p className={sectionStyles.meta}>Reading the widget settings…</p>;
  }

  if (load.status === "error") {
    const copy = LOAD_ERROR_COPY[load.error];
    return (
      <EmptyState
        action={
          load.error === "unavailable" || load.error === "unverifiable" ? (
            <Button onClick={() => setReloadToken((value) => value + 1)}>
              Check again
            </Button>
          ) : undefined
        }
        description={copy.description}
        headline={copy.headline}
        tone={copy.tone}
      />
    );
  }

  if (draft === null || server === null) {
    return (
      <EmptyState
        description="The widget record was read but held nothing this panel can edit. Nothing is shown in its place."
        headline="No widget settings to edit"
        tone="restricted"
      />
    );
  }

  /* ------------------------------------------------------------ install */

  const consoleOrigin = origin ?? "";
  const scriptUrl = consoleOrigin ? `${consoleOrigin}${RUNTIME_SRC}` : RUNTIME_SRC;
  const htmlSnippet =
    publicKey === null
      ? ""
      : `<script\n  src="${scriptUrl}"\n  data-tenant="${publicKey}"\n  defer\n></script>`;
  const circleSnippet =
    publicKey === null
      ? ""
      : `(() => {\n  const script = document.createElement("script");\n  script.src = "${scriptUrl}";\n  script.dataset.tenant = "${publicKey}";\n  script.defer = true;\n  document.head.append(script);\n})();`;

  const previewBranding: PreviewBranding = {
    accentColor: payload.agent.accentColor,
    assistantName: payload.agent.assistantName,
    launcherLabel: draft.launcherLabel.trim() || payload.agent.assistantName,
    launcherPosition: draft.launcherPosition,
    launcherShape: draft.launcherShape,
    greetingBubbleEnabled: draft.greetingBubbleEnabled,
    greetingBubbleDelaySeconds: draft.greetingBubbleDelaySeconds,
    showPoweredBy: draft.showPoweredBy,
    appearanceMode: draft.appearanceMode,
    primaryColor: payload.agent.primaryColor,
    surfaceColor: payload.agent.surfaceColor,
    textColor: payload.agent.textColor,
    voiceEnabled: payload.agent.voice.trim().length > 0,
    welcomeCopy: draft.greeting.trim() || payload.agent.welcomeMessage,
    ...(payload.agent.logoUrl === null ? {} : { logoUrl: payload.agent.logoUrl }),
    ...(payload.agent.avatarUrl === null ? {} : { avatarUrl: payload.agent.avatarUrl }),
  };

  const savedPresentation = server.baseline.presentation;
  const liveLabel = server.baseline.enabled
    ? server.baseline.allowedOrigins.length === 0
      ? "On, but no domain is allowed"
      : `On for ${server.baseline.allowedOrigins.length} ${server.baseline.allowedOrigins.length === 1 ? "domain" : "domains"}`
    : "Off";

  return (
    <div className={styles.editorRoot}>
      <PanelFrame
        autoFocus={false}
        className={styles.frame}
        description="The widget is your assistant on your own website. It takes its name, mark and colours from the assistant configuration, and it answers only on the domains you list here."
        eyebrow="Widget"
        footer={
          <>
            <Button
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(toDraft(server.baseline));
                setSaveError(null);
                setStatus("Reverted to the saved settings.");
              }}
            >
              Discard changes
            </Button>
            <Button
              disabled={!dirty || invalid || saving || conflict}
              loading={saving}
              loadingLabel="Saving…"
              onClick={() => void save()}
              variant="primary"
            >
              Save widget settings
            </Button>
          </>
        }
        footerLead={
          conflict
            ? "Changed elsewhere"
            : dirty
              ? "Unsaved changes"
              : status ?? liveLabel
        }
        side="inline"
        title="Your website widget"
      >
        <nav className={styles.subnav} aria-label="Widget settings">
          {[
            { key: "overview", label: "Overview" },
            { key: "appearance", label: "Appearance" },
            { key: "install", label: "Install & domains" },
          ].map((item) => {
            const href = panelHref(
              "widget",
              item.key === "overview" ? undefined : { view: item.key },
            );
            return (
              <a
                aria-current={activeView === item.key ? "page" : undefined}
                className={styles.subnavLink}
                href={href}
                key={item.key}
                onClick={(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  ) {
                    return;
                  }
                  event.preventDefault();
                  openPanel(
                    "widget",
                    item.key === "overview" ? undefined : { view: item.key },
                  );
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className={styles.layout}>
          <div className={styles.column}>
            {conflict ? (
              <div className={styles.conflict} role="alert">
                <p>{CONFLICT_SENTENCE}</p>
                <Button
                  onClick={() => {
                    setConflict(false);
                    setSaveError(null);
                    setReloadToken((value) => value + 1);
                  }}
                  variant="danger"
                >
                  Reload the latest settings
                </Button>
              </div>
            ) : null}

            {saveError !== null && !conflict ? (
              <p className={styles.error} role="alert">
                {saveError}
              </p>
            ) : null}

            {/* ------------------------------------------------ status */}
            <section className={styles.card} hidden={!showDelivery}>
              <header className={styles.cardHead}>
                <h3>Status</h3>
                <StateBadge state={server.baseline.enabled ? "known" : "unknown"}>
                  {server.baseline.enabled ? "Live" : "Off"}
                </StateBadge>
              </header>
              <Toggle
                checked={draft.enabled}
                description="While it is off, the widget answers on no domain at all, whether or not the script is still on the page."
                label="Answer questions on my website"
                onChange={(next) => update("enabled", next)}
              />
              {!server.baseline.enabled ? (
                <p className={styles.hint}>
                  Nothing is live yet. The saved state of this widget is off, so
                  a visitor to your site sees no launcher and gets no answers —
                  the preview below is a configuration preview, not something
                  that exists on your site.
                </p>
              ) : null}
              {server.baseline.enabled && server.baseline.allowedOrigins.length === 0 ? (
                <p className={styles.hint}>
                  The widget is on, but no domain is allowed, so it still
                  answers nowhere. Add the site you are installing it on.
                </p>
              ) : null}
              {server.baseline.updatedAt !== null ? (
                <p className={styles.meta}>
                  Last saved{" "}
                  {new Date(server.baseline.updatedAt).toLocaleString(undefined, {
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    month: "short",
                  })}
                  .
                </p>
              ) : null}
            </section>

            {/* -------------------------------------------- appearance */}
            <section className={styles.card} hidden={!showAppearance}>
              <header className={styles.cardHead}>
                <h3>Appearance</h3>
              </header>
              <div className={styles.inherited}>
                <p className={styles.inheritedLead}>
                  Inherited from the assistant configuration, so the widget can
                  never drift from your brand. Change it there and it changes
                  here, on the app, and on every site the widget is installed
                  on.
                </p>
                <dl className={styles.inheritedGrid}>
                  <div>
                    <dt>Name</dt>
                    <dd>{payload.agent.assistantName || "Not set"}</dd>
                  </div>
                  <div>
                    <dt>Mark</dt>
                    <dd>
                      {payload.agent.logoUrl !== null
                        ? "Logo image"
                        : payload.agent.iconGlyph || "Initial"}
                    </dd>
                  </div>
                  <div>
                    <dt>Colours</dt>
                    <dd>
                      <span className={styles.swatches} aria-hidden="true">
                        {[
                          payload.agent.primaryColor,
                          payload.agent.accentColor,
                          payload.agent.surfaceColor,
                          payload.agent.textColor,
                        ].map((colour, index) => (
                          <i
                            key={`${colour}-${String(index)}`}
                            style={{ background: colour }}
                          />
                        ))}
                      </span>
                      <span className={styles.srOnlyList}>
                        Primary {payload.agent.primaryColor}, accent{" "}
                        {payload.agent.accentColor}, surface{" "}
                        {payload.agent.surfaceColor}, text{" "}
                        {payload.agent.textColor}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Voice</dt>
                    <dd>
                      {payload.agent.voice.trim().length > 0
                        ? "Available in the widget"
                        : "Text only"}
                    </dd>
                  </div>
                </dl>
                <a
                  className={styles.inheritedLink}
                  href={panelHref("agent")}
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    ) {
                      return;
                    }
                    event.preventDefault();
                    openPanel("agent");
                  }}
                >
                  Edit these in the assistant configuration
                </a>
              </div>

              <SegmentedChoice
                label="Launcher shape"
                onChange={(value) => update("launcherShape", value)}
                options={SHAPE_OPTIONS}
                value={draft.launcherShape}
              />

              <SelectField
                help="Where the launcher sits on the visitor's screen."
                label="Launcher position"
                onChange={(event) =>
                  update(
                    "launcherPosition",
                    event.target.value === "bottom-left" ? "bottom-left" : "bottom-right",
                  )
                }
                options={POSITION_OPTIONS.map((option) => ({ ...option }))}
                value={draft.launcherPosition}
              />

              <TextField
                {...(errors.launcherLabel === undefined
                  ? {}
                  : { error: errors.launcherLabel })}
                help="Shown inside Pill and Tab launchers and read out by screen readers. Leave empty to use the assistant's name."
                label="Label"
                onChange={(event) => update("launcherLabel", event.target.value)}
                value={draft.launcherLabel}
              />

              <TextAreaField
                {...(errors.greeting === undefined ? {} : { error: errors.greeting })}
                help="The first thing a visitor reads when the widget opens, and the one-line nudge shown beside the launcher."
                label="Greeting"
                onChange={(event) => update("greeting", event.target.value)}
                rows={3}
                value={draft.greeting}
              />

              <Toggle
                bordered
                checked={draft.greetingBubbleEnabled}
                description={`A one-line nudge after ${draft.greetingBubbleDelaySeconds} seconds on a lesson.`}
                label="Greeting bubble"
                onChange={(next) => update("greetingBubbleEnabled", next)}
              />

              {draft.greetingBubbleEnabled ? (
                <TextField
                  {...(errors.greetingBubbleDelaySeconds === undefined
                    ? {}
                    : { error: errors.greetingBubbleDelaySeconds })}
                  help="Use 0 to show it immediately, or up to 120 seconds."
                  label="Greeting delay (seconds)"
                  max={MAX_GREETING_DELAY_SECONDS}
                  min={0}
                  onChange={(event) =>
                    update(
                      "greetingBubbleDelaySeconds",
                      Number(event.currentTarget.value),
                    )
                  }
                  step={1}
                  type="number"
                  value={draft.greetingBubbleDelaySeconds}
                />
              ) : null}

              <Toggle
                bordered
                checked={draft.showPoweredBy}
                description="Show the Corso attribution below the conversation."
                label='Show “Powered by Corso”'
                onChange={(next) => update("showPoweredBy", next)}
              />

              <SegmentedChoice
                label="Appearance"
                onChange={(value) => update("appearanceMode", value)}
                options={APPEARANCE_OPTIONS}
                value={draft.appearanceMode}
              />

              <Toggle
                bordered
                checked={draft.openByDefault}
                description="Most sites leave this off, so the visitor chooses when to start."
                label="Open as soon as the page loads"
                onChange={(next) => update("openByDefault", next)}
              />

              {draft.openByDefault ? (
                <p className={styles.meta}>
                  It opens as a floating panel on desktop and automatically
                  becomes a full-height sheet below 768px. Expanded desktop
                  mode is not stored by the current delivery service, so it is
                  not offered as a setting.
                </p>
              ) : null}
            </section>

            {/* -------------------------------------- hosted full-page link */}
            <HostedPublicationControls
              draftAnonymousAccess={draft.anonymousAccess}
              draftEnabled={draft.enabled}
              draftOrigins={draft.allowedOrigins}
              hidden={!showDelivery}
              onAddOrigin={addOrigin}
              savedAnonymousAccess={server.baseline.anonymousAccess}
              savedEnabled={server.baseline.enabled}
              savedOrigins={server.baseline.allowedOrigins}
            />

            {/* ----------------------------------------------- security */}
            <section className={styles.card} hidden={!showDelivery}>
              <header className={styles.cardHead}>
                <h3>Domains allowed to use it</h3>
              </header>
              <p className={styles.securityLead}>
                This is the boundary. The widget answers a question only when
                the browser says the page asking sits on one of these domains.
                A copy of your snippet pasted onto any other site gets nothing
                back — not a shorter answer, not a generic one; the request is
                refused before it reaches your learning.
              </p>
              <OriginList
                disabled={saving}
                onAdd={addOrigin}
                onRemove={removeOrigin}
                origins={draft.allowedOrigins}
              />
              <Toggle
                bordered
                checked={draft.anonymousAccess}
                description={
                  draft.anonymousAccess
                    ? "Anyone on an allowed domain can ask, without signing in. Their questions are counted, but nothing is attributed to a person."
                    : "Only a visitor your site has identified to the widget can ask. Everyone else sees the widget and gets no answer."
                }
                label="Let signed-out visitors ask"
                onChange={(next) => update("anonymousAccess", next)}
              />
            </section>

            {/* ------------------------------------------------ install */}
            <section className={styles.card} hidden={!showDelivery}>
              <header className={styles.cardHead}>
                <h3>Install</h3>
              </header>
              {publicKey === null ? (
                <EmptyState
                  compact
                  description="No public widget key has been issued for this workspace yet, so there is no snippet to copy. Turn the widget on and save — the key is issued by the server and read back from it. Nothing here is generated in your browser."
                  headline="No key yet"
                  tone="restricted"
                />
              ) : (
                <>
                  <div className={styles.keyBlock}>
                    <div>
                      <span className={styles.keyLabel}>Public widget key</span>
                      <code className={styles.keyValue}>{publicKey}</code>
                    </div>
                    <p className={styles.keyNote}>
                      This key is meant to be public: it sits in the page source
                      of every site you install the widget on, and it is safe
                      there. It identifies the workspace — it does not grant
                      access. What actually protects you is the domain list
                      above, so treat that list, not this key, as the control.
                    </p>
                  </div>

                  <Snippet
                    code={htmlSnippet}
                    description="Paste this just before the closing </body> tag on any site you control."
                    label="Any website"
                  />

                  <Snippet
                    code={circleSnippet}
                    description="Circle wraps the JavaScript field for you, so paste this raw — no <script> tag — under Site → Code snippets → JavaScript. Circle's native mobile apps do not run custom snippets; add a normal navigation link as the mobile fallback."
                    label="Circle community"
                  />

                  <p className={styles.hint}>
                    Whichever you use, the domain has to be in the list above
                    first. Installing the snippet on a domain that is not listed
                    produces a widget that loads and answers nothing.
                  </p>
                </>
              )}
            </section>
          </div>

          {/* ------------------------------------------------- preview */}
          <div className={styles.column}>
            <section className={styles.card}>
              <header className={styles.cardHead}>
                <h3>Live preview</h3>
                {dirty ? <StateBadge state="partial">Unsaved</StateBadge> : null}
              </header>
              <WidgetPreview
                branding={previewBranding}
                disabled={!server.baseline.enabled}
                presentation={draftPresentation(draft)}
                tenantKey={publicKey ?? "preview"}
              />
              {draftPresentation(draft) !== savedPresentation ? (
                <p className={styles.meta}>
                  The preview shows the unsaved setting. Your site still opens
                  the widget as “
                  {FORM_OPTIONS.find((option) => option.value === savedPresentation)
                    ?.label ?? savedPresentation}
                  ” until you save.
                </p>
              ) : null}
            </section>
          </div>
        </div>
      </PanelFrame>
    </div>
  );
}

export default WidgetPanel;
