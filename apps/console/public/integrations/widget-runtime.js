(()=>{"use strict";
const FALLBACK_BRANDING = {
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
const DEFAULT_LAYOUT = { x: 0, y: 0, width: 400, height: 620 };
const MIN_WIDTH = 320;
const MIN_HEIGHT = 420;
const VIEWPORT_GUTTER = 12;
const MOBILE_BREAKPOINT = 768;
const STORAGE_PREFIX = "course-ai-widget:v1";
const HTMLElementBase = globalThis.HTMLElement ??
    class extends EventTarget {
        style = { display: "" };
        dataset = {};
        isConnected = false;
        attachShadow() {
            throw new Error("shadow_dom_unavailable");
        }
        getAttribute() {
            return null;
        }
    };
function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${random}`;
}
function now() {
    return new Date().toISOString();
}
function pageContext() {
    return {
        href: globalThis.location?.href ?? "",
        title: globalThis.document?.title ?? "",
    };
}
function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
function viewport() {
    return {
        width: Math.max(globalThis.innerWidth || 1024, MIN_WIDTH),
        height: Math.max(globalThis.innerHeight || 768, MIN_HEIGHT),
    };
}
function isMobileViewport() {
    return viewport().width < MOBILE_BREAKPOINT;
}
function safeColor(value, fallback) {
    if (!value)
        return fallback;
    const trimmed = value.trim();
    return /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i.test(trimmed) ? trimmed : fallback;
}
function safeUrl(value) {
    if (!value)
        return undefined;
    try {
        const parsed = new URL(value, globalThis.location?.href ?? "https://invalid.local");
        return parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost")
            ? parsed.href
            : undefined;
    }
    catch {
        return undefined;
    }
}
function validatedIdentity(identity) {
    if (identity?.tier === "verified" || identity?.tier === "self_reported") {
        return {
            tier: identity.tier,
            ...(identity.displayName?.trim() ? { displayName: identity.displayName.trim() } : {}),
        };
    }
    return { tier: "anonymous" };
}
function identityCapabilities(tier) {
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
function mergeBranding(base, update) {
    if (!update)
        return { ...base };
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
        fontFamily: update.fontFamily === "system" || update.fontFamily === "rounded" || update.fontFamily === "serif"
            ? update.fontFamily
            : base.fontFamily,
        welcomeCopy: update.welcomeCopy?.trim() || base.welcomeCopy,
        launcherLabel: update.launcherLabel?.trim() || base.launcherLabel,
        launcherPosition: update.launcherPosition === "bottom-left" || update.launcherPosition === "bottom-right"
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
function emptyConversation(id = makeId("conversation")) {
    return { id, items: [] };
}
function cloneConversation(conversation) {
    return {
        id: conversation.id,
        items: conversation.items.map((item) => ({
            ...item,
            parts: item.parts.map((part) => ({ ...part })),
        })),
    };
}
function storageRead(storage, key) {
    try {
        return storage?.getItem(key) ?? null;
    }
    catch {
        return null;
    }
}
function storageWrite(storage, key, value) {
    try {
        storage?.setItem(key, value);
    }
    catch {
        // Storage denial must not affect the host or active conversation.
    }
}
function createButton(label, className, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    button.textContent = text;
    return button;
}
class CourseAiWidgetElement extends HTMLElementBase {
    static observedAttributes = ["tenant-key"];
    #root;
    #config;
    #storage;
    #abort;
    #voiceControl;
    #generationAbort;
    #configurationVersion = 0;
    #failure = false;
    #connected = false;
    #initialized = false;
    #drag;
    #refs;
    #state = {
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
        }
        catch {
            this.#failure = true;
            this.style.display = "none";
        }
    }
    connectedCallback() {
        this.#connected = true;
        this.#guard("connected", () => {
            if (!this.#root)
                throw new Error("shadow_dom_unavailable");
            if (!this.#initialized) {
                this.#build();
                this.#initialized = true;
            }
            globalThis.addEventListener?.("resize", this.#onViewportChange);
            this.#updatePresentationForViewport();
            this.#render();
        });
    }
    disconnectedCallback() {
        this.#connected = false;
        globalThis.removeEventListener?.("resize", this.#onViewportChange);
        this.#abort?.abort();
        this.#generationAbort?.abort();
        void this.#voiceControl?.stop("unmount").catch(() => undefined);
        this.#voiceControl = undefined;
    }
    attributeChangedCallback(name, _oldValue, newValue) {
        if (name === "tenant-key" && newValue && this.#config && this.#config.tenantKey !== newValue) {
            void this.configure({ ...this.#config, tenantKey: newValue });
        }
    }
    async configure(configuration) {
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
            let bootstrap;
            try {
                bootstrap = await configuration.adapter.bootstrap({
                    tenantKey: configuration.tenantKey,
                    ...(resumeConversationId ? { conversationId: resumeConversationId } : {}),
                    page: pageContext(),
                    signal: this.#abort.signal,
                });
            }
            catch (error) {
                if (configurationVersion !== this.#configurationVersion)
                    return;
                throw error;
            }
            if (configurationVersion !== this.#configurationVersion || this.#abort.signal.aborted)
                return;
            if (!bootstrap.conversation.id)
                throw new Error("invalid_conversation");
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
    open() {
        this.#guard("open", () => {
            this.#setDesktopPresentation("panel");
            this.#state.unread = 0;
            this.#render();
            queueMicrotask(() => this.#refs?.composer.focus());
        });
    }
    close() {
        this.#guard("close", () => {
            if (this.#state.modality === "voice")
                void this.endVoice("user");
            this.#setDesktopPresentation("launcher");
            this.#render();
            queueMicrotask(() => this.#refs?.launcher.focus());
        });
    }
    expand() {
        this.#guard("expand", () => {
            this.#setDesktopPresentation("expanded");
            this.#render();
        });
    }
    restore() {
        this.#guard("restore", () => {
            this.#setDesktopPresentation("panel");
            this.#render();
        });
    }
    setModality(modality) {
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
    moveBy(deltaX, deltaY) {
        this.#guard("move", () => {
            if (isMobileViewport() || this.#state.desktopPresentation !== "panel")
                return;
            this.#state.layout.x += deltaX;
            this.#state.layout.y += deltaY;
            this.#clampLayout();
            this.#persistLayout();
            this.#renderLayout();
        });
    }
    resizeBy(deltaWidth, deltaHeight) {
        this.#guard("resize", () => {
            if (isMobileViewport() || this.#state.desktopPresentation !== "panel")
                return;
            this.#state.layout.width += deltaWidth;
            this.#state.layout.height += deltaHeight;
            this.#clampLayout();
            this.#persistLayout();
            this.#renderLayout();
        });
    }
    updateBranding(branding) {
        this.#guard("branding", () => {
            this.#state.branding = mergeBranding(this.#state.branding, branding);
            this.#render();
        });
    }
    updateLearningContext(context) {
        this.#guard("context", () => {
            this.#state.learningContext = context;
            this.#render();
        });
    }
    setDraft(draft) {
        this.#guard("draft", () => {
            this.#state.draft = draft;
            this.#persistResumeState();
            if (this.#refs && this.#refs.composer.value !== draft)
                this.#refs.composer.value = draft;
        });
    }
    getSnapshot() {
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
    receive(event) {
        this.#guard("event", () => this.#receiveEvent(event));
    }
    async send(text = this.#state.draft) {
        await this.#guardAsync("send", async () => {
            const cleanText = text.trim();
            if (!cleanText || !this.#config)
                return;
            const conversationId = this.#state.conversation.id;
            const userItem = {
                id: makeId("message"),
                sequence: this.#nextSequence(),
                role: "user",
                modality: this.#state.modality,
                status: "complete",
                parts: [{ kind: "text", text: cleanText }],
                createdAt: now(),
            };
            this.#state.conversation.items.push(userItem);
            const attachmentIds = this.#state.conversation.items.flatMap((item) => item.parts
                .filter((part) => part.kind === "attachment" && part.status === "ready")
                .map((part) => part.id));
            this.#state.draft = "";
            this.#generationAbort?.abort();
            this.#generationAbort = new AbortController();
            const configurationVersion = this.#configurationVersion;
            this.#persistResumeState();
            this.#render();
            try {
                await this.#config.adapter.sendText({
                    conversationId,
                    text: cleanText,
                    page: pageContext(),
                    attachmentIds,
                    signal: this.#generationAbort.signal,
                }, (event) => {
                    if (configurationVersion === this.#configurationVersion)
                        this.receive(event);
                });
            }
            catch (error) {
                if (configurationVersion !== this.#configurationVersion)
                    return;
                userItem.status = "failed";
                this.#state.draft = cleanText;
                this.#persistResumeState();
                this.#render();
                throw error;
            }
        }, false);
    }
    async retryLastFailed() {
        let failed;
        for (let index = this.#state.conversation.items.length - 1; index >= 0; index -= 1) {
            const candidate = this.#state.conversation.items[index];
            if (candidate?.role === "user" && candidate.status === "failed") {
                failed = candidate;
                break;
            }
        }
        const text = failed?.parts.find((part) => part.kind === "text")?.text;
        if (!failed || !text)
            return;
        this.#state.conversation.items = this.#state.conversation.items.filter((item) => item.id !== failed.id);
        await this.send(text);
    }
    async startVoice(mode = "tap-to-start") {
        await this.#guardAsync("voice_start", async () => {
            if (!this.#config?.adapter.startVoice || !this.#state.branding.voiceEnabled)
                return;
            this.#state.modality = "voice";
            this.#state.voiceState = "permission";
            this.#render();
            const configurationVersion = this.#configurationVersion;
            try {
                this.#voiceControl = await this.#config.adapter.startVoice({
                    conversationId: this.#state.conversation.id,
                    mode,
                    signal: this.#abort?.signal ?? new AbortController().signal,
                }, (event) => {
                    if (configurationVersion === this.#configurationVersion)
                        this.receive(event);
                });
            }
            catch (error) {
                if (configurationVersion !== this.#configurationVersion)
                    return;
                throw error;
            }
            this.#persistResumeState();
        }, false);
    }
    async endVoice(reason = "user") {
        await this.#guardAsync("voice_end", async () => {
            try {
                await this.#voiceControl?.stop(reason);
            }
            finally {
                this.#voiceControl = undefined;
                this.#state.modality = "text";
                this.#state.voiceState = "idle";
                this.#state.liveCaption = "";
                this.#persistResumeState();
                this.#render();
            }
        }, false);
    }
    #build() {
        if (!this.#root)
            return;
        const style = document.createElement("style");
        style.textContent = STYLES;
        const launcher = createButton("Open learning assistant", "launcher", "");
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
        const expand = createButton("Expand assistant", "icon headerIcon", "↗");
        const close = createButton("Close assistant", "icon headerIcon", "×");
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
        const attach = createButton("Attach files", "icon attach", "＋");
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.hidden = true;
        const voice = createButton("Start voice mode", "icon voice", "Voice");
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
        expand.addEventListener("click", () => this.#state.desktopPresentation === "expanded" ? this.restore() : this.expand());
        send.addEventListener("click", () => void this.send());
        stop.addEventListener("click", () => void this.#stopGeneration());
        voice.addEventListener("click", () => this.#state.modality === "voice" ? void this.endVoice() : void this.startVoice());
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
            if (files?.length)
                void this.#uploadFiles(files);
        });
    }
    #render() {
        if (!this.#refs || this.#failure)
            return;
        const { branding } = this.#state;
        this.#setCssVariable("--widget-primary", branding.primaryColor);
        this.#setCssVariable("--widget-accent", branding.accentColor);
        this.#setCssVariable("--widget-surface", branding.surfaceColor);
        this.#setCssVariable("--widget-text", branding.textColor);
        this.#setCssVariable("--widget-font", this.#fontValue(branding.fontFamily));
        this.#refs.launcher.setAttribute("aria-label", `${branding.launcherLabel}${this.#state.unread ? `, ${this.#state.unread} unread` : ""}`);
        this.#refs.launcher.dataset.unread = String(this.#state.unread > 0);
        this.#refs.launcher.textContent = this.#state.unread ? String(Math.min(this.#state.unread, 9)) : "";
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
        this.#refs.voice.textContent = this.#state.modality === "voice" ? "End voice" : "Voice";
        this.#refs.voice.setAttribute("aria-label", this.#state.modality === "voice" ? "End voice mode" : "Start voice mode");
        this.#refs.attach.hidden = !this.#config?.adapter.uploadFiles;
        this.#refs.expand.textContent = this.#state.desktopPresentation === "expanded" ? "↙" : "↗";
        this.#refs.expand.setAttribute("aria-label", this.#state.desktopPresentation === "expanded" ? "Restore assistant" : "Expand assistant");
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
    #renderAvatar() {
        if (!this.#refs)
            return;
        this.#refs.avatar.replaceChildren();
        const source = this.#state.branding.avatarUrl ?? this.#state.branding.logoUrl;
        if (source) {
            const image = document.createElement("img");
            image.src = source;
            image.alt = "";
            image.referrerPolicy = "no-referrer";
            this.#refs.avatar.append(image);
        }
        else {
            this.#refs.avatar.textContent = this.#state.branding.assistantName.slice(0, 1).toUpperCase();
        }
    }
    #renderThread() {
        if (!this.#refs)
            return;
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
    #renderPart(part) {
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
            link.textContent = `Source · ${part.title}`;
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
    #renderLayout() {
        if (!this.#refs)
            return;
        const { surface, launcher } = this.#refs;
        const { branding, layout, presentation } = this.#state;
        launcher.classList.toggle("left", branding.launcherPosition === "bottom-left");
        surface.dataset.presentation = presentation;
        if (presentation === "panel") {
            surface.style.left = `${layout.x}px`;
            surface.style.top = `${layout.y}px`;
            surface.style.width = `${layout.width}px`;
            surface.style.height = `${layout.height}px`;
        }
        else {
            surface.style.removeProperty("left");
            surface.style.removeProperty("top");
            surface.style.removeProperty("width");
            surface.style.removeProperty("height");
        }
    }
    #receiveEvent(event) {
        if (event.conversationId !== this.#state.conversation.id)
            return;
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
                const textPart = item.parts.find((part) => part.kind === "text");
                if (textPart)
                    textPart.text += event.text;
                else
                    item.parts.push({ kind: "text", text: event.text });
                item.status = "streaming";
                break;
            }
            case "response.complete":
            case "response.interrupted": {
                const item = this.#state.conversation.items.find((candidate) => candidate.id === event.itemId);
                if (item)
                    item.status = event.type === "response.complete" ? "complete" : "interrupted";
                this.#state.voiceState = this.#state.modality === "voice" ? "listening" : "idle";
                if (this.#state.presentation === "launcher")
                    this.#state.unread += 1;
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
    #upsertAttachment(attachment) {
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
    async #uploadFiles(files) {
        await this.#guardAsync("upload", async () => {
            if (!files?.length || !this.#config?.adapter.uploadFiles)
                return;
            const configurationVersion = this.#configurationVersion;
            try {
                await this.#config.adapter.uploadFiles({
                    conversationId: this.#state.conversation.id,
                    files: Array.from(files),
                    signal: this.#abort?.signal ?? new AbortController().signal,
                }, (event) => {
                    if (configurationVersion === this.#configurationVersion)
                        this.receive(event);
                });
            }
            catch (error) {
                if (configurationVersion !== this.#configurationVersion)
                    return;
                throw error;
            }
        }, false);
    }
    async #stopGeneration() {
        await this.#guardAsync("stop", async () => {
            this.#generationAbort?.abort();
            let streaming;
            for (let index = this.#state.conversation.items.length - 1; index >= 0; index -= 1) {
                const candidate = this.#state.conversation.items[index];
                if (candidate?.status === "streaming") {
                    streaming = candidate;
                    break;
                }
            }
            if (streaming)
                streaming.status = "interrupted";
            if (this.#config?.adapter.stopGeneration) {
                await this.#config.adapter.stopGeneration({
                    conversationId: this.#state.conversation.id,
                    ...(streaming ? { itemId: streaming.id } : {}),
                });
            }
            this.#render();
        }, false);
    }
    #setDesktopPresentation(presentation) {
        this.#state.desktopPresentation = presentation;
        this.#state.presentation = isMobileViewport() && presentation !== "launcher" ? "mobile-sheet" : presentation;
        if (presentation === "panel")
            this.#clampLayout();
        this.#persistLayout();
    }
    #updatePresentationForViewport() {
        this.#clampLayout();
        this.#state.presentation =
            isMobileViewport() && this.#state.desktopPresentation !== "launcher"
                ? "mobile-sheet"
                : this.#state.desktopPresentation;
        this.#render();
    }
    #clampLayout() {
        const bounds = viewport();
        this.#state.layout.width = clamp(this.#state.layout.width, MIN_WIDTH, bounds.width - VIEWPORT_GUTTER * 2);
        this.#state.layout.height = clamp(this.#state.layout.height, MIN_HEIGHT, bounds.height - VIEWPORT_GUTTER * 2);
        this.#state.layout.x = clamp(this.#state.layout.x || bounds.width - this.#state.layout.width - 24, VIEWPORT_GUTTER, bounds.width - this.#state.layout.width - VIEWPORT_GUTTER);
        this.#state.layout.y = clamp(this.#state.layout.y || bounds.height - this.#state.layout.height - 24, VIEWPORT_GUTTER, bounds.height - this.#state.layout.height - VIEWPORT_GUTTER);
    }
    #beginPointerDrag(kind, event) {
        if (isMobileViewport() || this.#state.desktopPresentation !== "panel")
            return;
        if (kind === "move" && event.target?.closest?.("button"))
            return;
        event.preventDefault();
        event.currentTarget?.setPointerCapture?.(event.pointerId);
        this.#drag = {
            kind,
            startX: event.clientX,
            startY: event.clientY,
            layout: { ...this.#state.layout },
        };
    }
    #onPointerMove = (event) => {
        if (!this.#drag)
            return;
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
    #endPointerDrag = () => {
        if (!this.#drag)
            return;
        this.#drag = undefined;
        this.#persistLayout();
    };
    #onMoveKeyDown = (event) => {
        const step = event.shiftKey ? 40 : 10;
        const deltas = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        };
        const delta = deltas[event.key];
        if (!delta)
            return;
        event.preventDefault();
        this.moveBy(delta[0], delta[1]);
    };
    #onResizeKeyDown = (event) => {
        const step = event.shiftKey ? 40 : 10;
        const deltas = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        };
        const delta = deltas[event.key];
        if (!delta)
            return;
        event.preventDefault();
        this.resizeBy(delta[0], delta[1]);
    };
    #onSurfaceKeyDown = (event) => {
        if (event.key !== "Escape")
            return;
        if (this.#state.modality === "voice")
            void this.endVoice();
        else if (this.#state.desktopPresentation === "expanded")
            this.restore();
        else
            this.close();
    };
    #onViewportChange = () => this.#guard("viewport", () => this.#updatePresentationForViewport());
    #identityLabel() {
        if (this.#state.identity.tier === "verified")
            return "Verified learner";
        if (this.#state.identity.tier === "self_reported")
            return "Identity not verified";
        return "Anonymous";
    }
    #contextLabel() {
        const context = this.#state.learningContext;
        if (context.status === "ambiguous")
            return "Learning context is unclear";
        if (context.status === "stale")
            return "Learning context may be out of date";
        if (context.status === "unknown")
            return "";
        const hierarchy = [context.course, context.module, context.lesson].filter(Boolean).join(" · ");
        return hierarchy ? `Currently learning: ${hierarchy}` : "";
    }
    #statusLabel() {
        if (this.#state.connection === "offline")
            return "Offline. Your draft is preserved.";
        if (this.#state.connection === "reconnecting")
            return "Reconnecting…";
        if (this.#state.modality === "voice") {
            const labels = {
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
    #fontValue(font) {
        if (font === "serif")
            return "ui-serif, Georgia, serif";
        if (font === "rounded")
            return "ui-rounded, system-ui, sans-serif";
        return "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    }
    #setCssVariable(name, value) {
        this.#root?.host?.style.setProperty(name, value);
    }
    #nextSequence() {
        return Math.max(0, ...this.#state.conversation.items.map((item) => item.sequence)) + 1;
    }
    #storageKey(suffix) {
        return `${STORAGE_PREFIX}:${this.#config?.tenantKey ?? "unconfigured"}:${suffix}`;
    }
    #defaultStorage() {
        try {
            return globalThis.localStorage;
        }
        catch {
            return undefined;
        }
    }
    #loadPersistedState() {
        const layout = storageRead(this.#storage, this.#storageKey("layout"));
        if (layout) {
            try {
                const parsed = JSON.parse(layout);
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
            }
            catch {
                // Corrupt host storage is ignored.
            }
        }
        const resume = storageRead(this.#storage, this.#storageKey("resume"));
        if (resume) {
            try {
                const parsed = JSON.parse(resume);
                this.#state.draft = typeof parsed.draft === "string" ? parsed.draft : "";
                this.#state.modality = parsed.modality === "voice" ? "text" : parsed.modality ?? "text";
            }
            catch {
                // Corrupt host storage is ignored.
            }
        }
        this.#clampLayout();
        this.#updatePresentationForViewport();
    }
    #resumeConversationId() {
        const resume = storageRead(this.#storage, this.#storageKey("resume"));
        if (!resume)
            return undefined;
        try {
            const parsed = JSON.parse(resume);
            return typeof parsed.conversationId === "string" ? parsed.conversationId : undefined;
        }
        catch {
            return undefined;
        }
    }
    #persistLayout() {
        if (!this.#config)
            return;
        storageWrite(this.#storage, this.#storageKey("layout"), JSON.stringify({ ...this.#state.layout, desktopPresentation: this.#state.desktopPresentation }));
    }
    #persistResumeState() {
        if (!this.#config)
            return;
        storageWrite(this.#storage, this.#storageKey("resume"), JSON.stringify({
            conversationId: this.#state.conversation.id,
            draft: this.#state.draft,
            modality: this.#state.modality,
        }));
    }
    #dispatch(name, detail) {
        try {
            this.dispatchEvent(new CustomEvent(`course-ai:${name}`, { detail, bubbles: false, composed: false }));
        }
        catch {
            // Event dispatch is advisory and isolated from the host.
        }
    }
    #guard(name, operation) {
        if (this.#failure)
            return;
        try {
            operation();
        }
        catch {
            this.#failSilent(`widget_${name}_failed`);
        }
    }
    async #guardAsync(name, operation, fatal = true) {
        if (this.#failure)
            return;
        try {
            await operation();
        }
        catch (error) {
            if (error instanceof DOMException && error.name === "AbortError")
                return;
            if (fatal)
                this.#failSilent(`widget_${name}_failed`);
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
    #failSilent(code) {
        this.#failure = true;
        this.style.display = "none";
        this.#reportHealth(code);
    }
    #reportHealth(code) {
        try {
            this.#config?.adapter.reportHealth?.({
                code,
                ...(this.#config ? { tenantKey: this.#config.tenantKey } : {}),
            });
        }
        catch {
            // Host telemetry implementations are never trusted to remain exception-free.
        }
    }
}
function registerCourseAiWidget(tagName = "course-ai-widget") {
    try {
        if (!globalThis.customElements || globalThis.customElements.get(tagName))
            return Boolean(globalThis.customElements?.get(tagName));
        globalThis.customElements.define(tagName, CourseAiWidgetElement);
        return true;
    }
    catch {
        return false;
    }
}
function autoMountCourseAiWidget() {
    try {
        if (!globalThis.document || document.querySelector("course-ai-widget"))
            return undefined;
        const script = document.currentScript;
        const tenantKey = script?.dataset.tenant;
        if (!tenantKey)
            return undefined;
        registerCourseAiWidget();
        const widget = document.createElement("course-ai-widget");
        widget.setAttribute("tenant-key", tenantKey);
        document.body.append(widget);
        const adapter = globalThis.CourseAiWidgetAdapter;
        if (adapter)
            void widget.configure({ tenantKey, adapter });
        return widget;
    }
    catch {
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
.launcher{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom));isolation:isolate;width:64px;height:64px;overflow:hidden;border:1px solid #ffffffb8;border-radius:45% 55% 52% 48%/46% 44% 56% 54%;background:radial-gradient(circle at 32% 25%,#fff 0 7%,#fff8 8% 13%,transparent 30%),radial-gradient(circle at 68% 72%,color-mix(in srgb,var(--widget-accent) 86%,#84d8ff) 0 8%,transparent 44%),conic-gradient(from 210deg,color-mix(in srgb,var(--widget-primary) 88%,#071e1a),#67d8bf,#d7b9ff,#7bb8ff,var(--widget-primary));color:#fff;box-shadow:0 18px 42px color-mix(in srgb,var(--widget-primary) 34%,transparent),inset 0 0 0 1px #ffffff70;font-size:13px;font-weight:800;transition:transform .24s ease,box-shadow .24s ease;animation:orbFloat 5.5s ease-in-out infinite}
.launcher::before{position:absolute;z-index:-1;inset:8px;border-radius:47% 53% 43% 57%/55% 42% 58% 45%;background:radial-gradient(circle at 40% 32%,#ffffffec,transparent 18%),linear-gradient(145deg,#ffffff82,transparent 38% 65%,#ffffff55);filter:blur(.5px);content:"";animation:orbTurn 7s linear infinite}
.launcher::after{position:absolute;z-index:-2;inset:-8px;border-radius:inherit;background:inherit;filter:blur(12px);opacity:.36;content:""}
.launcher:hover{transform:translateY(-3px) scale(1.025);box-shadow:0 22px 52px color-mix(in srgb,var(--widget-primary) 42%,transparent),inset 0 0 0 1px #ffffff8f}
.launcher[data-unread=false]{font-size:0}
.launcher.left{left:24px;right:auto}
.surface{container-type:inline-size;container-name:caiw;position:fixed;isolation:isolate;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto auto;overflow:hidden;background:color-mix(in srgb,var(--widget-surface) 97%,transparent);border:1px solid color-mix(in srgb,var(--widget-text) 10%,transparent);border-radius:26px;box-shadow:0 28px 90px color-mix(in srgb,var(--widget-text) 20%,transparent),0 2px 12px #0000000d;backdrop-filter:blur(26px) saturate(1.08)}
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
.icon,.send{min-width:40px;min-height:40px;border:0;border-radius:12px;background:transparent}
.icon:hover{background:color-mix(in srgb,var(--widget-text) 6%,transparent)}
.headerIcon{min-width:36px;min-height:36px;color:color-mix(in srgb,var(--widget-text) 70%,transparent);font-size:18px}
.send{background:var(--widget-primary);color:#fff;padding:0 17px;font-size:12px;font-weight:720;box-shadow:0 8px 18px color-mix(in srgb,var(--widget-primary) 22%,transparent)}
.context{margin:10px 14px 0;padding:8px 11px;overflow:hidden;border:1px solid color-mix(in srgb,var(--widget-primary) 10%,transparent);border-radius:11px;background:color-mix(in srgb,var(--widget-accent) 54%,var(--widget-surface));color:color-mix(in srgb,var(--widget-text) 78%,transparent);font-size:10px;font-weight:620;text-overflow:ellipsis;white-space:nowrap}
.thread{overflow:auto;padding:18px 17px 8px;overscroll-behavior:contain;scrollbar-color:color-mix(in srgb,var(--widget-primary) 20%,transparent) transparent;scrollbar-width:thin}
.empty{align-self:center;max-width:320px;margin:auto;padding:30px 25px 24px;text-align:center;font-size:21px;font-weight:650;letter-spacing:-.025em;line-height:1.28}
.empty::before{display:block;width:44px;height:44px;margin:0 auto 18px;border-radius:48% 52% 45% 55%/53% 44% 56% 47%;background:radial-gradient(circle at 35% 27%,#fff 0 8%,transparent 26%),conic-gradient(from 190deg,var(--widget-primary),color-mix(in srgb,var(--widget-accent) 72%,#75dfff),#d9b9ff,var(--widget-primary));box-shadow:0 12px 30px color-mix(in srgb,var(--widget-primary) 24%,transparent);content:"";animation:orbFloat 5.5s ease-in-out infinite}
.empty::after{display:block;margin:11px auto 0;color:color-mix(in srgb,var(--widget-text) 55%,transparent);font-size:11px;font-weight:500;letter-spacing:0;line-height:1.5;content:"Answers include the published learning sources behind them."}
.message{width:fit-content;max-width:90%;margin:0 0 16px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--widget-text) 7%,transparent);border-radius:17px;background:color-mix(in srgb,var(--widget-text) 4%,var(--widget-surface));font-size:13px;line-height:1.55;box-shadow:0 5px 15px #00000008}
.message.assistant{width:auto;max-width:100%;padding-right:8px;padding-left:8px;border-color:transparent;background:transparent;box-shadow:none}
.message.user{margin-left:auto;border-color:transparent;background:var(--widget-primary);color:#fff;box-shadow:0 9px 22px color-mix(in srgb,var(--widget-primary) 20%,transparent)}
.message[data-status=streaming]::after{content:"";display:inline-block;width:5px;height:14px;margin-left:3px;background:currentColor;animation:blink 1s step-end infinite}
.message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.attachment{margin-top:8px;padding:8px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;background:color-mix(in srgb,var(--widget-surface) 70%,transparent);font-size:11px}
.source{display:flex;width:fit-content;align-items:center;gap:5px;margin-top:10px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--widget-primary) 15%,transparent);border-radius:999px;background:color-mix(in srgb,var(--widget-accent) 42%,var(--widget-surface));color:var(--widget-primary);font-size:10px;font-weight:680;text-decoration:none}
.source::after{content:"↗";font-size:10px}
.source:hover{text-decoration:underline}
.diagram{margin:8px 0 0}
.diagram img{display:block;max-width:100%;max-height:340px;border:1px solid color-mix(in srgb,var(--widget-text) 8%,transparent);border-radius:14px}
.diagram figcaption{margin-top:5px;font-size:12px;opacity:.75}
.live{position:relative;margin:0 15px 8px;padding:10px 12px 10px 35px;border:1px solid color-mix(in srgb,var(--widget-primary) 14%,transparent);border-radius:13px;background:color-mix(in srgb,var(--widget-accent) 54%,var(--widget-surface));font-size:12px}
.live::before{position:absolute;left:13px;top:50%;width:10px;height:10px;border-radius:50%;background:var(--widget-primary);box-shadow:0 0 0 5px color-mix(in srgb,var(--widget-primary) 12%,transparent);content:"";transform:translateY(-50%);animation:listenPulse 1.4s ease-in-out infinite}
.footer{margin:0 12px 11px;padding:7px 7px 7px 10px;border:1px solid color-mix(in srgb,var(--widget-text) 11%,transparent);border-radius:17px;background:color-mix(in srgb,var(--widget-surface) 92%,transparent);box-shadow:0 8px 28px #0000000a}
.footer:focus-within{border-color:color-mix(in srgb,var(--widget-primary) 38%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--widget-primary) 9%,transparent),0 10px 30px #0000000b}
.footer textarea{display:block;width:100%;min-height:49px;max-height:130px;resize:none;border:0;background:transparent;padding:8px 7px;outline:none;font-size:13px;line-height:1.45}
.footer textarea::placeholder{color:color-mix(in srgb,var(--widget-text) 45%,transparent)}
.controls{justify-content:flex-end}
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
@keyframes orbFloat{0%,100%{border-radius:45% 55% 52% 48%/46% 44% 56% 54%;transform:translateY(0) rotate(0)}50%{border-radius:54% 46% 43% 57%/43% 57% 43% 57%;transform:translateY(-2px) rotate(2deg)}}
@keyframes orbTurn{to{transform:rotate(360deg)}}
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

try{const api=typeof globalThis.CourseAiWidgetRuntime==="object"&&globalThis.CourseAiWidgetRuntime!==null?globalThis.CourseAiWidgetRuntime:{};Object.assign(api,{CourseAiWidgetElement,autoMountCourseAiWidget,registerCourseAiWidget});globalThis.CourseAiWidgetRuntime=api;registerCourseAiWidget();autoMountCourseAiWidget();}catch{}
})();
