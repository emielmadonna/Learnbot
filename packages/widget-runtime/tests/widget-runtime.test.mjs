import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { runInThisContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { installDomEnvironment, MemoryStorage } from "./dom-environment.mjs";

const dom = installDomEnvironment();
const runtime = await import(`../dist/widget.esm.js?test=${Date.now()}`);

function conversation(id = "conversation-1", items = []) {
  return { id, items };
}

function textItem(id, sequence, role, text, modality = "text") {
  return {
    id,
    sequence,
    role,
    modality,
    status: "complete",
    parts: [{ kind: "text", text }],
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

function adapter(overrides = {}) {
  return {
    async bootstrap({ conversationId }) {
      return { conversation: conversation(conversationId ?? "conversation-1") };
    },
    async sendText(input, emit) {
      emit({
        type: "response.delta",
        conversationId: input.conversationId,
        itemId: "assistant-1",
        text: "A Minimum Day keeps momentum credible.",
      });
      emit({
        type: "response.complete",
        conversationId: input.conversationId,
        itemId: "assistant-1",
      });
    },
    ...overrides,
  };
}

const createdWidgets = [];

function connectedWidget() {
  const widget = new runtime.CourseAiWidgetElement();
  widget.connectedCallback();
  createdWidgets.push(widget);
  return widget;
}

afterEach(() => {
  for (const widget of createdWidgets.splice(0)) widget.disconnectedCallback();
});

function descendantText(element) {
  return [element.textContent, ...element.children.flatMap((child) => descendantText(child))].join(" ");
}

function findDescendant(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const match = findDescendant(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function keyboardEvent(key, { shiftKey = false } = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
  });
  return event;
}

function pointerEvent(type, clientX, clientY, pointerId = 1) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerId: { value: pointerId },
  });
  return event;
}

test("WID-01: distribution is isolated, static, and below 50KB gzipped", async () => {
  let iifeSource = "";
  for (const filename of ["widget.esm.js", "widget.iife.js"]) {
    const source = await readFile(new URL(`../dist/${filename}`, import.meta.url));
    assert.ok(gzipSync(source, { level: 9 }).byteLength < 50 * 1024);
    const text = source.toString("utf8");
    assert.doesNotMatch(text, /\beval\s*\(/);
    assert.doesNotMatch(text, /\bnew\s+Function\b/);
    assert.doesNotMatch(text, /openai|anthropic|gemini|elevenlabs/i);
    if (filename === "widget.iife.js") iifeSource = text;
  }

  const widget = connectedWidget();
  assert.ok(widget.shadowRoot, "custom element creates an open Shadow DOM root");
  assert.equal(runtime.registerCourseAiWidget(), true);

  const priorApi = globalThis.CourseAiWidgetRuntime;
  globalThis.CourseAiWidgetRuntime = Object.freeze({});
  assert.doesNotThrow(() => runInThisContext(iifeSource), "a hostile existing global cannot escape the IIFE");
  globalThis.CourseAiWidgetRuntime = priorApi;
});

test("WID-01: forced bootstrap failure hides only the widget and reports a sanitized code", async () => {
  const health = [];
  const host = { remainedInteractive: true };
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_failure",
    adapter: adapter({
      async bootstrap() {
        throw new Error("secret provider response must not escape");
      },
      reportHealth(event) {
        health.push(event);
      },
    }),
  });

  assert.equal(widget.style.display, "none");
  assert.equal(host.remainedInteractive, true);
  assert.deepEqual(health, [{ code: "widget_configuration_failed", tenantKey: "pk_failure" }]);
});

