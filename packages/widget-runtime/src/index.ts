export type WidgetPresentation = "launcher" | "panel" | "expanded" | "mobile-sheet";
export type DesktopPresentation = Exclude<WidgetPresentation, "mobile-sheet">;
export type WidgetModality = "text" | "voice";
export type IdentityTier = "anonymous" | "self_reported" | "verified";
export type VoiceState = "idle" | "permission" | "connecting" | "listening" | "thinking" | "speaking";

export interface WidgetBranding {
  assistantName: string;
  logoUrl?: string;
  avatarUrl?: string;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  fontFamily: "system" | "rounded" | "serif";
  welcomeCopy: string;
  launcherLabel: string;
  launcherPosition: "bottom-left" | "bottom-right";
  launcherShape: "bubble" | "pill" | "tab";
  greetingBubbleEnabled: boolean;
  greetingBubbleDelaySeconds: number;
  showPoweredBy: boolean;
  appearanceMode: "auto" | "light" | "dark";
  voiceEnabled: boolean;
  privacyUrl?: string;
  termsUrl?: string;
  supportUrl?: string;
  /** Copy for the "assistant paused" banner. Absent/empty means not away. */
  awayMessage?: string;
  /** Chips offered on the empty (first-open) thread. Empty array renders none. */
  starterPrompts: string[];
}

export interface WidgetIdentity {
  tier: IdentityTier;
  displayName?: string;
}

export interface WidgetIdentityCapabilities {
  verified: boolean;
  aggregateOnly: boolean;
  learnerInsights: boolean;
  crossDeviceMemory: boolean;
}

export interface ResolvedLearningContext {
  status: "resolved" | "ambiguous" | "stale" | "unknown";
  confidence?: number;
  source?: "verified_host" | "url_mapping" | "progress_resume";
  course?: string;
  module?: string;
  lesson?: string;
  updatedAt?: string;
}

export interface AttachmentPart {
  kind: "attachment";
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  status: "uploading" | "scanning" | "extracting" | "ready" | "failed" | "quarantined";
  error?: string;
}

export interface TextPart {
  kind: "text";
  text: string;
}

export interface SourcePart {
  kind: "source";
  id: string;
  title: string;
  url: string;
}

export interface DiagramPart {
  kind: "diagram";
  id: string;
  caption: string;
  url: string;
  rasterFallbackUrl?: string;
  approved: boolean;
}

export interface VideoPart {
  kind: "video";
  id: string;
  title: string;
  url: string;
  posterUrl?: string;
  durationLabel?: string;
}

export interface ListPart {
  kind: "list";
  heading?: string;
  items: string[];
}

export interface QuotePart {
  kind: "quote";
  text: string;
  attribution?: string;
}

export interface ChartBar {
  label: string;
  value: number;
}

export interface ChartPart {
  kind: "chart";
  id: string;
  heading: string;
  sourceLabel?: string;
  bars: ChartBar[];
  footnote?: string;
}

export interface CodePart {
  kind: "code";
  label?: string;
  code: string;
  language?: string;
}

export interface ProgressPart {
  kind: "progress";
  id: string;
  moduleLabel: string;
  statusLabel: string;
  completedSteps: number;
  totalSteps: number;
  nextLabel?: string;
}

export interface FollowupsPart {
  kind: "followups";
  suggestions: string[];
}

export type WidgetPart =
  | TextPart
  | AttachmentPart
  | SourcePart
  | DiagramPart
  | VideoPart
  | ListPart
  | QuotePart
  | ChartPart
  | CodePart
  | ProgressPart
  | FollowupsPart;

export interface WidgetThreadItem {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "system";
  modality: WidgetModality;
  status: "pending" | "streaming" | "complete" | "interrupted" | "failed";
  parts: WidgetPart[];
  createdAt: string;
}

export interface WidgetConversation {
  id: string;
  items: WidgetThreadItem[];
}

export interface WidgetPageContext {
  href: string;
  title: string;
}

export interface WidgetBootstrap {
  conversation: WidgetConversation;
  branding?: Partial<WidgetBranding>;
  identity?: WidgetIdentity;
  learningContext?: ResolvedLearningContext;
}

export type WidgetRuntimeEvent =
  | { type: "response.delta"; conversationId: string; itemId: string; text: string }
  | { type: "response.complete"; conversationId: string; itemId: string }
  | { type: "response.interrupted"; conversationId: string; itemId: string }
  | { type: "transcript.partial"; conversationId: string; text: string }
  | { type: "transcript.final"; conversationId: string; itemId: string; text: string }
  | { type: "voice.state"; conversationId: string; state: VoiceState }
  | { type: "thread.item"; conversationId: string; item: WidgetThreadItem }
  | { type: "attachment.updated"; conversationId: string; attachment: AttachmentPart }
  | { type: "learning.context"; conversationId: string; context: ResolvedLearningContext }
  | { type: "connection"; conversationId: string; status: "online" | "reconnecting" | "offline" }
  | { type: "error"; conversationId: string; code: string; recoverable: boolean };

export interface WidgetVoiceControl {
  stop(reason: "user" | "fallback" | "unmount"): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  startPushToTalk?(): Promise<void>;
  stopPushToTalk?(): Promise<void>;
  interrupt?(): Promise<void>;
}

export interface WidgetRuntimeAdapter {
  bootstrap(input: {
    tenantKey: string;
    conversationId?: string;
    page: WidgetPageContext;
    signal: AbortSignal;
  }): Promise<WidgetBootstrap>;
  sendText(
    input: {
      conversationId: string;
      text: string;
      page: WidgetPageContext;
      attachmentIds: string[];
      signal: AbortSignal;
    },
    emit: (event: WidgetRuntimeEvent) => void,
  ): Promise<void>;
  uploadFiles?(
    input: {
      conversationId: string;
      files: readonly File[];
      signal: AbortSignal;
    },
    emit: (event: WidgetRuntimeEvent) => void,
  ): Promise<void>;
  startVoice?(
    input: {
      conversationId: string;
      mode: "push-to-talk" | "tap-to-start";
      signal: AbortSignal;
    },
    emit: (event: WidgetRuntimeEvent) => void,
  ): Promise<WidgetVoiceControl>;
  stopGeneration?(input: { conversationId: string; itemId?: string }): Promise<void>;
  reportHealth?(event: { code: string; tenantKey?: string }): void;
}

export interface WidgetRuntimeConfiguration {
  tenantKey: string;
  adapter: WidgetRuntimeAdapter;
  branding?: Partial<WidgetBranding>;
  identity?: WidgetIdentity;
  learningContext?: ResolvedLearningContext;
  storage?: Storage;
}

export interface WidgetLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetSnapshot {
  presentation: WidgetPresentation;
  desktopPresentation: DesktopPresentation;
  modality: WidgetModality;
  voiceState: VoiceState;
  identity: WidgetIdentity;
  identityCapabilities: WidgetIdentityCapabilities;
  learningContext: ResolvedLearningContext;
  branding: WidgetBranding;
  conversation: WidgetConversation;
  draft: string;
  liveCaption: string;
  connection: "online" | "reconnecting" | "offline";
  layout: WidgetLayout;
  unread: number;
}

const FALLBACK_BRANDING: WidgetBranding = {
  assistantName: "Learning assistant",
  primaryColor: "#176b5b",
  accentColor: "#d9f2ea",
  surfaceColor: "#ffffff",
  textColor: "#18211f",
  fontFamily: "system",
  welcomeCopy: "What would you like help with?",
  launcherLabel: "Open learning assistant",
  launcherPosition: "bottom-right",
  launcherShape: "bubble",
  greetingBubbleEnabled: true,
  greetingBubbleDelaySeconds: 20,
  showPoweredBy: true,
  appearanceMode: "auto",
  voiceEnabled: false,
  starterPrompts: [],
};

const DEFAULT_LAYOUT: WidgetLayout = { x: 0, y: 0, width: 400, height: 620 };
const MIN_WIDTH = 320;
const MIN_HEIGHT = 420;
const VIEWPORT_GUTTER = 12;
const MOBILE_BREAKPOINT = 768;
const STORAGE_PREFIX = "course-ai-widget:v1";

const HTMLElementBase: typeof HTMLElement =
  globalThis.HTMLElement ??
  (class extends EventTarget {
    style = { display: "" } as CSSStyleDeclaration;
    dataset: DOMStringMap = {};
    isConnected = false;
    attachShadow(): ShadowRoot {
      throw new Error("shadow_dom_unavailable");
    }
    getAttribute(): string | null {
      return null;
    }
  } as unknown as typeof HTMLElement);

function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

function now(): string {
  return new Date().toISOString();
}

