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
  voiceEnabled: boolean;
  privacyUrl?: string;
  termsUrl?: string;
  supportUrl?: string;
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

export type WidgetPart = TextPart | AttachmentPart | SourcePart | DiagramPart;

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
  voiceEnabled: false,
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
    voiceEnabled: typeof update.voiceEnabled === "boolean" ? update.voiceEnabled : base.voiceEnabled,
    ...(logoUrl ? { logoUrl } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(privacyUrl ? { privacyUrl } : {}),
    ...(termsUrl ? { termsUrl } : {}),
    ...(supportUrl ? { supportUrl } : {}),
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

export class CourseAiWidgetElement extends HTMLElementBase {
  static readonly observedAttributes = ["tenant-key"];

  #root?: ShadowRoot;
  #config?: WidgetRuntimeConfiguration;
  #storage: Storage | undefined;
  #abort?: AbortController;
  #voiceControl: WidgetVoiceControl | undefined;
  #generationAbort: AbortController | undefined;
  #configurationVersion = 0;
  #failure = false;
  #connected = false;
  #initialized = false;
  #drag: { kind: "move" | "resize"; startX: number; startY: number; layout: WidgetLayout } | undefined;
  #refs?: {
    launcher: HTMLButtonElement;
    surface: HTMLElement;
    header: HTMLElement;
    avatar: HTMLElement;
    name: HTMLElement;
    identity: HTMLElement;
    context: HTMLElement;
    thread: HTMLElement;
    empty: HTMLElement;
    live: HTMLElement;
    composer: HTMLTextAreaElement;
    send: HTMLButtonElement;
    voice: HTMLButtonElement;
    attach: HTMLButtonElement;
    fileInput: HTMLInputElement;
    expand: HTMLButtonElement;
    close: HTMLButtonElement;
    stop: HTMLButtonElement;
    resize: HTMLElement;
    status: HTMLElement;
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
      this.#updatePresentationForViewport();
      this.#render();
    });
  }

  disconnectedCallback(): void {
    this.#connected = false;
    globalThis.removeEventListener?.("resize", this.#onViewportChange);
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
      this.#dispatch("ready", { conversationId: this.#state.conversation.id });
    });
  }

  open(): void {
    this.#guard("open", () => {
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

    const launcher = createButton("Open learning assistant", "launcher", "✦");
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
    const expand = createButton("Expand assistant", "icon", "↗");
    const close = createButton("Close assistant", "icon", "×");
    actions.append(expand, close);
    header.append(avatar, heading, actions);

    const context = document.createElement("div");
    context.className = "context";
    context.setAttribute("aria-live", "polite");
    const thread = document.createElement("main");
    thread.className = "thread";
    thread.setAttribute("aria-label", "Conversation");
    const empty = document.createElement("div");
    empty.className = "empty";
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
    const attach = createButton("Attach files", "icon", "＋");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.hidden = true;
    const voice = createButton("Start voice mode", "icon", "◉");
    const stop = createButton("Stop response", "icon stop", "■");
    const send = createButton("Send message", "send", "Send");
    controls.append(attach, fileInput, voice, stop, send);
    footer.append(composer, controls);

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const resize = document.createElement("div");
    resize.className = "resize";
    resize.tabIndex = 0;
    resize.setAttribute("role", "separator");
    resize.setAttribute("aria-label", "Resize assistant. Use arrow keys.");
    surface.append(header, context, thread, empty, live, footer, status, resize);
    this.#root.replaceChildren(style, launcher, surface);
    this.#refs = {
      launcher, surface, header, avatar, name, identity, context, thread, empty, live, composer,
      send, voice, attach, fileInput, expand, close, stop, resize, status,
    };

    launcher.addEventListener("click", () => this.open());
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
    this.#setCssVariable("--widget-primary", branding.primaryColor);
    this.#setCssVariable("--widget-accent", branding.accentColor);
    this.#setCssVariable("--widget-surface", branding.surfaceColor);
    this.#setCssVariable("--widget-text", branding.textColor);
    this.#setCssVariable("--widget-font", this.#fontValue(branding.fontFamily));
    this.#refs.launcher.setAttribute("aria-label", `${branding.launcherLabel}${this.#state.unread ? `, ${this.#state.unread} unread` : ""}`);
    this.#refs.launcher.textContent = this.#state.unread ? String(Math.min(this.#state.unread, 9)) : "✦";
    this.#refs.name.textContent = branding.assistantName;
    this.#refs.identity.textContent = this.#identityLabel();
    this.#refs.context.textContent = this.#contextLabel();
    this.#refs.context.hidden = !this.#refs.context.textContent;
    this.#refs.empty.textContent = branding.welcomeCopy;
    this.#refs.empty.hidden = this.#state.conversation.items.length > 0;
    this.#refs.live.textContent = this.#state.liveCaption;
    this.#refs.live.hidden = !this.#state.liveCaption;
    this.#refs.composer.value = this.#state.draft;
    this.#refs.voice.hidden = !branding.voiceEnabled || !this.#config?.adapter.startVoice;
    this.#refs.voice.textContent = this.#state.modality === "voice" ? "◼" : "◉";
    this.#refs.voice.setAttribute(
      "aria-label",
      this.#state.modality === "voice" ? "End voice mode" : "Start voice mode",
    );
    this.#refs.attach.hidden = !this.#config?.adapter.uploadFiles;
    this.#refs.expand.textContent = this.#state.desktopPresentation === "expanded" ? "↙" : "↗";
    this.#refs.expand.setAttribute(
      "aria-label",
      this.#state.desktopPresentation === "expanded" ? "Restore assistant" : "Expand assistant",
    );
    this.#refs.status.textContent = this.#statusLabel();
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
      const article = document.createElement("article");
      article.className = `message ${item.role}`;
      article.dataset.status = item.status;
      article.setAttribute("aria-label", `${item.role === "assistant" ? this.#state.branding.assistantName : "You"} message`);
      for (const part of item.parts) {
        article.append(this.#renderPart(part));
      }
      fragment.append(article);
    }
    this.#refs.thread.replaceChildren(fragment);
    this.#refs.thread.scrollTop = this.#refs.thread.scrollHeight;
  }

  #renderPart(part: WidgetPart): HTMLElement {
    if (part.kind === "text") {
      const paragraph = document.createElement("p");
      paragraph.textContent = part.text;
      return paragraph;
    }
    if (part.kind === "attachment") {
      const chip = document.createElement("div");
      chip.className = "attachment";
      chip.textContent = `${part.filename} · ${part.status}${part.error ? ` · ${part.error}` : ""}`;
      chip.setAttribute("aria-label", `${part.filename}, ${part.status}`);
      return chip;
    }
    if (part.kind === "source") {
      const link = document.createElement("a");
      link.className = "source";
      link.textContent = part.title;
      const href = safeUrl(part.url);
      if (href) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      return link;
    }
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

  #renderLayout(): void {
    if (!this.#refs) return;
    const { surface, launcher } = this.#refs;
    const { branding, layout, presentation } = this.#state;
    launcher.classList.toggle("left", branding.launcherPosition === "bottom-left");
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
        if (!this.#state.conversation.items.some((item) => item.id === event.item.id)) {
          this.#state.conversation.items.push({
            ...event.item,
            parts: event.item.parts.map((part) => ({ ...part })),
          });
        }
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
:host{--widget-primary:#176b5b;--widget-accent:#d9f2ea;--widget-surface:#fff;--widget-text:#18211f;--widget-font:system-ui,sans-serif;all:initial;position:fixed;z-index:2147483000;font-family:var(--widget-font);color:var(--widget-text);line-height:1.4;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
button,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:focus-visible,textarea:focus-visible,[tabindex]:focus-visible,a:focus-visible{outline:3px solid var(--widget-primary);outline-offset:2px}
.launcher{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom));width:60px;height:60px;border:0;border-radius:50%;background:var(--widget-primary);color:#fff;box-shadow:0 12px 36px #0003;font-size:24px;transition:transform .18s ease}
.launcher:hover{transform:translateY(-2px)}
.launcher.left{left:24px;right:auto}
.surface{position:fixed;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto auto;overflow:hidden;background:var(--widget-surface);border:1px solid color-mix(in srgb,var(--widget-text) 14%,transparent);border-radius:22px;box-shadow:0 22px 70px #0003}
.surface[hidden],.launcher[hidden]{display:none}
.surface[data-presentation=expanded]{inset:5vh 5vw;width:90vw;height:90vh}
.surface[data-presentation=mobile-sheet]{inset:0;width:100vw;height:100dvh;border:0;border-radius:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.header{min-height:66px;display:flex;align-items:center;gap:11px;padding:12px 14px;border-bottom:1px solid color-mix(in srgb,var(--widget-text) 10%,transparent);touch-action:none}
.avatar{display:grid;place-items:center;width:40px;height:40px;border-radius:13px;background:var(--widget-accent);color:var(--widget-primary);font-weight:750;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.heading{display:flex;min-width:0;flex:1;flex-direction:column}
.heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.identity{font-size:12px;opacity:.68}
.actions,.controls{display:flex;align-items:center;gap:7px}
.icon,.send{border:0;border-radius:11px;background:transparent;min-width:40px;min-height:40px}
.icon:hover{background:color-mix(in srgb,var(--widget-text) 7%,transparent)}
.send{background:var(--widget-primary);color:#fff;padding:0 16px;font-weight:650}
.context{padding:8px 15px;background:var(--widget-accent);color:var(--widget-text);font-size:12px}
.thread{overflow:auto;padding:18px;overscroll-behavior:contain}
.empty{align-self:center;margin:auto;padding:24px;text-align:center;font-size:19px;font-weight:600}
.message{width:fit-content;max-width:88%;margin:0 0 12px;padding:10px 13px;border-radius:16px;background:color-mix(in srgb,var(--widget-text) 6%,var(--widget-surface))}
.message.user{margin-left:auto;background:var(--widget-primary);color:#fff}
.message[data-status=streaming]::after{content:"";display:inline-block;width:5px;height:14px;margin-left:3px;background:currentColor;animation:blink 1s step-end infinite}
.message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.attachment{margin-top:5px;padding:7px 9px;border:1px solid currentColor;border-radius:9px;font-size:12px}
.source{display:block;margin-top:7px;color:inherit;text-decoration:underline}
.diagram{margin:8px 0 0}
.diagram img{display:block;max-width:100%;max-height:340px;border-radius:10px}
.diagram figcaption{margin-top:5px;font-size:12px;opacity:.75}
.live{margin:0 15px 8px;padding:8px 11px;border-radius:10px;background:var(--widget-accent);font-size:13px}
.footer{padding:10px 12px;border-top:1px solid color-mix(in srgb,var(--widget-text) 10%,transparent)}
.footer textarea{display:block;width:100%;min-height:54px;max-height:130px;resize:none;border:0;background:transparent;padding:8px;outline:none}
.controls{justify-content:flex-end}
.controls .icon:first-child{margin-right:auto}
.status{min-height:0;padding:0 15px 8px;color:color-mix(in srgb,var(--widget-text) 72%,transparent);font-size:12px}
.status:empty{display:none}
.resize{position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none}
.resize::after{content:"";position:absolute;right:5px;bottom:5px;width:9px;height:9px;border-right:2px solid var(--widget-primary);border-bottom:2px solid var(--widget-primary)}
@keyframes blink{50%{opacity:0}}
@media(max-width:767px){.surface[data-presentation=expanded],.surface[data-presentation=panel]{inset:0;width:100vw;height:100dvh;border:0;border-radius:0}.header{padding-top:max(12px,env(safe-area-inset-top))}.launcher{right:18px;bottom:calc(18px + env(safe-area-inset-bottom))}.launcher.left{left:18px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;