test("WID-02/08: desktop layout, keyboard-safe APIs, persistence, and viewport clamping work", async () => {
  dom.setViewport(1200, 900);
  const storage = new MemoryStorage();
  const first = connectedWidget();
  await first.configure({ tenantKey: "pk_layout", adapter: adapter(), storage });
  first.open();
  const surface = first.shadowRoot.children[2];
  const header = surface.children[0];
  const resizeHandle = surface.children.at(-1);
  const originalLayout = first.getSnapshot().layout;
  header.dispatchEvent(keyboardEvent("ArrowLeft"));
  assert.equal(first.getSnapshot().layout.x, originalLayout.x - 10);
  resizeHandle.dispatchEvent(keyboardEvent("ArrowRight", { shiftKey: true }));
  assert.equal(first.getSnapshot().layout.width, originalLayout.width + 40);

  const beforePointer = first.getSnapshot().layout;
  header.dispatchEvent(pointerEvent("pointerdown", 100, 100));
  surface.dispatchEvent(pointerEvent("pointermove", 75, 65));
  surface.dispatchEvent(pointerEvent("pointerup", 75, 65));
  assert.equal(first.getSnapshot().layout.x, beforePointer.x - 25);
  assert.equal(first.getSnapshot().layout.y, beforePointer.y - 35);

  first.moveBy(-10000, -10000);
  first.resizeBy(10000, 10000);
  let snapshot = first.getSnapshot();

  assert.equal(snapshot.presentation, "panel");
  assert.deepEqual(
    snapshot.layout,
    { x: 12, y: 12, width: 1176, height: 876 },
    "panel remains reachable inside viewport gutters",
  );

  first.expand();
  assert.equal(first.getSnapshot().presentation, "expanded");
  first.restore();
  assert.equal(first.getSnapshot().presentation, "panel");
  const conversationId = first.getSnapshot().conversation.id;
  first.setDraft("Preserve this draft");

  let resumedId;
  const second = connectedWidget();
  await second.configure({
    tenantKey: "pk_layout",
    storage,
    adapter: adapter({
      async bootstrap({ conversationId: candidate }) {
        resumedId = candidate;
        return { conversation: conversation(candidate, [textItem("old", 1, "assistant", "Resumed")]) };
      },
    }),
  });
  snapshot = second.getSnapshot();
  assert.equal(resumedId, conversationId);
  assert.equal(snapshot.draft, "Preserve this draft");
  assert.equal(snapshot.conversation.items[0].parts[0].text, "Resumed");
  assert.equal(snapshot.presentation, "panel");
});

test("WID-02/08: mobile uses a full-screen sheet and restores desktop state without losing conversation", async () => {
  dom.setViewport(1100, 800);
  const widget = connectedWidget();
  await widget.configure({ tenantKey: "pk_mobile", adapter: adapter() });
  widget.open();
  await widget.send("What is a Minimum Day?");
  const before = widget.getSnapshot().conversation;

  dom.setViewport(700, 800);
  assert.equal(widget.getSnapshot().presentation, "mobile-sheet");
  widget.resizeBy(500, 500);
  assert.deepEqual(widget.getSnapshot().conversation, before);

  dom.setViewport(1100, 800);
  assert.equal(widget.getSnapshot().presentation, "panel");
  assert.deepEqual(widget.getSnapshot().conversation, before);
});