function pageContext(): WidgetPageContext {
  return {
    href: globalThis.location?.href ?? "",
    title: globalThis.document?.title ?? "",
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function viewport(): { width: number; height: number } {
  return {
    width: Math.max(globalThis.innerWidth || 1024, MIN_WIDTH),
    height: Math.max(globalThis.innerHeight || 768, MIN_HEIGHT),
  };
}

function isMobileViewport(): boolean {
  return viewport().width < MOBILE_BREAKPOINT;
}

function safeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i.test(trimmed) ? trimmed : fallback;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, globalThis.location?.href ?? "https://invalid.local");
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost")
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function validatedIdentity(identity: WidgetIdentity | undefined): WidgetIdentity {
  if (identity?.tier === "verified" || identity?.tier === "self_reported") {
    return {
      tier: identity.tier,
      ...(identity.displayName?.trim() ? { displayName: identity.displayName.trim() } : {}),
    };
  }
  return { tier: "anonymous" };
}

function identityCapabilities(tier: IdentityTier): WidgetIdentityCapabilities {
  if (tier === "anonymous") {
    return { verified: false, aggregateOnly: true, learnerInsights: false, crossDeviceMemory: false };
  }
  return {
    verified: tier === "verified",
    aggregateOnly: false,
    learnerInsights: true,
    crossDeviceMemory: true,
  };
}

function mergeBranding(base: WidgetBranding, update?: Partial<WidgetBranding>): WidgetBranding {
  if (!update) return { ...base };
  const logoUrl = safeUrl(update.logoUrl) ?? base.logoUrl;
  const avatarUrl = safeUrl(update.avatarUrl) ?? base.avatarUrl;
  const privacyUrl = safeUrl(update.privacyUrl) ?? base.privacyUrl;
  const termsUrl = safeUrl(update.termsUrl) ?? base.termsUrl;
  const supportUrl = safeUrl(update.supportUrl) ?? base.supportUrl;
  const awayMessage = update.awayMessage?.trim() || base.awayMessage;
  return {
    assistantName: update.assistantName?.trim() || base.assistantName,
    primaryColor: safeColor(update.primaryColor, base.primaryColor),
    accentColor: safeColor(update.accentColor, base.accentColor),
    surfaceColor: safeColor(update.surfaceColor, base.surfaceColor),
    textColor: safeColor(update.textColor, base.textColor),
    fontFamily:
      update.fontFamily === "system" || update.fontFamily === "rounded" || update.fontFamily === "serif"
        ? update.fontFamily
        : base.fontFamily,
    welcomeCopy: update.welcomeCopy?.trim() || base.welcomeCopy,
    launcherLabel: update.launcherLabel?.trim() || base.launcherLabel,
    launcherPosition:
      update.launcherPosition === "bottom-left" || update.launcherPosition === "bottom-right"
        ? update.launcherPosition
        : base.launcherPosition,
    launcherShape:
      update.launcherShape === "bubble" ||
      update.launcherShape === "pill" ||
      update.launcherShape === "tab"
        ? update.launcherShape
        : base.launcherShape,
    greetingBubbleEnabled:
      typeof update.greetingBubbleEnabled === "boolean"
        ? update.greetingBubbleEnabled
        : base.greetingBubbleEnabled,
    greetingBubbleDelaySeconds:
      typeof update.greetingBubbleDelaySeconds === "number" &&
      Number.isInteger(update.greetingBubbleDelaySeconds) &&
      update.greetingBubbleDelaySeconds >= 0 &&
      update.greetingBubbleDelaySeconds <= 120
        ? update.greetingBubbleDelaySeconds
        : base.greetingBubbleDelaySeconds,
    showPoweredBy:
      typeof update.showPoweredBy === "boolean"
        ? update.showPoweredBy
        : base.showPoweredBy,
    appearanceMode:
      update.appearanceMode === "auto" ||
      update.appearanceMode === "light" ||
      update.appearanceMode === "dark"
        ? update.appearanceMode
        : base.appearanceMode,
    voiceEnabled: typeof update.voiceEnabled === "boolean" ? update.voiceEnabled : base.voiceEnabled,
    starterPrompts: Array.isArray(update.starterPrompts)
      ? update.starterPrompts
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
          .slice(0, 6)
      : base.starterPrompts,
    ...(logoUrl ? { logoUrl } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(privacyUrl ? { privacyUrl } : {}),
    ...(termsUrl ? { termsUrl } : {}),
    ...(supportUrl ? { supportUrl } : {}),
    ...(awayMessage ? { awayMessage } : {}),
  };
}

function emptyConversation(id = makeId("conversation")): WidgetConversation {
  return { id, items: [] };
}

function cloneConversation(conversation: WidgetConversation): WidgetConversation {
  return {
    id: conversation.id,
    items: conversation.items.map((item) => ({
      ...item,
      parts: item.parts.map((part) => ({ ...part })),
    })),
  };
}

function storageRead(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageWrite(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage denial must not affect the host or active conversation.
  }
}

function createButton(label: string, className: string, text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

/**
 * Every markup string passed here is a compile-time constant authored in
 * this file — never server or user data. `innerHTML` is safe for that case;
 * it is never used for anything that reaches this widget from a host page
 * or an adapter response (see `appendFormattedText` for that path).
 */
function iconSpan(className: string, markup: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = markup;
  return span;
}

const CHAT_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M19.4 6.4A9 9 0 1 0 21 12"/><circle cx="12" cy="12" r="3.3" fill="#fff" stroke="none"/></svg>`;
const SEND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>`;
const EXPAND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M15 20h5v-5"/></svg>`;
const RESTORE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`;
const CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;
const PLAY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const PROGRESS_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.6A1.6 1.6 0 0 1 5.6 4H11v15.4H5.6A1.6 1.6 0 0 1 4 17.8z"/><path d="M20 5.6A1.6 1.6 0 0 0 18.4 4H13v15.4h5.4A1.6 1.6 0 0 0 20 17.8z"/></svg>`;

/**
 * Restricted inline syntax for assistant/user text: only `**bold**` is
 * recognized. This walks the raw string and appends real text and
 * `<strong>` nodes — never `innerHTML` — so a hostile response can at most
 * make its own words bold, never inject markup.
 */
function appendFormattedText(target: HTMLElement, text: string): void {
  if (!text.includes("**")) {
    target.textContent = text;
    return;
  }
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) target.append(plainSpan(text.slice(cursor, match.index)));
    const strong = document.createElement("strong");
    strong.textContent = match[1] ?? "";
    target.append(strong);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) target.append(plainSpan(text.slice(cursor)));
}

/** A plain inline wrapper for a text run — never a raw text node, so every
 * child a renderer produces is a real element with its own `.textContent`. */
function plainSpan(value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

export class CourseAiWidgetElement extends HTMLElementBase {
  static readonly observedAttributes = ["tenant-key"];

  #root?: ShadowRoot;
  #config?: WidgetRuntimeConfiguration;
  #storage: Storage | undefined;
  #abort?: AbortController;
  #voiceControl: WidgetVoiceControl | undefined;
  #generationAbort: AbortController | undefined;
  #greetingTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #greetingBubbleVisible = false;
  #greetingBubbleShown = false;
  #colorScheme: MediaQueryList | undefined;
  #configurationVersion = 0;
  #failure = false;
  #connected = false;
  #initialized = false;
  #drag: { kind: "move" | "resize"; startX: number; startY: number; layout: WidgetLayout } | undefined;
  #refs?: {
    launcher: HTMLButtonElement;
    launcherIcon: HTMLElement;
    launcherCount: HTMLElement;
    launcherLabel: HTMLElement;
    greetingBubble: HTMLButtonElement;
    surface: HTMLElement;
    header: HTMLElement;
    avatar: HTMLElement;
    name: HTMLElement;
    identity: HTMLElement;
    context: HTMLElement;
    away: HTMLElement;
    awayBody: HTMLElement;
    thread: HTMLElement;
    empty: HTMLElement;
    emptyText: HTMLElement;
    emptyChips: HTMLElement;
    live: HTMLElement;
    composer: HTMLTextAreaElement;
    send: HTMLButtonElement;
    voice: HTMLButtonElement;
    attach: HTMLButtonElement;
    fileInput: HTMLInputElement;
    expand: HTMLButtonElement;
    expandIcon: HTMLElement;
    restoreIcon: HTMLElement;
    close: HTMLButtonElement;
    stop: HTMLButtonElement;
    resize: HTMLElement;
    status: HTMLElement;
    poweredBy: HTMLElement;
    trust: HTMLElement;
    trustLink: HTMLAnchorElement;
  };

  #state: WidgetSnapshot = {
    presentation: "launcher",
    desktopPresentation: "launcher",
    modality: "text",
    voiceState: "idle",
    identity: { tier: "anonymous" },
    identityCapabilities: identityCapabilities("anonymous"),
    learningContext: { status: "unknown" },
    branding: { ...FALLBACK_BRANDING },
    conversation: emptyConversation(),
    draft: "",
    liveCaption: "",
    connection: "online",
    layout: { ...DEFAULT_LAYOUT },
    unread: 0,
  };

  constructor() {
    super();
    try {
      this.#root = this.attachShadow({ mode: "open" });
    } catch {
      this.#failure = true;
      this.style.display = "none";
    }
  }

  connectedCallback(): void {
    this.#connected = true;
    this.#guard("connected", () => {
      if (!this.#root) throw new Error("shadow_dom_unavailable");
      if (!this.#initialized) {
        this.#build();
        this.#initialized = true;
      }
      globalThis.addEventListener?.("resize", this.#onViewportChange);
      this.#colorScheme = globalThis.matchMedia?.(
        "(prefers-color-scheme: dark)",
      );
      this.#colorScheme?.addEventListener?.(
        "change",
        this.#onColorSchemeChange,
      );
      this.#updatePresentationForViewport();
      this.#render();
    });
  }

  disconnectedCallback(): void {
    this.#connected = false;
    globalThis.removeEventListener?.("resize", this.#onViewportChange);
    this.#colorScheme?.removeEventListener?.(
      "change",
      this.#onColorSchemeChange,
    );
    this.#colorScheme = undefined;
    this.#clearGreetingTimer();
    this.#abort?.abort();
    this.#generationAbort?.abort();
    void this.#voiceControl?.stop("unmount").catch(() => undefined);
    this.#voiceControl = undefined;
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "tenant-key" && newValue && this.#config && this.#config.tenantKey !== newValue) {
      void this.configure({ ...this.#config, tenantKey: newValue });
    }
  }

  async configure(configuration: WidgetRuntimeConfiguration): Promise<void> {
    await this.#guardAsync("configuration", async () => {
      if (!configuration.tenantKey.trim() || !configuration.adapter) {
        throw new Error("invalid_configuration");
      }
      const configurationVersion = ++this.#configurationVersion;
      this.#abort?.abort();
      this.#generationAbort?.abort();
      await this.#voiceControl?.stop("unmount").catch(() => undefined);
      this.#voiceControl = undefined;
      this.#clearGreetingTimer();
      this.#greetingBubbleVisible = false;
      this.#greetingBubbleShown = false;
      this.#abort = new AbortController();
      this.#config = configuration;
      this.#storage = configuration.storage ?? this.#defaultStorage();
      this.#state = {
        presentation: "launcher",
        desktopPresentation: "launcher",
        modality: "text",
        voiceState: "idle",
        identity: validatedIdentity(configuration.identity),
        identityCapabilities: identityCapabilities(validatedIdentity(configuration.identity).tier),
        learningContext: configuration.learningContext ?? { status: "unknown" },
        branding: mergeBranding(FALLBACK_BRANDING, configuration.branding),
        conversation: emptyConversation(),
        draft: "",
        liveCaption: "",
        connection: "online",
        layout: { ...DEFAULT_LAYOUT },
        unread: 0,
      };
      this.#loadPersistedState();
      this.#render();

      const resumeConversationId = this.#resumeConversationId();
      let bootstrap: WidgetBootstrap;
      try {
        bootstrap = await configuration.adapter.bootstrap({
          tenantKey: configuration.tenantKey,
          ...(resumeConversationId ? { conversationId: resumeConversationId } : {}),
          page: pageContext(),
          signal: this.#abort.signal,
        });
      } catch (error) {
        if (configurationVersion !== this.#configurationVersion) return;
        throw error;
      }
      if (configurationVersion !== this.#configurationVersion || this.#abort.signal.aborted) return;
      if (!bootstrap.conversation.id) throw new Error("invalid_conversation");
      this.#state.conversation = cloneConversation(bootstrap.conversation);
      this.#state.branding = mergeBranding(this.#state.branding, bootstrap.branding);
      this.#state.identity = validatedIdentity(bootstrap.identity ?? this.#state.identity);
      this.#state.identityCapabilities = identityCapabilities(this.#state.identity.tier);
      this.#state.learningContext = bootstrap.learningContext ?? this.#state.learningContext;
      this.#persistResumeState();
      this.#failure = false;
      this.style.display = "";
      this.#render();
      this.#scheduleGreetingBubble();
      this.#dispatch("ready", { conversationId: this.#state.conversation.id });
    });
  }

  open(): void {
    this.#guard("open", () => {
      this.#clearGreetingTimer();
      this.#greetingBubbleVisible = false;
      this.#greetingBubbleShown = true;
      this.#setDesktopPresentation("panel");
      this.#state.unread = 0;
      this.#render();
      queueMicrotask(() => this.#refs?.composer.focus());
    });
  }

  close(): void {
    this.#guard("close", () => {
      if (this.#state.modality === "voice") void this.endVoice("user");
      this.#setDesktopPresentation("launcher");
      this.#render();
      queueMicrotask(() => this.#refs?.launcher.focus());
    });
  }

  expand(): void {
    this.#guard("expand", () => {
      this.#setDesktopPresentation("expanded");
      this.#render();
    });
  }

  restore(): void {
    this.#guard("restore", () => {
      this.#setDesktopPresentation("panel");
      this.#render();
    });
  }

  setModality(modality: WidgetModality): void {
    this.#guard("modality", () => {
      this.#state.modality = modality;
      if (modality === "text") {
        this.#state.liveCaption = "";
        this.#state.voiceState = "idle";
      }
      this.#persistResumeState();
      this.#render();
    });
  }

  moveBy(deltaX: number, deltaY: number): void {
    this.#guard("move", () => {
      if (isMobileViewport() || this.#state.desktopPresentation !== "panel") return;
      this.#state.layout.x += deltaX;
      this.#state.layout.y += deltaY;
      this.#clampLayout();
      this.#persistLayout();
      this.#renderLayout();
    });
  }

  resizeBy(deltaWidth: number, deltaHeight: number): void {
    this.#guard("resize", () => {
      if (isMobileViewport() || this.#state.desktopPresentation !== "panel") return;
      this.#state.layout.width += deltaWidth;
      this.#state.layout.height += deltaHeight;
      this.#clampLayout();
      this.#persistLayout();
      this.#renderLayout();
    });
  }

  updateBranding(branding: Partial<WidgetBranding>): void {
    this.#guard("branding", () => {
      this.#state.branding = mergeBranding(this.#state.branding, branding);
      this.#render();
      this.#scheduleGreetingBubble();
    });
  }

  updateLearningContext(context: ResolvedLearningContext): void {
    this.#guard("context", () => {
      this.#state.learningContext = context;
      this.#render();
    });
  }

  setDraft(draft: string): void {
    this.#guard("draft", () => {
      this.#state.draft = draft;
      this.#persistResumeState();
      if (this.#refs && this.#refs.composer.value !== draft) this.#refs.composer.value = draft;
    });
  }

  getSnapshot(): WidgetSnapshot {
    return {
      ...this.#state,
      branding: { ...this.#state.branding },
      identity: { ...this.#state.identity },
      identityCapabilities: { ...this.#state.identityCapabilities },
      learningContext: { ...this.#state.learningContext },
      conversation: cloneConversation(this.#state.conversation),
      layout: { ...this.#state.layout },
    };
  }

  receive(event: WidgetRuntimeEvent): void {
    this.#guard("event", () => this.#receiveEvent(event));
  }

  async send(text = this.#state.draft): Promise<void> {
    await this.#guardAsync("send", async () => {
      const cleanText = text.trim();
      if (!cleanText || !this.#config) return;
      const conversationId = this.#state.conversation.id;
      const userItem: WidgetThreadItem = {
        id: makeId("message"),
        sequence: this.#nextSequence(),
        role: "user",
        modality: this.#state.modality,
        status: "complete",
        parts: [{ kind: "text", text: cleanText }],
        createdAt: now(),
      };
      this.#state.conversation.items.push(userItem);
      const attachmentIds = this.#state.conversation.items.flatMap((item) =>
        item.parts
          .filter((part): part is AttachmentPart => part.kind === "attachment" && part.status === "ready")
          .map((part) => part.id),
      );
      this.#state.draft = "";
      this.#generationAbort?.abort();
      this.#generationAbort = new AbortController();
      const configurationVersion = this.#configurationVersion;
      this.#persistResumeState();
      this.#render();
      try {
        await this.#config.adapter.sendText(
          {
            conversationId,
            text: cleanText,
            page: pageContext(),
            attachmentIds,
            signal: this.#generationAbort.signal,
          },
          (event) => {
            if (configurationVersion === this.#configurationVersion) this.receive(event);
          },
        );
      } catch (error) {
        if (configurationVersion !== this.#configurationVersion) return;
        userItem.status = "failed";
        this.#state.draft = cleanText;
        this.#persistResumeState();
        this.#render();
        throw error;
      }
    }, false);
  }

  async retryLastFailed(): Promise<void> {
    let failed: WidgetThreadItem | undefined;
    for (let index = this.#state.conversation.items.length - 1; index >= 0; index -= 1) {
      const candidate = this.#state.conversation.items[index];
      if (candidate?.role === "user" && candidate.status === "failed") {
        failed = candidate;
        break;
      }
    }
    const text = failed?.parts.find((part): part is TextPart => part.kind === "text")?.text;
    if (!failed || !text) return;
    this.#state.conversation.items = this.#state.conversation.items.filter((item) => item.id !== failed.id);
    await this.send(text);
  }

  async startVoice(mode: "push-to-talk" | "tap-to-start" = "tap-to-start"): Promise<void> {
    await this.#guardAsync("voice_start", async () => {
      if (!this.#config?.adapter.startVoice || !this.#state.branding.voiceEnabled) return;
      this.#state.modality = "voice";
      this.#state.voiceState = "permission";
      this.#render();
      const configurationVersion = this.#configurationVersion;
      try {
        this.#voiceControl = await this.#config.adapter.startVoice(
          {
            conversationId: this.#state.conversation.id,
            mode,
            signal: this.#abort?.signal ?? new AbortController().signal,
          },
          (event) => {
            if (configurationVersion === this.#configurationVersion) this.receive(event);
          },
        );
      } catch (error) {
        if (configurationVersion !== this.#configurationVersion) return;
        throw error;
      }
      this.#persistResumeState();
    }, false);
  }

  async endVoice(reason: "user" | "fallback" | "unmount" = "user"): Promise<void> {
    await this.#guardAsync("voice_end", async () => {
      try {
        await this.#voiceControl?.stop(reason);
      } finally {
        this.#voiceControl = undefined;
        this.#state.modality = "text";
        this.#state.voiceState = "idle";
        this.#state.liveCaption = "";
        this.#persistResumeState();
        this.#render();
      }
    }, false);
  }

  #build(): void {
    if (!this.#root) return;
    const style = document.createElement("style");
    style.textContent = STYLES;

    const launcher = createButton("Open learning assistant", "launcher", "");
    const launcherIcon = iconSpan("launcherIcon", CHAT_ICON);
    const launcherCount = document.createElement("span");
    launcherCount.className = "launcherCount";
    const launcherLabel = document.createElement("span");
    launcherLabel.className = "launcherLabel";
    launcher.append(launcherIcon, launcherCount, launcherLabel);
    const greetingBubble = createButton(
      "Open learning assistant",
      "greetingBubble",
      "",
    );
    const surface = document.createElement("section");
    surface.className = "surface";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-modal", "false");
    surface.setAttribute("aria-label", "Learning assistant");

    const header = document.createElement("header");
    header.className = "header";
    header.tabIndex = 0;
    header.setAttribute("aria-label", "Move assistant. Use arrow keys to reposition.");
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    const heading = document.createElement("span");
    heading.className = "heading";
    const name = document.createElement("strong");
    const identity = document.createElement("span");
    identity.className = "identity";
    heading.append(name, identity);
    const actions = document.createElement("span");
    actions.className = "actions";
    const expand = createButton("Expand assistant", "icon headerIcon", "");
    const expandIcon = iconSpan("headerIconGlyph", EXPAND_ICON);
    const restoreIcon = iconSpan("headerIconGlyph", RESTORE_ICON);
    expand.append(expandIcon, restoreIcon);
    const close = createButton("Close assistant", "icon headerIcon", "");
    close.append(iconSpan("headerIconGlyph", CLOSE_ICON));
    actions.append(expand, close);
    header.append(avatar, heading, actions);

    const context = document.createElement("div");
    context.className = "context";
    context.setAttribute("aria-live", "polite");
    const away = document.createElement("div");
    away.className = "away";
    const awayHeading = document.createElement("div");
    awayHeading.className = "awayHeading";
    awayHeading.textContent = "Away right now";
    const awayBody = document.createElement("p");
    awayBody.className = "awayBody";
    away.append(awayHeading, awayBody);
    const thread = document.createElement("main");
    thread.className = "thread";
    thread.setAttribute("aria-label", "Conversation");
    const empty = document.createElement("div");
    empty.className = "empty";
    const emptyText = document.createElement("p");
    emptyText.className = "emptyText";
    const emptyChips = document.createElement("div");
    emptyChips.className = "emptyChips";
    empty.append(emptyText, emptyChips);
    const live = document.createElement("div");
    live.className = "live";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");

    const footer = document.createElement("footer");
    footer.className = "footer";
    const composer = document.createElement("textarea");
    composer.rows = 2;
    composer.placeholder = "Ask about what you’re learning…";
    composer.setAttribute("aria-label", "Message");
    const controls = document.createElement("div");
    controls.className = "controls";
    const attach = createButton("Attach files", "icon attach", "＋");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.hidden = true;
    const voice = createButton("Start voice mode", "icon voice", "Voice");
    const stop = createButton("Stop response", "icon stop", "■");
    const send = createButton("Send message", "send", "");
    send.append(iconSpan("sendIcon", SEND_ICON));
    controls.append(attach, fileInput, voice, stop, send);
    footer.append(composer, controls);

    const trust = document.createElement("div");
    trust.className = "trust";
    const trustText = document.createElement("span");
    trustText.textContent = "Answers come only from this course · ";
    const trustLink = document.createElement("a");
    trustLink.className = "trustLink";
    trustLink.textContent = "How your questions are used";
    trustLink.target = "_blank";
    trustLink.rel = "noopener noreferrer";
    trust.append(trustText, trustLink);

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const poweredBy = document.createElement("div");
    poweredBy.className = "poweredBy";
    poweredBy.textContent = "Powered by Corso";
    const resize = document.createElement("div");
    resize.className = "resize";
    resize.tabIndex = 0;
    resize.setAttribute("role", "separator");
    resize.setAttribute("aria-label", "Resize assistant. Use arrow keys.");
    surface.append(
      header,
      context,
      away,
      thread,
      empty,
      live,
      footer,
      trust,
      poweredBy,
      status,
      resize,
    );
    this.#root.replaceChildren(style, launcher, surface, greetingBubble);
    this.#refs = {
      launcher, launcherIcon, launcherCount, launcherLabel, greetingBubble,
      surface, header, avatar, name, identity, context, away, awayBody,
      thread, empty, emptyText, emptyChips, live, composer, send, voice,
      attach, fileInput, expand, expandIcon, restoreIcon, close, stop,
      resize, status, poweredBy, trust, trustLink,
    };

    launcher.addEventListener("click", () => this.open());
    greetingBubble.addEventListener("click", () => this.open());
    close.addEventListener("click", () => this.close());
    expand.addEventListener("click", () =>
      this.#state.desktopPresentation === "expanded" ? this.restore() : this.expand(),
    );
    send.addEventListener("click", () => void this.send());
    stop.addEventListener("click", () => void this.#stopGeneration());
    voice.addEventListener("click", () =>
      this.#state.modality === "voice" ? void this.endVoice() : void this.startVoice(),
    );
    attach.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => void this.#uploadFiles(fileInput.files));
    composer.addEventListener("input", () => this.setDraft(composer.value));
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });
    surface.addEventListener("keydown", this.#onSurfaceKeyDown);
    header.addEventListener("keydown", this.#onMoveKeyDown);
    resize.addEventListener("keydown", this.#onResizeKeyDown);
    header.addEventListener("pointerdown", (event) => this.#beginPointerDrag("move", event));
    resize.addEventListener("pointerdown", (event) => this.#beginPointerDrag("resize", event));
    surface.addEventListener("pointermove", this.#onPointerMove);
    surface.addEventListener("pointerup", this.#endPointerDrag);
    surface.addEventListener("pointercancel", this.#endPointerDrag);
    surface.addEventListener("dragover", (event) => event.preventDefault());
    surface.addEventListener("drop", (event) => {
      event.preventDefault();
      void this.#uploadFiles(event.dataTransfer?.files);
    });
    composer.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files;
      if (files?.length) void this.#uploadFiles(files);
    });
  }

  #render(): void {
    if (!this.#refs || this.#failure) return;
    const { branding } = this.#state;
    const dark =
      branding.appearanceMode === "dark" ||
      (branding.appearanceMode === "auto" &&
        (this.#colorScheme?.matches ?? false));
    this.#setCssVariable("--widget-primary", branding.primaryColor);
    this.#setCssVariable("--widget-accent", branding.accentColor);
    this.#setCssVariable(
      "--widget-surface",
      dark ? "#171b1a" : branding.surfaceColor,
    );
    this.#setCssVariable(
      "--widget-text",
      dark ? "#f4f7f6" : branding.textColor,
    );
    this.#setCssVariable("--widget-font", this.#fontValue(branding.fontFamily));
    this.style.setProperty("color-scheme", dark ? "dark" : "light");
    this.dataset.appearance = dark ? "dark" : "light";
    this.#refs.launcher.setAttribute("aria-label", `${branding.launcherLabel}${this.#state.unread ? `, ${this.#state.unread} unread` : ""}`);
    this.#refs.launcher.dataset.unread = String(this.#state.unread > 0);
    this.#refs.launcher.dataset.shape = branding.launcherShape;
    const launcherText = this.#state.unread
      ? String(Math.min(this.#state.unread, 9))
      : branding.launcherShape === "bubble"
        ? ""
        : branding.launcherLabel;
    if (branding.launcherShape === "bubble") {
      this.#refs.launcherIcon.hidden = launcherText !== "";
      this.#refs.launcherCount.textContent = launcherText;
      this.#refs.launcherLabel.textContent = "";
    } else {
      this.#refs.launcherIcon.hidden = true;
      this.#refs.launcherCount.textContent = "";
      this.#refs.launcherLabel.textContent = launcherText;
    }
    this.#refs.greetingBubble.textContent = branding.welcomeCopy;
    this.#refs.greetingBubble.setAttribute(
      "aria-label",
      `${branding.welcomeCopy} Open ${branding.assistantName}.`,
    );
    this.#refs.greetingBubble.hidden =
      this.#state.presentation !== "launcher" ||
      !this.#greetingBubbleVisible;
    this.#refs.poweredBy.hidden = !branding.showPoweredBy;
    this.#refs.name.textContent = branding.assistantName;
    this.#refs.identity.textContent = this.#identityLabel();
    this.#refs.context.textContent = this.#contextLabel();
    this.#refs.context.hidden = !this.#refs.context.textContent;
    this.#refs.awayBody.textContent = branding.awayMessage ?? "";
    this.#refs.away.hidden = !branding.awayMessage;
    this.#refs.emptyText.textContent = branding.welcomeCopy;
    this.#refs.empty.hidden = this.#state.conversation.items.length > 0;
    this.#refs.emptyChips.replaceChildren(
      ...branding.starterPrompts.map((prompt) => this.#createChip(prompt, "starterChip")),
    );
    // Never removed once set: the fake DOM used in tests has no
    // removeAttribute, and a host that publishes a privacy URL is not
    // expected to retract it mid-session.
    const privacyHref = safeUrl(branding.privacyUrl);
    if (privacyHref) this.#refs.trustLink.setAttribute("href", privacyHref);
    this.#refs.live.textContent = this.#state.liveCaption;
    this.#refs.live.hidden = !this.#state.liveCaption;
    this.#refs.composer.value = this.#state.draft;
    this.#refs.voice.hidden = !branding.voiceEnabled || !this.#config?.adapter.startVoice;
    this.#refs.voice.textContent = this.#state.modality === "voice" ? "End voice" : "Voice";
    this.#refs.voice.setAttribute(
      "aria-label",
      this.#state.modality === "voice" ? "End voice mode" : "Start voice mode",
    );
    this.#refs.attach.hidden = !this.#config?.adapter.uploadFiles;
    this.#refs.expandIcon.hidden = this.#state.desktopPresentation === "expanded";
    this.#refs.restoreIcon.hidden = this.#state.desktopPresentation !== "expanded";
    this.#refs.expand.setAttribute(
      "aria-label",
      this.#state.desktopPresentation === "expanded" ? "Restore assistant" : "Expand assistant",
    );
    this.#refs.status.textContent = this.#statusLabel();
    this.#refs.surface.dataset.modality = this.#state.modality;
    this.#refs.surface.dataset.voiceState = this.#state.voiceState;
    this.#refs.surface.setAttribute("aria-modal", String(this.#state.presentation === "mobile-sheet"));
    this.#refs.launcher.hidden = this.#state.presentation !== "launcher";
    this.#refs.surface.hidden = this.#state.presentation === "launcher";
    this.#refs.resize.hidden =
      this.#state.presentation === "mobile-sheet" || this.#state.desktopPresentation === "expanded";
    this.#renderAvatar();
    this.#renderThread();
    this.#renderLayout();
  }

  #renderAvatar(): void {
    if (!this.#refs) return;
    this.#refs.avatar.replaceChildren();
    const source = this.#state.branding.avatarUrl ?? this.#state.branding.logoUrl;
    if (source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      this.#refs.avatar.append(image);
    } else {
      this.#refs.avatar.textContent = this.#state.branding.assistantName.slice(0, 1).toUpperCase();
    }
  }

  #renderThread(): void {
    if (!this.#refs) return;
    const fragment = document.createDocumentFragment();
    for (const item of [...this.#state.conversation.items].sort((a, b) => a.sequence - b.sequence)) {
      if (item.role === "assistant" && item.status === "pending" && item.parts.length === 0) {
        fragment.append(this.#renderThinking());
        continue;
      }
      const article = document.createElement("article");
      article.className = `message ${item.role}`;
      article.dataset.status = item.status;
      article.setAttribute("aria-label", `${item.role === "assistant" ? this.#state.branding.assistantName : "You"} message`);
      for (const part of item.parts) {
        const node = this.#renderPart(part);
        if (node) article.append(node);
      }
      fragment.append(article);
      if (item.role === "user" && item.status === "failed") {
        fragment.append(this.#renderRetryRow());
      }
    }
    this.#refs.thread.replaceChildren(fragment);
    this.#refs.thread.scrollTop = this.#refs.thread.scrollHeight;
  }

  /**
   * Renders the pending-with-no-parts turn that `#renderThread` skips over
   * above: a three-dot bounce plus a label naming the module the assistant
   * is reading, when the learning context makes that possible.
   */
  #renderThinking(): HTMLElement {
    const article = document.createElement("article");
    article.className = "message assistant thinking";
    article.setAttribute("aria-label", `${this.#state.branding.assistantName} is thinking`);
    const dots = document.createElement("span");
    dots.className = "thinkingDots";
    for (let index = 0; index < 3; index += 1) dots.append(document.createElement("i"));
    const label = document.createElement("span");
    label.className = "thinkingLabel";
    label.textContent = this.#thinkingLabel();
    article.append(dots, label);
    return article;
  }

  #thinkingLabel(): string {
    const module = this.#state.learningContext.module;
    return module ? `Reading ${module}…` : "Thinking…";
  }

  /** The "Didn't send · Try again" row shown under a failed user message. */
  #renderRetryRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "retryRow";
    const label = document.createElement("span");
    label.className = "retryLabel";
    label.textContent = "Didn't send · ";
    const retry = createButton("Try sending that again", "retryButton", "Try again");
    retry.addEventListener("click", () => void this.retryLastFailed());
    label.append(retry);
    row.append(label);
    return row;
  }

  /** A pill button that sends its own label as the next question. Used for
   * both starter prompts on the empty state and follow-up suggestions. */
  #createChip(text: string, className: string): HTMLButtonElement {
    const chip = createButton(`Ask: ${text}`, className, text);
    chip.addEventListener("click", () => void this.send(text));
    return chip;
  }

  /**
   * Renders one part to a DOM node, or `null` for a kind this build does
   * not recognize. An older widget build meeting a server payload with a
   * newer part kind must skip it silently, never throw.
   */
  #renderPart(part: WidgetPart): HTMLElement | null {
    switch (part.kind) {
      case "text": {
        const paragraph = document.createElement("p");
        appendFormattedText(paragraph, part.text);
        return paragraph;
      }
      case "attachment": {
        const chip = document.createElement("div");
        chip.className = "attachment";
        chip.textContent = `${part.filename} · ${part.status}${part.error ? ` · ${part.error}` : ""}`;
        chip.setAttribute("aria-label", `${part.filename}, ${part.status}`);
        return chip;
      }
      case "source": {
        const link = document.createElement("a");
        link.className = "source";
        link.textContent = `Source · ${part.title}`;
        const href = safeUrl(part.url);
        if (href) {
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        return link;
      }
      case "diagram": {
        const figure = document.createElement("figure");
        figure.className = "diagram";
        const caption = document.createElement("figcaption");
        caption.textContent = part.caption;
        if (part.approved) {
          const source = safeUrl(part.url) ?? safeUrl(part.rasterFallbackUrl);
          if (source) {
            const image = document.createElement("img");
            image.src = source;
            image.alt = part.caption;
            image.loading = "lazy";
            image.referrerPolicy = "no-referrer";
            figure.append(image);
          }
        }
        figure.append(caption);
        return figure;
      }
      case "video": {
        const figure = document.createElement("figure");
        figure.className = "video";
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "none";
        const poster = safeUrl(part.posterUrl);
        if (poster) video.poster = poster;
        const source = safeUrl(part.url);
        if (source) video.src = source;
        figure.append(video);
        const meta = document.createElement("figcaption");
        meta.className = "videoMeta";
        meta.append(iconSpan("videoPlayIcon", PLAY_ICON));
        const title = document.createElement("span");
        title.className = "videoTitle";
        title.textContent = part.title;
        meta.append(title);
        if (part.durationLabel) {
          const duration = document.createElement("span");
          duration.className = "videoDuration";
          duration.textContent = part.durationLabel;
          meta.append(duration);
        }
        figure.append(meta);
        return figure;
      }
      case "list": {
        const wrapper = document.createElement("div");
        wrapper.className = "list";
        if (part.heading) {
          const heading = document.createElement("div");
          heading.className = "listHeading";
          heading.textContent = part.heading;
          wrapper.append(heading);
        }
        const rows = document.createElement("div");
        rows.className = "listRows";
        part.items.forEach((entry, index) => {
          const row = document.createElement("div");
          row.className = "listRow";
          const badge = document.createElement("span");
          badge.className = "listBadge";
          badge.textContent = String(index + 1);
          const label = document.createElement("span");
          label.className = "listLabel";
          appendFormattedText(label, entry);
          row.append(badge, label);
          rows.append(row);
        });
        wrapper.append(rows);
        return wrapper;
      }
      case "quote": {
        const block = document.createElement("blockquote");
        block.className = "quote";
        const paragraph = document.createElement("p");
        appendFormattedText(paragraph, part.text);
        block.append(paragraph);
        if (part.attribution) {
          const cite = document.createElement("cite");
          cite.textContent = part.attribution;
          block.append(cite);
        }
        return block;
      }
      case "chart": {
        const card = document.createElement("div");
        card.className = "chart";
        const head = document.createElement("div");
        head.className = "chartHead";
        const heading = document.createElement("span");
        heading.textContent = part.heading;
        head.append(heading);
        if (part.sourceLabel) {
          const sourceLabel = document.createElement("span");
          sourceLabel.className = "chartSource";
          sourceLabel.textContent = part.sourceLabel;
          head.append(sourceLabel);
        }
        card.append(head);
        const bars = document.createElement("div");
        bars.className = "chartBars";
        const labels = document.createElement("div");
        labels.className = "chartLabels";
        for (const bar of part.bars) {
          const value = Number.isFinite(bar.value) ? clamp(bar.value, 0, 100) : 0;
          const column = document.createElement("div");
          column.className = "chartBar";
          const valueLabel = document.createElement("span");
          valueLabel.textContent = `${Math.round(value)}%`;
          const fill = document.createElement("i");
          fill.style.height = `${value}%`;
          column.append(valueLabel, fill);
          bars.append(column);
          const label = document.createElement("span");
          label.textContent = bar.label;
          labels.append(label);
        }
        card.append(bars, labels);
        if (part.footnote) {
          const footnote = document.createElement("p");
          footnote.className = "chartFootnote";
          footnote.textContent = part.footnote;
          card.append(footnote);
        }
        return card;
      }
      case "code": {
        const card = document.createElement("div");
        card.className = "code";
        if (part.label) {
          const label = document.createElement("div");
          label.className = "codeLabel";
          label.textContent = part.label;
          card.append(label);
        }
        const pre = document.createElement("pre");
        const codeElement = document.createElement("code");
        // Server-authored code is untrusted text, never markup: textContent only.
        codeElement.textContent = part.code;
        pre.append(codeElement);
        card.append(pre);
        return card;
      }
      case "progress": {
        const card = document.createElement("div");
        card.className = "progress";
        const head = document.createElement("div");
        head.className = "progressHead";
        head.append(iconSpan("progressIcon", PROGRESS_ICON));
        const text = document.createElement("div");
        text.className = "progressText";
        const moduleLabel = document.createElement("div");
        moduleLabel.className = "progressModule";
        moduleLabel.textContent = part.moduleLabel;
        const statusLabel = document.createElement("div");
        statusLabel.className = "progressStatus";
        statusLabel.textContent = part.statusLabel;
        text.append(moduleLabel, statusLabel);
        head.append(text);
        card.append(head);
        const total = Number.isFinite(part.totalSteps) && part.totalSteps > 0 ? Math.round(part.totalSteps) : 0;
        const completed = Number.isFinite(part.completedSteps) ? clamp(Math.round(part.completedSteps), 0, total) : 0;
        const bar = document.createElement("div");
        bar.className = "progressBar";
        for (let index = 0; index < total; index += 1) {
          const segment = document.createElement("i");
          if (index < completed) segment.className = "filled";
          bar.append(segment);
        }
        card.append(bar);
        if (part.nextLabel) {
          const next = document.createElement("div");
          next.className = "progressNext";
          const label = document.createElement("span");
          label.textContent = `Next: ${part.nextLabel}`;
          const chevron = document.createElement("span");
          chevron.className = "chevron";
          chevron.textContent = "›";
          next.append(label, chevron);
          card.append(next);
        }
        return card;
      }
      case "followups": {
        const wrapper = document.createElement("div");
        wrapper.className = "followups";
        for (const suggestion of part.suggestions) {
          if (!suggestion.trim()) continue;
          wrapper.append(this.#createChip(suggestion, "followupChip"));
        }
        return wrapper;
      }
      default:
        return null;
    }
  }

  #renderLayout(): void {
    if (!this.#refs) return;
    const { surface, launcher } = this.#refs;
    const { branding, layout, presentation } = this.#state;
    launcher.classList.toggle("left", branding.launcherPosition === "bottom-left");
    this.#refs.greetingBubble.classList.toggle(
      "left",
      branding.launcherPosition === "bottom-left",
    );
    surface.dataset.presentation = presentation;
    if (presentation === "panel") {
      surface.style.left = `${layout.x}px`;
      surface.style.top = `${layout.y}px`;
      surface.style.width = `${layout.width}px`;
      surface.style.height = `${layout.height}px`;
    } else {
      surface.style.removeProperty("left");
      surface.style.removeProperty("top");
      surface.style.removeProperty("width");
      surface.style.removeProperty("height");
    }
  }

  #receiveEvent(event: WidgetRuntimeEvent): void {
    if (event.conversationId !== this.#state.conversation.id) return;
    switch (event.type) {
      case "response.delta": {
        let item = this.#state.conversation.items.find((candidate) => candidate.id === event.itemId);
        if (!item) {
          item = {
            id: event.itemId,
            sequence: this.#nextSequence(),
            role: "assistant",
            modality: this.#state.modality,
            status: "streaming",
            parts: [{ kind: "text", text: "" }],
            createdAt: now(),
          };
          this.#state.conversation.items.push(item);
        }
        const textPart = item.parts.find((part): part is TextPart => part.kind === "text");
        if (textPart) textPart.text += event.text;
        else item.parts.push({ kind: "text", text: event.text });
        item.status = "streaming";
        break;
      }
      case "response.complete":
      case "response.interrupted": {
        const item = this.#state.conversation.items.find((candidate) => candidate.id === event.itemId);
        if (item) item.status = event.type === "response.complete" ? "complete" : "interrupted";
        this.#state.voiceState = this.#state.modality === "voice" ? "listening" : "idle";
        if (this.#state.presentation === "launcher") this.#state.unread += 1;
        break;
      }
      case "transcript.partial":
        this.#state.liveCaption = event.text;
        break;
      case "transcript.final":
        this.#state.liveCaption = "";
        if (!this.#state.conversation.items.some((item) => item.id === event.itemId)) {
          this.#state.conversation.items.push({
            id: event.itemId,
            sequence: this.#nextSequence(),
            role: "user",
            modality: "voice",
            status: "complete",
            parts: [{ kind: "text", text: event.text }],
            createdAt: now(),
          });
        }
        break;
      case "voice.state":
        this.#state.voiceState = event.state;
        break;
      case "thread.item":
        this.#upsertThreadItem(event.item);
        break;
      case "attachment.updated":
        this.#upsertAttachment(event.attachment);
        break;
      case "learning.context":
        this.#state.learningContext = event.context;
        break;
      case "connection":
        this.#state.connection = event.status;
        break;
      case "error":
        this.#state.connection = event.recoverable ? "reconnecting" : "offline";
        if (this.#state.modality === "voice") {
          this.#state.modality = "text";
          this.#state.voiceState = "idle";
          this.#state.liveCaption = "";
        }
        break;
    }
    this.#persistResumeState();
    this.#render();
    this.#dispatch(event.type, event);
  }

  /**
   * A `thread.item` for an id already on the thread is an UPDATE, not a
   * duplicate to ignore.
   *
   * Every adapter announces an assistant turn twice: once as `pending` with
   * empty `parts` the moment the question is sent, so the thread shows the
   * turn is under way, and again with the same id once the answer arrives,
   * carrying the real `parts`. This handler used to drop the second event
   * whenever the id was already present, so the pending placeholder was the
   * only thing that ever reached the DOM and every answer rendered as an
   * empty bubble — on customer sites and in the console's live preview alike.
   *
   * Streaming deltas are the reason this merges rather than replaces: an
   * adapter that has already appended text through `response.delta` must not
   * lose it to a late `pending` event carrying no parts. So an incoming item
   * with no parts keeps the parts already on the thread, and a terminal status
   * is never rolled back to `pending`.
   */
  #upsertThreadItem(incoming: WidgetThreadItem): void {
    const parts = incoming.parts.map((part) => ({ ...part }));
    const existing = this.#state.conversation.items.find((item) => item.id === incoming.id);
    if (!existing) {
      this.#state.conversation.items.push({ ...incoming, parts });
      return;
    }
    if (parts.length > 0) existing.parts = parts;
    if (!(incoming.status === "pending" && existing.status !== "pending")) {
      existing.status = incoming.status;
    }
    existing.role = incoming.role;
    existing.modality = incoming.modality;
    existing.createdAt = incoming.createdAt;
  }

  #upsertAttachment(attachment: AttachmentPart): void {
    for (const item of this.#state.conversation.items) {
      const index = item.parts.findIndex((part) => part.kind === "attachment" && part.id === attachment.id);
      if (index >= 0) {
        item.parts[index] = { ...attachment };
        return;
      }
    }
    this.#state.conversation.items.push({
      id: makeId("attachment-message"),
      sequence: this.#nextSequence(),
      role: "user",
      modality: this.#state.modality,
      status: attachment.status === "ready" ? "complete" : "pending",
      parts: [{ ...attachment }],
      createdAt: now(),
    });
  }

  async #uploadFiles(files: FileList | null | undefined): Promise<void> {
    await this.#guardAsync("upload", async () => {
      if (!files?.length || !this.#config?.adapter.uploadFiles) return;
      const configurationVersion = this.#configurationVersion;
      try {
        await this.#config.adapter.uploadFiles(
          {
            conversationId: this.#state.conversation.id,
            files: Array.from(files),
            signal: this.#abort?.signal ?? new AbortController().signal,
          },
          (event) => {
            if (configurationVersion === this.#configurationVersion) this.receive(event);
          },
        );
      } catch (error) {
        if (configurationVersion !== this.#configurationVersion) return;
        throw error;
      }
    }, false);
  }

  async #stopGeneration(): Promise<void> {
    await this.#guardAsync("stop", async () => {
      this.#generationAbort?.abort();
      let streaming: WidgetThreadItem | undefined;
      for (let index = this.#state.conversation.items.length - 1; index >= 0; index -= 1) {
        const candidate = this.#state.conversation.items[index];
        if (candidate?.status === "streaming") {
          streaming = candidate;
          break;
        }
      }
      if (streaming) streaming.status = "interrupted";
      if (this.#config?.adapter.stopGeneration) {
        await this.#config.adapter.stopGeneration({
          conversationId: this.#state.conversation.id,
          ...(streaming ? { itemId: streaming.id } : {}),
        });
      }
      this.#render();
    }, false);
  }

  #setDesktopPresentation(presentation: DesktopPresentation): void {
    this.#state.desktopPresentation = presentation;
    this.#state.presentation = isMobileViewport() && presentation !== "launcher" ? "mobile-sheet" : presentation;
    if (presentation === "panel") this.#clampLayout();
    this.#persistLayout();
  }

  #updatePresentationForViewport(): void {
    this.#clampLayout();
    this.#state.presentation =
      isMobileViewport() && this.#state.desktopPresentation !== "launcher"
        ? "mobile-sheet"
        : this.#state.desktopPresentation;
    this.#render();
  }

  #clampLayout(): void {
    const bounds = viewport();
    this.#state.layout.width = clamp(this.#state.layout.width, MIN_WIDTH, bounds.width - VIEWPORT_GUTTER * 2);
    this.#state.layout.height = clamp(this.#state.layout.height, MIN_HEIGHT, bounds.height - VIEWPORT_GUTTER * 2);
    this.#state.layout.x = clamp(
      this.#state.layout.x || bounds.width - this.#state.layout.width - 24,
      VIEWPORT_GUTTER,
      bounds.width - this.#state.layout.width - VIEWPORT_GUTTER,
    );
    this.#state.layout.y = clamp(
      this.#state.layout.y || bounds.height - this.#state.layout.height - 24,
      VIEWPORT_GUTTER,
      bounds.height - this.#state.layout.height - VIEWPORT_GUTTER,
    );
  }

  #beginPointerDrag(kind: "move" | "resize", event: PointerEvent): void {
    if (isMobileViewport() || this.#state.desktopPresentation !== "panel") return;
    if (kind === "move" && (event.target as HTMLElement)?.closest?.("button")) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId);
    this.#drag = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      layout: { ...this.#state.layout },
    };
  }

  #onPointerMove = (event: PointerEvent): void => {
    if (!this.#drag) return;
    const deltaX = event.clientX - this.#drag.startX;
    const deltaY = event.clientY - this.#drag.startY;
    this.#state.layout =
      this.#drag.kind === "move"
        ? { ...this.#drag.layout, x: this.#drag.layout.x + deltaX, y: this.#drag.layout.y + deltaY }
        : {
            ...this.#drag.layout,
            width: this.#drag.layout.width + deltaX,
            height: this.#drag.layout.height + deltaY,
          };
    this.#clampLayout();
    this.#renderLayout();
  };

  #endPointerDrag = (): void => {
    if (!this.#drag) return;
    this.#drag = undefined;
    this.#persistLayout();
  };

  #onMoveKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 40 : 10;
    const deltas: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    this.moveBy(delta[0], delta[1]);
  };

  #onResizeKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 40 : 10;
    const deltas: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    this.resizeBy(delta[0], delta[1]);
  };

  #onSurfaceKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this.#state.modality === "voice") void this.endVoice();
    else if (this.#state.desktopPresentation === "expanded") this.restore();
    else this.close();
  };

  #onViewportChange = (): void => this.#guard("viewport", () => this.#updatePresentationForViewport());

  #onColorSchemeChange = (): void =>
    this.#guard("color_scheme", () => this.#render());

  #clearGreetingTimer(): void {
    if (this.#greetingTimer !== undefined) {
      globalThis.clearTimeout(this.#greetingTimer);
      this.#greetingTimer = undefined;
    }
  }

  #scheduleGreetingBubble(): void {
    this.#clearGreetingTimer();
    this.#greetingBubbleVisible = false;
    const branding = this.#state.branding;
    if (
      !this.#connected ||
      this.#greetingBubbleShown ||
      this.#state.presentation !== "launcher" ||
      !branding.greetingBubbleEnabled ||
      branding.welcomeCopy.trim().length === 0
    ) {
      this.#render();
      return;
    }
    const version = this.#configurationVersion;
    this.#greetingTimer = globalThis.setTimeout(() => {
      this.#greetingTimer = undefined;
      if (
        version !== this.#configurationVersion ||
        !this.#connected ||
        this.#state.presentation !== "launcher"
      ) {
        return;
      }
      this.#greetingBubbleShown = true;
      this.#greetingBubbleVisible = true;
      this.#render();
    }, branding.greetingBubbleDelaySeconds * 1_000);
  }

  #identityLabel(): string {
    if (this.#state.identity.tier === "verified") return "Verified learner";
    if (this.#state.identity.tier === "self_reported") return "Identity not verified";
    return "Anonymous";
  }

  #contextLabel(): string {
    const context = this.#state.learningContext;
    if (context.status === "ambiguous") return "Learning context is unclear";
    if (context.status === "stale") return "Learning context may be out of date";
    if (context.status === "unknown") return "";
    const hierarchy = [context.course, context.module, context.lesson].filter(Boolean).join(" · ");
    return hierarchy ? `Currently learning: ${hierarchy}` : "";
  }

  #statusLabel(): string {
    if (this.#state.connection === "offline") return "Offline. Your draft is preserved.";
    if (this.#state.connection === "reconnecting") return "Reconnecting…";
    if (this.#state.modality === "voice") {
      const labels: Record<VoiceState, string> = {
        idle: "Voice ready",
        permission: "Microphone permission needed",
        connecting: "Connecting voice…",
        listening: "Listening",
        thinking: "Thinking",
        speaking: "Speaking",
      };
      return labels[this.#state.voiceState];
    }
    return "";
  }

  #fontValue(font: WidgetBranding["fontFamily"]): string {
    if (font === "serif") return "ui-serif, Georgia, serif";
    if (font === "rounded") return "ui-rounded, system-ui, sans-serif";
    return "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  }

  #setCssVariable(name: string, value: string): void {
    (this.#root?.host as HTMLElement | undefined)?.style.setProperty(name, value);
  }

  #nextSequence(): number {
    return Math.max(0, ...this.#state.conversation.items.map((item) => item.sequence)) + 1;
  }

  #storageKey(suffix: "layout" | "resume"): string {
    return `${STORAGE_PREFIX}:${this.#config?.tenantKey ?? "unconfigured"}:${suffix}`;
  }

  #defaultStorage(): Storage | undefined {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  }

  #loadPersistedState(): void {
    const layout = storageRead(this.#storage, this.#storageKey("layout"));
    if (layout) {
      try {
        const parsed = JSON.parse(layout) as Partial<WidgetLayout> & { desktopPresentation?: DesktopPresentation };
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
          this.#state.layout = {
            x: Number(parsed.x),
            y: Number(parsed.y),
            width: Number(parsed.width),
            height: Number(parsed.height),
          };
        }
        if (parsed.desktopPresentation === "launcher" || parsed.desktopPresentation === "panel" || parsed.desktopPresentation === "expanded") {
          this.#state.desktopPresentation = parsed.desktopPresentation;
        }
      } catch {
        // Corrupt host storage is ignored.
      }
    }
    const resume = storageRead(this.#storage, this.#storageKey("resume"));
    if (resume) {
      try {
        const parsed = JSON.parse(resume) as { draft?: string; modality?: WidgetModality };
        this.#state.draft = typeof parsed.draft === "string" ? parsed.draft : "";
        this.#state.modality = parsed.modality === "voice" ? "text" : parsed.modality ?? "text";
      } catch {
        // Corrupt host storage is ignored.
      }
    }
    this.#clampLayout();
    this.#updatePresentationForViewport();
  }

  #resumeConversationId(): string | undefined {
    const resume = storageRead(this.#storage, this.#storageKey("resume"));
    if (!resume) return undefined;
    try {
      const parsed = JSON.parse(resume) as { conversationId?: string };
      return typeof parsed.conversationId === "string" ? parsed.conversationId : undefined;
    } catch {
      return undefined;
    }
  }

  #persistLayout(): void {
    if (!this.#config) return;
    storageWrite(
      this.#storage,
      this.#storageKey("layout"),
      JSON.stringify({ ...this.#state.layout, desktopPresentation: this.#state.desktopPresentation }),
    );
  }

  #persistResumeState(): void {
    if (!this.#config) return;
    storageWrite(
      this.#storage,
      this.#storageKey("resume"),
      JSON.stringify({
        conversationId: this.#state.conversation.id,
        draft: this.#state.draft,
        modality: this.#state.modality,
      }),
    );
  }

  #dispatch(name: string, detail: unknown): void {
    try {
      this.dispatchEvent(new CustomEvent(`course-ai:${name}`, { detail, bubbles: false, composed: false }));
    } catch {
      // Event dispatch is advisory and isolated from the host.
    }
  }

  #guard(name: string, operation: () => void): void {
    if (this.#failure) return;
    try {
      operation();
    } catch {
      this.#failSilent(`widget_${name}_failed`);
    }
  }

  async #guardAsync(name: string, operation: () => Promise<void>, fatal = true): Promise<void> {
    if (this.#failure) return;
    try {
      await operation();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (fatal) this.#failSilent(`widget_${name}_failed`);
      else {
        this.#reportHealth(`widget_${name}_failed`);
        this.#state.connection = "reconnecting";
        if (name.startsWith("voice")) {
          this.#state.modality = "text";
          this.#state.voiceState = "idle";
        }
        this.#render();
      }
    }
  }

  #failSilent(code: string): void {
    this.#failure = true;
    this.style.display = "none";
    this.#reportHealth(code);
  }

  #reportHealth(code: string): void {
    try {
      this.#config?.adapter.reportHealth?.({
        code,
        ...(this.#config ? { tenantKey: this.#config.tenantKey } : {}),
      });
    } catch {
      // Host telemetry implementations are never trusted to remain exception-free.
    }
  }
}

