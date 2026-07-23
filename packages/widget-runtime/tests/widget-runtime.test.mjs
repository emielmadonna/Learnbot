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