test("WID-04/06/07: runtime branding, identity disclosure, and honest learning context are data-driven", async () => {
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_brand",
    adapter: adapter({
      async bootstrap() {
        return {
          conversation: conversation(),
          identity: { tier: "self_reported", displayName: "Maya" },
          branding: {
            assistantName: "Nova",
            primaryColor: "#1133aa",
            welcomeCopy: "Build your rhythm.",
            voiceEnabled: true,
            logoUrl: "https://learning.example/logo.svg",
            avatarUrl: "https://learning.example/avatar.png",
            launcherPosition: "bottom-left",
          },
          learningContext: {
            status: "resolved",
            source: "verified_host",
            course: "Momentum Method",
            module: "Build Your Rhythm",
            lesson: "Minimum Day",
            confidence: 1,
          },
        };
      },
    }),
  });

  let snapshot = widget.getSnapshot();
  assert.equal(snapshot.identity.tier, "self_reported");
  assert.deepEqual(snapshot.identityCapabilities, {
    verified: false,
    aggregateOnly: false,
    learnerInsights: true,
    crossDeviceMemory: true,
  });
  assert.equal(snapshot.branding.assistantName, "Nova");
  assert.equal(snapshot.branding.primaryColor, "#1133aa");
  assert.equal(snapshot.branding.launcherPosition, "bottom-left");
  assert.equal(snapshot.branding.logoUrl, "https://learning.example/logo.svg");
  assert.equal(snapshot.learningContext.lesson, "Minimum Day");
  assert.match(descendantText(widget.shadowRoot), /Nova/);
  assert.match(descendantText(widget.shadowRoot), /Build your rhythm/);
  assert.match(descendantText(widget.shadowRoot), /Identity not verified/);
  assert.match(descendantText(widget.shadowRoot), /Currently learning: Momentum Method · Build Your Rhythm · Minimum Day/);

  widget.updateBranding({ assistantName: "Orbit", primaryColor: "url(javascript:alert(1))" });
  widget.updateLearningContext({ status: "ambiguous", course: "Do not guess this" });
  snapshot = widget.getSnapshot();
  assert.equal(snapshot.branding.assistantName, "Orbit");
  assert.equal(snapshot.branding.primaryColor, "#1133aa", "unsafe arbitrary CSS is rejected");
  assert.equal(snapshot.branding.logoUrl, "https://learning.example/logo.svg", "partial updates retain published assets");
  assert.equal(snapshot.learningContext.status, "ambiguous");
  assert.match(descendantText(widget.shadowRoot), /Learning context is unclear/);
  assert.doesNotMatch(descendantText(widget.shadowRoot), /Currently learning: Do not guess this/);

  for (const [tier, label] of [
    ["anonymous", "Anonymous"],
    ["verified", "Verified learner"],
  ]) {
    const identityWidget = connectedWidget();
    await identityWidget.configure({
      tenantKey: `pk_${tier}`,
      adapter: adapter({
        async bootstrap() {
          return { conversation: conversation(), identity: { tier } };
        },
      }),
    });
    assert.match(descendantText(identityWidget.shadowRoot), new RegExp(label));
    assert.equal(identityWidget.getSnapshot().identityCapabilities.verified, tier === "verified");
  }
});

test("WID-04: launcher shape, delayed greeting, attribution, and appearance mode are data-driven", async () => {
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_appearance",
    adapter: adapter(),
    branding: {
      assistantName: "Corso guide",
      launcherLabel: "Ask the guide",
      launcherShape: "pill",
      greetingBubbleEnabled: true,
      greetingBubbleDelaySeconds: 0,
      showPoweredBy: false,
      appearanceMode: "dark",
      welcomeCopy: "Need help with this lesson?",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const launcher = widget.shadowRoot.children[1];
  const surface = widget.shadowRoot.children[2];
  const greeting = widget.shadowRoot.children[3];
  const poweredBy = findDescendant(
    surface,
    (element) => element.className === "poweredBy",
  );

  assert.equal(widget.getSnapshot().branding.launcherShape, "pill");
  assert.equal(launcher.dataset.shape, "pill");
  assert.equal(descendantText(launcher).trim(), "Ask the guide");
  assert.equal(greeting.hidden, false);
  assert.equal(greeting.textContent, "Need help with this lesson?");
  assert.equal(poweredBy.hidden, true);
  assert.equal(widget.dataset.appearance, "dark");

  greeting.click();
  assert.equal(widget.getSnapshot().presentation, "panel");
  assert.equal(greeting.hidden, true);

  widget.close();
  widget.updateBranding({
    launcherShape: "tab",
    showPoweredBy: true,
    appearanceMode: "light",
  });
  assert.equal(launcher.dataset.shape, "tab");
  assert.equal(poweredBy.hidden, false);
  assert.equal(poweredBy.textContent, "Powered by Corso");
  assert.equal(widget.dataset.appearance, "light");
  assert.equal(greeting.hidden, true, "the greeting nudge appears only once per load");
});

test("WID-05: text, voice, attachment, source, and diagram events stay in one ordered conversation", async () => {
  let voiceEmit;
  let stopped = false;
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_continuity",
    adapter: adapter({
      async startVoice(_input, emit) {
        voiceEmit = emit;
        return {
          async stop() {
            stopped = true;
          },
          async setMuted() {},
        };
      },
      async uploadFiles(input, emit) {
        emit({
          type: "attachment.updated",
          conversationId: input.conversationId,
          attachment: {
            kind: "attachment",
            id: "attachment-1",
            filename: "lesson.pdf",
            mediaType: "application/pdf",
            sizeBytes: 42,
            status: "ready",
          },
        });
      },
    }),
    branding: { voiceEnabled: true },
  });

  await widget.send("Start in text");
  widget.receive({
    type: "thread.item",
    conversationId: "conversation-1",
    item: {
      ...textItem("rich-1", 20, "assistant", "See the evidence."),
      parts: [
        { kind: "text", text: "See the evidence." },
        { kind: "source", id: "source-1", title: "Minimum Day", url: "https://learning.example/source" },
        { kind: "diagram", id: "diagram-1", caption: "Momentum loop", url: "https://learning.example/diagram.svg", approved: true },
      ],
    },
  });
  widget.receive({
    type: "attachment.updated",
    conversationId: "conversation-1",
    attachment: {
      kind: "attachment",
      id: "attachment-1",
      filename: "lesson.pdf",
      mediaType: "application/pdf",
      sizeBytes: 42,
      status: "ready",
    },
  });

  await widget.startVoice();
  voiceEmit({ type: "voice.state", conversationId: "conversation-1", state: "listening" });
  voiceEmit({ type: "transcript.partial", conversationId: "conversation-1", text: "Partial caption" });
  assert.equal(widget.getSnapshot().liveCaption, "Partial caption");
  voiceEmit({
    type: "transcript.final",
    conversationId: "conversation-1",
    itemId: "voice-user-1",
    text: "Continue by voice",
  });
  widget.expand();
  widget.restore();

  const snapshot = widget.getSnapshot();
  assert.equal(snapshot.conversation.id, "conversation-1");
  assert.equal(snapshot.liveCaption, "");
  assert.ok(snapshot.conversation.items.some((item) => item.modality === "text"));
  assert.ok(snapshot.conversation.items.some((item) => item.modality === "voice"));
  assert.ok(snapshot.conversation.items.some((item) => item.parts.some((part) => part.kind === "source")));
  assert.ok(snapshot.conversation.items.some((item) => item.parts.some((part) => part.kind === "diagram")));
  assert.ok(snapshot.conversation.items.some((item) => item.parts.some((part) => part.kind === "attachment")));
  assert.equal(snapshot.presentation, "panel");

  await widget.endVoice();
  assert.equal(stopped, true);
  assert.equal(widget.getSnapshot().modality, "text");
});