export function registerCourseAiWidget(tagName = "course-ai-widget"): boolean {
  try {
    if (!globalThis.customElements || globalThis.customElements.get(tagName)) return Boolean(globalThis.customElements?.get(tagName));
    globalThis.customElements.define(tagName, CourseAiWidgetElement);
    return true;
  } catch {
    return false;
  }
}

export function autoMountCourseAiWidget(): CourseAiWidgetElement | undefined {
  try {
    if (!globalThis.document || document.querySelector("course-ai-widget")) return undefined;
    const script = document.currentScript as HTMLScriptElement | null;
    const tenantKey = script?.dataset.tenant;
    if (!tenantKey) return undefined;
    registerCourseAiWidget();
    const widget = document.createElement("course-ai-widget") as CourseAiWidgetElement;
    widget.setAttribute("tenant-key", tenantKey);
    document.body.append(widget);
    const adapter = (globalThis as typeof globalThis & { CourseAiWidgetAdapter?: WidgetRuntimeAdapter }).CourseAiWidgetAdapter;
    if (adapter) void widget.configure({ tenantKey, adapter });
    return widget;
  } catch {
    return undefined;
  }
}

registerCourseAiWidget();

const STYLES = `
:host{--widget-primary:#176b5b;--widget-accent:#d9f2ea;--widget-surface:#fff;--widget-text:#18211f;--widget-font:system-ui,sans-serif;all:initial;position:fixed;z-index:2147483000;font-family:var(--widget-font);color:var(--widget-text);line-height:1.45;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
button,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:focus-visible,textarea:focus-visible,[tabindex]:focus-visible,a:focus-visible{outline:3px solid var(--widget-primary);outline-offset:2px}
.launcher{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center;width:60px;height:60px;border:0;border-radius:100px;background:var(--widget-primary);color:#fff;box-shadow:0 10px 26px color-mix(in srgb,var(--widget-primary) 40%,transparent);font-size:13px;font-weight:800;line-height:1.1;transition:transform .18s ease,box-shadow .18s ease}
.launcher:hover{transform:translateY(-2px);box-shadow:0 14px 32px color-mix(in srgb,var(--widget-primary) 46%,transparent)}
.launcherIcon[hidden]{display:none}
.launcher[data-shape=pill]{width:auto;min-width:132px;height:50px;padding:0 20px;gap:9px;border-radius:999px;white-space:nowrap}
.launcher[data-shape=tab]{width:auto;min-width:118px;height:46px;bottom:env(safe-area-inset-bottom);padding:0 18px;border-radius:16px 16px 0 0;white-space:nowrap}
.launcher.left{left:24px;right:auto}
.greetingBubble{position:fixed;right:24px;bottom:calc(100px + env(safe-area-inset-bottom));max-width:min(200px,calc(100vw - 48px));padding:12px 15px;border:1px solid color-mix(in srgb,var(--widget-text) 11%,transparent);border-radius:16px;background:var(--widget-surface);box-shadow:0 6px 18px rgba(0,0,0,.12);color:var(--widget-text);font-size:13px;line-height:1.35;text-align:left}
.greetingBubble.left{left:24px;right:auto}
.greetingBubble[hidden]{display:none}
.launcher[data-shape=tab]~.greetingBubble{bottom:calc(58px + env(safe-area-inset-bottom))}
.surface{container-type:inline-size;container-name:caiw;position:fixed;isolation:isolate;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto auto auto;overflow:hidden;background:color-mix(in srgb,var(--widget-surface) 97%,transparent);border:1px solid color-mix(in srgb,var(--widget-text) 10%,transparent);border-radius:26px;box-shadow:0 28px 90px color-mix(in srgb,var(--widget-text) 20%,transparent),0 2px 12px #0000000d;backdrop-filter:blur(26px) saturate(1.08)}
.surface::before{position:absolute;z-index:4;inset:0;border:1px solid transparent;border-radius:inherit;background:linear-gradient(115deg,color-mix(in srgb,var(--widget-primary) 58%,#83ffe8),transparent 28% 70%,color-mix(in srgb,var(--widget-accent) 55%,#d7a8ff)) border-box;mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);mask-composite:exclude;opacity:.34;pointer-events:none;content:"";transition:opacity .25s ease,filter .25s ease}
.surface[data-modality=voice]::before{opacity:.92;filter:drop-shadow(0 0 9px color-mix(in srgb,var(--widget-primary) 36%,transparent));animation:spectralEdge 2.8s ease-in-out infinite}
.surface[hidden],.launcher[hidden]{display:none}
.surface[data-presentation=expanded]{inset:5vh 5vw;width:90vw;height:90vh}
.surface[data-presentation=mobile-sheet]{inset:0;width:100vw;height:100dvh;border:0;border-radius:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.header{min-height:70px;display:flex;align-items:center;gap:11px;padding:13px 14px 12px 16px;border-bottom:1px solid color-mix(in srgb,var(--widget-text) 8%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--widget-surface) 98%,transparent),color-mix(in srgb,var(--widget-surface) 91%,transparent));touch-action:none}
.avatar{position:relative;display:grid;place-items:center;width:39px;height:39px;overflow:hidden;border:1px solid color-mix(in srgb,var(--widget-primary) 14%,transparent);border-radius:50%;background:radial-gradient(circle at 34% 28%,#fff 0 7%,transparent 25%),linear-gradient(145deg,var(--widget-accent),color-mix(in srgb,var(--widget-primary) 22%,#fff));color:var(--widget-primary);font-size:13px;font-weight:780;box-shadow:inset 0 0 0 4px color-mix(in srgb,var(--widget-surface) 62%,transparent)}
.avatar img{width:100%;height:100%;object-fit:cover}
.heading{display:flex;min-width:0;flex:1;flex-direction:column}
.heading strong{overflow:hidden;font-size:14px;font-weight:730;letter-spacing:-.01em;text-overflow:ellipsis;white-space:nowrap}
.identity{font-size:10px;letter-spacing:.015em;opacity:.58}
.actions,.controls{display:flex;align-items:center;gap:7px}
.icon,.send{display:flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;border:0;border-radius:12px;background:transparent}
.icon:hover{background:color-mix(in srgb,var(--widget-text) 6%,transparent)}
.headerIcon{min-width:36px;min-height:36px;color:color-mix(in srgb,var(--widget-text) 70%,transparent)}
.headerIconGlyph[hidden]{display:none}
.send{width:34px;height:34px;min-width:34px;min-height:34px;padding:0;border-radius:100px;background:var(--widget-primary);color:#fff;box-shadow:0 8px 18px color-mix(in srgb,var(--widget-primary) 22%,transparent)}
.context{margin:10px 14px 0;padding:8px 11px;overflow:hidden;border:1px solid color-mix(in srgb,var(--widget-primary) 10%,transparent);border-radius:11px;background:color-mix(in srgb,var(--widget-accent) 54%,var(--widget-surface));color:color-mix(in srgb,var(--widget-text) 78%,transparent);font-size:10px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}
.thread{overflow:auto;padding:18px 17px 8px;overscroll-behavior:contain;scrollbar-color:color-mix(in srgb,var(--widget-primary) 20%,transparent) transparent;scrollbar-width:thin}
.empty{align-self:center;max-width:320px;margin:auto;padding:30px 25px 24px;text-align:center;font-size:21px;font-weight:650;letter-spacing:-.025em;line-height:1.28}
.empty::before{display:block;width:44px;height:44px;margin:0 auto 18px;border-radius:48% 52% 45% 55%/53% 44% 56% 47%;background:radial-gradient(circle at 35% 27%,#fff 0 8%,transparent 26%),conic-gradient(from 190deg,var(--widget-primary),color-mix(in srgb,var(--widget-accent) 72%,#75dfff),#d9b9ff,var(--widget-primary));box-shadow:0 12px 30px color-mix(in srgb,var(--widget-primary) 24%,transparent);content:"";animation:orbFloat 5.5s ease-in-out infinite}
.empty::after{display:block;margin:11px auto 0;color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:11px;font-weight:500;letter-spacing:0;line-height:1.5;content:"Answers include the published learning sources behind them."}
.message{width:fit-content;max-width:90%;margin:0 0 16px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--widget-text) 7%,transparent);border-radius:17px;background:color-mix(in srgb,var(--widget-text) 4%,var(--widget-surface));font-size:13px;line-height:1.55;box-shadow:0 5px 15px #00000008}
.message.assistant{width:fit-content;max-width:92%;padding:16px 18px;border-color:transparent;border-radius:19px 19px 19px 5px;background:var(--widget-surface);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.message.user{max-width:82%;margin-left:auto;padding:11px 15px;border-color:transparent;border-radius:19px 19px 5px 19px;background:var(--widget-primary);color:#fff;font-size:15px;box-shadow:0 9px 22px color-mix(in srgb,var(--widget-primary) 20%,transparent)}
.message[data-status=streaming]::after{content:"";display:inline-block;width:5px;height:14px;margin-left:3px;background:currentColor;animation:blink 1s step-end infinite}
.message[data-status=failed]{border:1px solid #c53030}
.message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.message.thinking{display:flex;align-items:center;gap:10px}
.thinkingDots{display:flex;gap:4px}
.thinkingDots i{display:block;width:6px;height:6px;border-radius:100px;background:color-mix(in srgb,var(--widget-text) 45%,transparent);animation:thinkBounce 1.2s ease-in-out infinite}
.thinkingDots i:nth-child(2){animation-delay:.15s}
.thinkingDots i:nth-child(3){animation-delay:.3s}
.thinkingLabel{color:color-mix(in srgb,var(--widget-text) 58%,transparent);font-size:12px}
.retryRow{display:flex;justify-content:flex-end;margin:-10px 0 16px}
.retryLabel{color:#c53030;font-size:11px}
.retryButton{border:0;background:transparent;padding:0;color:#c53030;font:inherit;font-weight:600;text-decoration:underline}
.away{margin:10px 14px 0;padding:14px 16px;border-radius:14px;background:var(--widget-surface);box-shadow:0 1px 2px rgba(0,0,0,.06);text-align:center}
.away[hidden]{display:none}
.awayHeading{font-size:14px;font-weight:650;margin-bottom:4px}
.awayBody{margin:0;color:color-mix(in srgb,var(--widget-text) 68%,transparent);font-size:13px;line-height:1.5}
.attachment{margin-top:8px;padding:8px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;background:color-mix(in srgb,var(--widget-surface) 70%,transparent);font-size:11px}
.source{display:flex;width:fit-content;align-items:center;gap:5px;margin-top:10px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--widget-primary) 15%,transparent);border-radius:999px;background:color-mix(in srgb,var(--widget-accent) 42%,var(--widget-surface));color:var(--widget-primary);font-size:10px;font-weight:680;text-decoration:none}
.source::after{content:"↗";font-size:10px}
.source:hover{text-decoration:underline}
.diagram{margin:8px 0 0}
.diagram img{display:block;max-width:100%;max-height:340px;border:1px solid color-mix(in srgb,var(--widget-text) 8%,transparent);border-radius:14px}
.diagram figcaption{margin-top:5px;font-size:12px;opacity:.75}
.video{margin:8px 0 0}
.video video{display:block;width:100%;max-height:220px;border-radius:12px;background:#000}
.videoMeta{display:flex;align-items:center;gap:9px;margin-top:6px;font-size:12px}
.videoPlayIcon{display:flex;color:var(--widget-primary)}
.videoTitle{flex:1;font-weight:500}
.videoDuration{color:color-mix(in srgb,var(--widget-text) 55%,transparent);font:10px ui-monospace,Menlo,monospace}
.list{margin:10px 0}
.listHeading{margin-bottom:9px;font-size:13px;font-weight:650;letter-spacing:-.005em}
.listRows{display:flex;flex-direction:column;gap:9px}
.listRow{display:flex;align-items:flex-start;gap:11px}
.listBadge{display:flex;align-items:center;justify-content:center;width:19px;height:19px;margin-top:1px;border-radius:100px;background:color-mix(in srgb,var(--widget-text) 5%,var(--widget-surface));color:var(--widget-primary);font-size:11px;font-weight:700;flex:none}
.listLabel{font-size:14px;line-height:1.5}
.quote{margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid var(--widget-primary)}
.quote p{margin:0;font-size:14px;line-height:1.55;font-style:italic;color:color-mix(in srgb,var(--widget-text) 68%,transparent)}
.quote cite{display:block;margin-top:6px;font-size:12px;font-style:normal;color:color-mix(in srgb,var(--widget-text) 50%,transparent)}
.chart{margin:0 0 16px;padding:15px 16px;border-radius:14px;background:color-mix(in srgb,var(--widget-text) 4%,var(--widget-surface))}
.chartHead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:14px}
.chartHead>span:first-child{font-size:13px;font-weight:650;letter-spacing:-.005em}
.chartSource{flex:none;color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:11px}
.chartBars{display:flex;align-items:flex-end;gap:10px;height:86px;margin-bottom:10px}
.chartBar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:7px;height:100%}
.chartBar span{font-size:11px;font-weight:600}
.chartBar i{display:block;width:100%;background:var(--widget-primary);border-radius:6px 6px 0 0}
.chartLabels{display:flex;gap:10px;text-align:center;color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:11px;line-height:1.35}
.chartLabels span{flex:1}
.chartFootnote{margin:11px 0 0;padding-top:11px;border-top:1px solid color-mix(in srgb,var(--widget-text) 8%,transparent);color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:12px;line-height:1.5}
.code{margin:0 0 16px;padding:13px 15px;border-radius:12px;background:#1d1d1f}
.codeLabel{margin-bottom:9px;color:#a1a1a6;font:10px ui-monospace,Menlo,monospace;letter-spacing:.07em}
.code pre{margin:0;overflow-x:auto}
.code code{color:#fff;font:12px/1.7 ui-monospace,'SF Mono',Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.progress{margin:0 0 16px;padding:14px 16px;border-radius:14px;background:color-mix(in srgb,var(--widget-text) 4%,var(--widget-surface))}
.progressHead{display:flex;gap:12px;align-items:center;margin-bottom:11px}
.progressIcon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--widget-primary);flex:none}
.progressText{flex:1;min-width:0}
.progressModule{font-size:13px;font-weight:650;letter-spacing:-.005em}
.progressStatus{color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:12px}
.progressBar{display:flex;gap:5px;margin-bottom:10px}
.progressBar i{display:block;height:5px;flex:1;border-radius:3px;background:color-mix(in srgb,var(--widget-text) 14%,transparent)}
.progressBar i.filled{background:var(--widget-primary)}
.progressNext{display:flex;align-items:center;gap:8px;color:var(--widget-primary);font-size:12px;font-weight:500}
.progressNext .chevron{color:color-mix(in srgb,var(--widget-text) 30%,transparent)}
.followups{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
.followupChip{border:1px solid color-mix(in srgb,var(--widget-text) 12%,transparent);border-radius:100px;padding:6px 12px;background:transparent;font-size:12px}
.emptyText{margin:0}
.emptyChips{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-top:14px}
.starterChip{border:0;border-radius:100px;padding:8px 13px;background:var(--widget-surface);box-shadow:0 1px 2px rgba(0,0,0,.07);font-size:13px}
.trust{padding:0 17px 9px;text-align:center;color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:11px}
.trustLink{color:var(--widget-primary)}
.live{position:relative;margin:0 15px 8px;padding:10px 12px 10px 35px;border:1px solid color-mix(in srgb,var(--widget-primary) 14%,transparent);border-radius:13px;background:color-mix(in srgb,var(--widget-accent) 54%,var(--widget-surface));font-size:12px}
.live::before{position:absolute;left:13px;top:50%;width:10px;height:10px;border-radius:50%;background:var(--widget-primary);box-shadow:0 0 0 5px color-mix(in srgb,var(--widget-primary) 12%,transparent);content:"";transform:translateY(-50%);animation:listenPulse 1.4s ease-in-out infinite}
.footer{margin:0 12px 11px;padding:11px 16px;border:1px solid color-mix(in srgb,var(--widget-text) 11%,transparent);border-radius:100px;background:color-mix(in srgb,var(--widget-surface) 92%,transparent);box-shadow:0 8px 28px #0000000a}
.footer:focus-within{border-color:color-mix(in srgb,var(--widget-primary) 38%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--widget-primary) 9%,transparent),0 10px 30px #0000000b}
.footer textarea{display:block;width:100%;min-height:49px;max-height:130px;resize:none;border:0;background:transparent;padding:8px 7px;outline:none;font-size:13px;line-height:1.45}
.footer textarea::placeholder{color:color-mix(in srgb,var(--widget-text) 45%,transparent)}
.controls{justify-content:flex-end}
.poweredBy{padding:0 17px 9px;color:color-mix(in srgb,var(--widget-text) 52%,transparent);font-size:10px;text-align:center}
.poweredBy[hidden]{display:none}
.controls .attach{margin-right:auto;font-size:20px}
.voice{display:flex;min-width:auto;align-items:center;gap:7px;padding:0 11px;color:var(--widget-primary);font-size:11px;font-weight:740}
.voice::before{width:10px;height:10px;border-radius:50%;background:radial-gradient(circle,#fff 0 18%,transparent 20%),var(--widget-primary);box-shadow:0 0 0 4px color-mix(in srgb,var(--widget-primary) 10%,transparent);content:""}
.surface[data-modality=voice] .voice{background:color-mix(in srgb,var(--widget-primary) 10%,transparent)}
.surface[data-modality=voice] .voice::before{animation:listenPulse 1.35s ease-in-out infinite}
.status{min-height:0;padding:0 17px 10px;color:color-mix(in srgb,var(--widget-text) 58%,transparent);font-size:10px}
.status:empty{display:none}
.resize{position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none}
.resize::after{content:"";position:absolute;right:5px;bottom:5px;width:9px;height:9px;border-right:2px solid var(--widget-primary);border-bottom:2px solid var(--widget-primary)}
@keyframes blink{50%{opacity:0}}
@keyframes thinkBounce{0%,80%,100%{transform:translateY(0);opacity:.6}40%{transform:translateY(-4px);opacity:1}}
@keyframes orbFloat{0%,100%{border-radius:45% 55% 52% 48%/46% 44% 56% 54%;transform:translateY(0) rotate(0)}50%{border-radius:54% 46% 43% 57%/43% 57% 43% 57%;transform:translateY(-2px) rotate(2deg)}}
@keyframes spectralEdge{0%,100%{opacity:.62}50%{opacity:1}}
@keyframes listenPulse{0%,100%{transform:scale(.82);opacity:.68}50%{transform:scale(1.08);opacity:1}}
@media(max-width:767px){.surface[data-presentation=expanded],.surface[data-presentation=panel]{inset:auto 0 0;width:100vw;height:min(92dvh,760px);border:0;border-radius:28px 28px 0 0;padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -20px 80px #0003}.surface[data-presentation=mobile-sheet]{inset:auto 0 0;height:min(92dvh,760px);border-radius:28px 28px 0 0;padding-top:0}.header{padding-top:14px}.launcher{right:18px;bottom:calc(18px + env(safe-area-inset-bottom))}.launcher.left{left:18px}.empty{font-size:20px}.context{margin-top:8px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
/* Container queries, not viewport media queries — the widget's own box is
   what the host page constrains, not the browser window (matches the three
   named widths the console's conversation surface uses: compact <420px,
   regular 420-720px, wide >720px). The panel defaults to 400px (compact)
   and only reaches wide once a visitor resizes or expands it. */
@container caiw (max-width:419px){.identity{display:none}.heading strong{font-size:13px}.message{font-size:12.5px}.empty{font-size:18px;padding:24px 18px 20px}.context{font-size:9px}}
@container caiw (min-width:420px) and (max-width:720px){.message{max-width:90%}}
@container caiw (min-width:721px){.thread{padding-inline:30px}.message{max-width:72%}.message.assistant{max-width:100%}.empty{font-size:23px}}
`;