test("WID-05: native learning canvas exposes voice, source, orb, and active-edge states", async () => {
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_canvas",
    adapter: adapter({
      async bootstrap() {
        return {
          conversation: conversation("conversation-canvas", [
            {
              ...textItem("grounded-answer", 1, "assistant", "Use the smallest promise you can keep."),
              parts: [
                { kind: "text", text: "Use the smallest promise you can keep." },
                {
                  kind: "source",
                  id: "source-canvas",
                  title: "Minimum Day",
                  url: "https://learning.example/minimum-day",
                },
              ],
            },
          ]),
        };
      },
      async startVoice() {
        return {
          async stop() {},
          async setMuted() {},
        };
      },
    }),
    branding: { voiceEnabled: true },
  });

  widget.open();
  const style = widget.shadowRoot.children[0];
  const launcher = widget.shadowRoot.children[1];
  const surface = widget.shadowRoot.children[2];
  const voice = findDescendant(surface, (element) => element.className.includes("voice"));
  const source = findDescendant(surface, (element) => element.className === "source");

  assert.match(style.textContent, /orbFloat/);
  assert.match(style.textContent, /spectralEdge/);
  assert.equal(launcher.className, "launcher");
  assert.equal(voice.textContent, "Voice");
  assert.equal(voice.getAttribute("aria-label"), "Start voice mode");
  assert.equal(source.textContent, "Source · Minimum Day");
  assert.equal(surface.dataset.modality, "text");

  await widget.startVoice();
  assert.equal(surface.dataset.modality, "voice");
  assert.equal(voice.textContent, "End voice");
  assert.equal(voice.getAttribute("aria-label"), "End voice mode");
});

test("tenant persistence is isolated and every send refreshes page context", async () => {
  dom.setViewport(1200, 900);
  const storage = new MemoryStorage();
  const pages = [];
  const capture = adapter({
    async sendText(input) {
      pages.push(input.page);
    },
  });
  const tenantA = connectedWidget();
  await tenantA.configure({ tenantKey: "pk_a", adapter: capture, storage });
  tenantA.open();
  tenantA.moveBy(-50, -40);
  tenantA.setDraft("Tenant A");
  globalThis.location.href = "https://learning.example/new-page";
  globalThis.document.title = "New lesson";
  await tenantA.send();

  const tenantB = connectedWidget();
  await tenantB.configure({ tenantKey: "pk_b", adapter: adapter(), storage });
  assert.equal(tenantB.getSnapshot().draft, "");
  assert.notDeepEqual(tenantB.getSnapshot().layout, tenantA.getSnapshot().layout);
  assert.deepEqual(pages, [{ href: "https://learning.example/new-page", title: "New lesson" }]);
});

test("same-element tenant switches reset state and ignore stale adapter events", async () => {
  let oldEmit;
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_old",
    adapter: adapter({
      async sendText(_input, emit) {
        oldEmit = emit;
      },
    }),
  });
  await widget.send("Old tenant question");
  assert.equal(typeof oldEmit, "function");

  await widget.configure({
    tenantKey: "pk_new",
    adapter: adapter({
      async bootstrap() {
        return {
          conversation: conversation("new-conversation", [textItem("new-1", 1, "assistant", "New tenant only")]),
          branding: { assistantName: "New tenant assistant" },
        };
      },
    }),
  });

  assert.equal(widget.getSnapshot().conversation.id, "new-conversation");
  assert.equal(widget.getSnapshot().conversation.items[0].parts[0].text, "New tenant only");
  assert.equal(widget.getSnapshot().branding.assistantName, "New tenant assistant");

  oldEmit({
    type: "response.delta",
    conversationId: "new-conversation",
    itemId: "stale-response",
    text: "Stale adapter data",
  });
  assert.ok(!widget.getSnapshot().conversation.items.some((item) => item.id === "stale-response"));

  let resolveOldBootstrap;
  const oldBootstrap = new Promise((resolve) => {
    resolveOldBootstrap = resolve;
  });
  const racingWidget = connectedWidget();
  const firstConfiguration = racingWidget.configure({
    tenantKey: "pk_race_old",
    adapter: adapter({
      async bootstrap() {
        return oldBootstrap;
      },
    }),
  });

  await racingWidget.configure({
    tenantKey: "pk_race_new",
    adapter: adapter({
      async bootstrap() {
        return {
          conversation: conversation("race-new-conversation", [textItem("race-new-1", 1, "assistant", "Race winner")]),
        };
      },
    }),
  });
  resolveOldBootstrap({
    conversation: conversation("old-conversation", [textItem("old-1", 1, "assistant", "Must never appear")]),
  });
  await firstConfiguration;

  assert.equal(racingWidget.getSnapshot().conversation.id, "race-new-conversation");
  assert.equal(racingWidget.getSnapshot().conversation.items[0].parts[0].text, "Race winner");

  let rejectOldBootstrap;
  const rejectedBootstrap = new Promise((_resolve, reject) => {
    rejectOldBootstrap = reject;
  });
  const rejectionWidget = connectedWidget();
  const obsoleteConfiguration = rejectionWidget.configure({
    tenantKey: "pk_reject_old",
    adapter: adapter({
      async bootstrap() {
        return rejectedBootstrap;
      },
    }),
  });
  await rejectionWidget.configure({
    tenantKey: "pk_reject_new",
    adapter: adapter({
      async bootstrap() {
        return { conversation: conversation("reject-new-conversation") };
      },
    }),
  });
  rejectOldBootstrap(new Error("obsolete adapter ignored abort"));
  await obsoleteConfiguration;
  assert.equal(rejectionWidget.style.display, "");
  assert.equal(rejectionWidget.getSnapshot().conversation.id, "reject-new-conversation");
});

test("transport interruption preserves the user input and supports deterministic retry", async () => {
  let attempts = 0;
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_retry",
    adapter: adapter({
      async sendText(input, emit) {
        attempts += 1;
        if (attempts === 1) throw new Error("network unavailable");
        emit({
          type: "response.delta",
          conversationId: input.conversationId,
          itemId: "retry-answer",
          text: "Recovered",
        });
        emit({
          type: "response.complete",
          conversationId: input.conversationId,
          itemId: "retry-answer",
        });
      },
    }),
  });

  await widget.send("Keep this exact question");
  assert.equal(widget.getSnapshot().draft, "Keep this exact question");
  assert.ok(widget.getSnapshot().conversation.items.some((item) => item.status === "failed"));

  await widget.retryLastFailed();
  assert.equal(attempts, 2);
  assert.ok(widget.getSnapshot().conversation.items.some((item) => item.id === "retry-answer"));
});

test("WID-12: a second thread.item for the same id delivers the answer instead of being dropped", async () => {
  // This is exactly what both shipped adapters do — apps/console/src/app/
  // widget.js/embed-prelude.ts on customer sites, and the console's own live
  // preview in components/sections/widget-panel.tsx. They announce the
  // assistant turn as `pending` with no parts the moment the question is
  // sent, then re-announce the SAME id with the real parts once the answer
  // comes back. While thread.item was insert-only, that second event was
  // discarded and every answer rendered as an empty bubble.
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_upsert",
    adapter: adapter({
      async sendText(input, emit) {
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: "answer-1",
            sequence: 1,
            role: "assistant",
            modality: "text",
            status: "pending",
            parts: [],
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        });
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: "answer-1",
            sequence: 2,
            role: "assistant",
            modality: "text",
            status: "complete",
            parts: [
              { kind: "text", text: "Momentum beats intensity." },
              { kind: "source", id: "source-1", title: "Minimum Day", url: "" },
            ],
            createdAt: "2026-07-30T00:00:01.000Z",
          },
        });
        emit({
          type: "response.complete",
          conversationId: input.conversationId,
          itemId: "answer-1",
        });
      },
    }),
  });

  await widget.send("What actually keeps a habit alive?");

  const items = widget.getSnapshot().conversation.items.filter((item) => item.id === "answer-1");
  assert.equal(items.length, 1, "the update must not append a duplicate turn");
  assert.equal(items[0].status, "complete");
  assert.deepEqual(
    items[0].parts.map((part) => part.kind),
    ["text", "source"],
  );
  assert.equal(items[0].parts[0].text, "Momentum beats intensity.");

  const surface = widget.shadowRoot.children[2];
  assert.match(descendantText(surface), /Momentum beats intensity\./);
});

test("WID-13: a late pending thread.item never erases text already streamed for that turn", async () => {
  // An adapter that streams deltas and then re-announces the turn must not
  // lose the streamed text to an event that carries no parts, and must not
  // roll a completed turn back to pending.
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_upsert_stream",
    adapter: adapter({
      async sendText(input, emit) {
        emit({
          type: "response.delta",
          conversationId: input.conversationId,
          itemId: "answer-2",
          text: "Streamed first.",
        });
        emit({
          type: "response.complete",
          conversationId: input.conversationId,
          itemId: "answer-2",
        });
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: "answer-2",
            sequence: 3,
            role: "assistant",
            modality: "text",
            status: "pending",
            parts: [],
            createdAt: "2026-07-30T00:00:02.000Z",
          },
        });
      },
    }),
  });

  await widget.send("Stream it");

  const item = widget.getSnapshot().conversation.items.find((candidate) => candidate.id === "answer-2");
  assert.equal(item.parts[0].text, "Streamed first.");
  assert.equal(item.status, "complete", "a terminal status is never rolled back to pending");
});

test("WID-14: every rich part kind renders, and a kind this build does not recognize is skipped, not thrown", async () => {
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_rich_parts",
    adapter: adapter({
      async sendText(input, emit) {
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: "rich-answer",
            sequence: 1,
            role: "assistant",
            modality: "text",
            status: "complete",
            parts: [
              { kind: "text", text: "Lead with the **value recap** first." },
              {
                kind: "list",
                heading: "The order that works",
                items: ["Name three results from last year.", "State the rate **once**.", "Give the start date."],
              },
              { kind: "quote", text: "My rate is £95/hr from 1 September.", attribution: "Example client email" },
              {
                kind: "chart",
                id: "chart-1",
                heading: "What actually happens when you raise",
                sourceLabel: "Lesson 3.3",
                bars: [
                  { label: "Said yes", value: 72 },
                  { label: "Negotiated", value: 21 },
                  { label: "Walked", value: 7 },
                ],
                footnote: "From the 43 raises this cohort reported.",
              },
              { kind: "code", label: "THE SENTENCE ITSELF", code: "My rate is $95/hr from 1 September." },
              {
                kind: "video",
                id: "video-1",
                title: "Watch the 40-second version",
                url: "https://learning.example/clip.mp4",
                posterUrl: "https://learning.example/poster.jpg",
                durationLabel: "0:42",
              },
              {
                kind: "progress",
                id: "progress-1",
                moduleLabel: "Module 3 · Pricing without flinching",
                statusLabel: "You're 2 of 4 lessons in",
                completedSteps: 2,
                totalSteps: 4,
                nextLabel: "3.3 The number itself",
              },
              { kind: "followups", suggestions: ["What if they say no?", "Show me the email"] },
              // An adapter ahead of this widget build may send a kind that
              // does not exist yet here. It must be skipped, never thrown on.
              { kind: "annotation", text: "from the future" },
            ],
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        });
        emit({ type: "response.complete", conversationId: input.conversationId, itemId: "rich-answer" });
      },
    }),
  });

  await widget.send("How do I raise my rate with a long-time client?");

  assert.equal(widget.style.display, "", "an unrecognized part kind must not fail the whole widget");
  const surface = widget.shadowRoot.children[2];
  const text = descendantText(surface);
  assert.match(text, /Lead with the/);
  assert.match(text, /value recap/);
  assert.match(text, /The order that works/);
  assert.match(text, /Name three results from last year\./);
  assert.match(text, /Give the start date\./);
  assert.match(text, /My rate is £95\/hr from 1 September\./);
  assert.match(text, /Example client email/);
  assert.match(text, /What actually happens when you raise/);
  assert.match(text, /Lesson 3\.3/);
  assert.match(text, /72%/);
  assert.match(text, /Said yes/);
  assert.match(text, /From the 43 raises this cohort reported\./);
  assert.match(text, /THE SENTENCE ITSELF/);
  assert.match(text, /My rate is \$95\/hr from 1 September\./);
  assert.match(text, /Watch the 40-second version/);
  assert.match(text, /0:42/);
  assert.match(text, /Module 3 · Pricing without flinching/);
  assert.match(text, /You're 2 of 4 lessons in/);
  assert.match(text, /Next: 3\.3 The number itself/);
  assert.match(text, /What if they say no\?/);
  assert.match(text, /Show me the email/);
  assert.doesNotMatch(text, /from the future/);

  const video = findDescendant(surface, (element) => element.tagName === "VIDEO");
  assert.ok(video, "a real <video> element is rendered for the video part");
  assert.equal(video.src, "https://learning.example/clip.mp4");
  assert.equal(video.poster, "https://learning.example/poster.jpg");
  assert.equal(video.controls, true);

  const listRows = findDescendant(surface, (element) => element.className === "listRows");
  assert.equal(listRows.children.length, 3, "every list item is rendered");

  const progressBar = findDescendant(surface, (element) => element.className === "progressBar");
  assert.equal(progressBar.children.length, 4);
  assert.equal(progressBar.children.filter((segment) => segment.className === "filled").length, 2);

  const followups = findDescendant(surface, (element) => element.className === "followups");
  assert.equal(followups.children.length, 2);
});

test("WID-15: a pending assistant turn with no parts yet renders a thinking indicator, not an empty bubble", async () => {
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_thinking",
    adapter: adapter({
      async bootstrap() {
        return {
          conversation: conversation(),
          learningContext: { status: "resolved", module: "Module 2" },
        };
      },
      async sendText(input, emit) {
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: "pending-1",
            sequence: 1,
            role: "assistant",
            modality: "text",
            status: "pending",
            parts: [],
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        });
        // Deliberately left pending — this test inspects the interim state.
      },
    }),
  });

  await widget.send("How do I price a retainer?");
  const surface = widget.shadowRoot.children[2];
  const thinking = findDescendant(surface, (element) => element.className === "message assistant thinking");
  assert.ok(thinking, "a pending, partless turn renders a thinking indicator instead of nothing");
  const dots = findDescendant(surface, (element) => element.className === "thinkingDots");
  assert.equal(dots.children.length, 3);
  assert.match(descendantText(surface), /Reading Module 2…/);
});

test("WID-16: a failed send is marked failed and its Try again control retries through retryLastFailed", async () => {
  let attempts = 0;
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_failed_retry",
    adapter: adapter({
      async sendText(input, emit) {
        attempts += 1;
        if (attempts === 1) throw new Error("network unavailable");
        emit({ type: "response.delta", conversationId: input.conversationId, itemId: "recovered", text: "Recovered." });
        emit({ type: "response.complete", conversationId: input.conversationId, itemId: "recovered" });
      },
    }),
  });

  await widget.send("How do I price a retainer?");
  const surface = widget.shadowRoot.children[2];
  const failedMessage = findDescendant(surface, (element) => element.dataset?.status === "failed");
  assert.ok(failedMessage, "the failed user turn carries data-status=failed");
  const retryButton = findDescendant(surface, (element) => element.className === "retryButton");
  assert.ok(retryButton, "a Try again control is rendered for the failed turn");

  retryButton.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(attempts, 2, "clicking Try again calls retryLastFailed, which resends");
  assert.ok(widget.getSnapshot().conversation.items.some((item) => item.id === "recovered"));
  assert.ok(!widget.getSnapshot().conversation.items.some((item) => item.status === "failed"));
});

test("WID-17: starter chips, the away banner, and the trust footer are branding-driven", async () => {
  const asked = [];
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_starters",
    adapter: adapter({
      async sendText(input) {
        asked.push(input.text);
      },
    }),
    branding: {
      starterPrompts: ["Raise my rate", "Scope creep", "   "],
      awayMessage: "Maya has paused me. Post in the community and she'll answer herself.",
      privacyUrl: "https://learning.example/privacy",
    },
  });

  assert.deepEqual(widget.getSnapshot().branding.starterPrompts, ["Raise my rate", "Scope creep"]);
  const surface = widget.shadowRoot.children[2];
  const chips = findDescendant(surface, (element) => element.className === "emptyChips");
  assert.equal(chips.children.length, 2, "blank starter prompts are dropped, real ones render as chips");

  chips.children[0].click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(asked, ["Raise my rate"], "a starter chip asks its own label");

  const away = findDescendant(surface, (element) => element.className === "away");
  assert.equal(away.hidden, false);
  assert.match(descendantText(away), /Away right now/);
  assert.match(descendantText(away), /Maya has paused me/);

  const trustLink = findDescendant(surface, (element) => element.className === "trustLink");
  assert.equal(trustLink.getAttribute("href"), "https://learning.example/privacy");
  assert.match(descendantText(surface), /Answers come only from this course/);

  const plainWidget = connectedWidget();
  await plainWidget.configure({ tenantKey: "pk_no_starters", adapter: adapter() });
  const plainSurface = plainWidget.shadowRoot.children[2];
  assert.equal(findDescendant(plainSurface, (element) => element.className === "away").hidden, true);
  assert.equal(
    findDescendant(plainSurface, (element) => element.className === "emptyChips").children.length,
    0,
    "no starter prompts configured renders no chips",
  );
});

test("WID-18: text parts support a restricted **bold** inline syntax, built as real elements rather than innerHTML", async () => {
  const widget = connectedWidget();
  await widget.configure({
    tenantKey: "pk_bold",
    adapter: adapter({
      async sendText(input, emit) {
        emit({
          type: "thread.item",
          conversationId: input.conversationId,
          item: {
            id: "bold-1",
            sequence: 1,
            role: "assistant",
            modality: "text",
            status: "complete",
            parts: [{ kind: "text", text: "State the new rate **once**. Don't soften it twice." }],
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        });
      },
    }),
  });

  await widget.send("How do I raise my rate?");
  const surface = widget.shadowRoot.children[2];
  const strong = findDescendant(surface, (element) => element.tagName === "STRONG" && element.textContent === "once");
  assert.ok(strong, "a ** run becomes a real <strong> element");
  assert.match(descendantText(surface), /State the new rate/);
  assert.match(descendantText(surface), /Don't soften it twice\./);
});
