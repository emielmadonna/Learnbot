import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/**
 * The embed adapter's SSE reader, RUN rather than read.
 *
 * Every other assertion about this file in this directory is a source
 * contract, and source contracts cannot tell you whether a frame split across
 * two network chunks is reassembled or silently dropped -- which is the single
 * most likely way a streaming reader is wrong. So this suite executes the real
 * `sendText` from `embed-prelude.ts` against a synthetic stream and inspects
 * the runtime events it emits.
 *
 * The prelude is plain ES2020 with no imports (it is concatenated in front of
 * the built IIFE and served as one script), so it runs in a `vm` context with
 * a small host stub and nothing is mocked out of the code under test.
 */

const preludeSource = readFileSync(
  new URL("../src/app/widget.js/embed-prelude.ts", import.meta.url),
  "utf8",
);
const preludeCode = preludeSource.match(/String\.raw`([\s\S]*)`;\s*$/u)?.[1];
assert.ok(preludeCode, "the prelude template literal could not be extracted");
assert.ok(
  !preludeCode.includes("`"),
  "a stray backtick would end the template literal early",
);

const CONVERSATION = "c".repeat(40);
const MESSAGE_ID = "3f1c2b7e-9a4d-4c1b-8f2e-77aa2c9b1d40";

/** The runtime event shapes this suite inspects (packages/widget-runtime). */
type ThreadItem = {
  id: string;
  status: string;
  parts: Record<string, unknown>[];
  feedbackRef?: string;
};
type RuntimeEvent = {
  type: string;
  text?: string;
  code?: string;
  item?: ThreadItem;
};

function mountAdapter(
  fetchImpl: (url?: string, init?: { body?: string }) => Promise<unknown>,
  hostIdentity?: unknown,
) {
  const stored = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    console,
    TextDecoder,
    URL,
    crypto,
    fetch: fetchImpl,
    location: { href: "https://customer.example/course" },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    },
    document: {
      currentScript: {
        src: "https://console.example/widget.js",
        dataset: { tenant: `wk_${"a".repeat(40)}` },
      },
    },
  };
  if (hostIdentity !== undefined) {
    sandbox.CourseAiWidgetIdentity = hostIdentity;
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(preludeCode as string, sandbox);
  return sandbox.CourseAiWidgetAdapter as {
    sendText: (
      input: Record<string, unknown>,
      emit: (event: RuntimeEvent) => void,
    ) => Promise<void>;
    bootstrap: (input: Record<string, unknown>) => Promise<{
      identity: { tier: string; displayName?: string };
    }>;
  };
}

/** A Response-alike whose body arrives in exactly the chunks given. */
function eventStreamResponse(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) return controller.close();
        controller.enqueue(encoder.encode(chunks[index] as string));
        index += 1;
      },
    }),
    headers: {
      get: (name: string) =>
        name === "content-type" ? "text/event-stream; charset=utf-8" : null,
    },
    json: async () => {
      throw new Error("json() must never be called on a streamed response");
    },
  };
}

async function collect(chunks: readonly string[]) {
  const events: RuntimeEvent[] = [];
  const adapter = mountAdapter(async () => eventStreamResponse(chunks));
  await adapter.sendText(
    {
      conversationId: CONVERSATION,
      text: "how do I reset a lesson?",
      page: {},
      attachmentIds: [],
      signal: undefined,
    },
    (event) => events.push(event),
  );
  return events;
}

const sourcesFrame = JSON.stringify({
  conversationRef: CONVERSATION,
  sources: [
    {
      sourceRef: "s1",
      title: "Resetting a lesson",
      courseTitle: "Onboarding",
      excerpt: "Open the lesson menu.",
    },
  ],
  parts: [],
  retrievalMode: "semantic",
});
const doneFrame = JSON.stringify({
  conversationRef: CONVERSATION,
  messageId: MESSAGE_ID,
  retrievalMode: "semantic",
});

test("sources open the turn, deltas append, and done completes it", async () => {
  // The chunk boundaries are deliberately hostile: the sources frame is cut in
  // half, and the word "delta" is split across two reads. A reader that parsed
  // per chunk instead of per blank-line-delimited frame would lose both.
  const events = await collect([
    `event: sources\ndata: ${sourcesFrame.slice(0, 40)}`,
    `${sourcesFrame.slice(40)}\n\nevent: delta\ndata: {"text":"Open "}`,
    `\n\nevent: del`,
    `ta\ndata: {"text":"the lesson."}\n\nevent: done\ndata: ${doneFrame}\n\n`,
  ]);

  const opened = events.find(
    (event) =>
      event.type === "thread.item" &&
      event.item?.status === "streaming",
  );
  assert.ok(opened, "the answer bubble never opened on the sources event");
  const openedParts = opened.item?.parts ?? [];
  // An empty text part first, for deltas to land in, then the citations -- the
  // same order the buffered answer builds.
  assert.equal(openedParts[0]?.kind, "text");
  assert.equal(openedParts[0]?.text, "");
  assert.ok(
    openedParts.some(
      (part) => part.kind === "source" && part.title === "Resetting a lesson",
    ),
    "citations did not arrive before the prose",
  );

  const streamedText = events
    .filter((event) => event.type === "response.delta")
    .map((event) => event.text ?? "")
    .join("");
  assert.equal(streamedText, "Open the lesson.");

  const settled = events.find(
    (event) =>
      event.type === "thread.item" &&
      event.item?.status === "complete",
  );
  assert.ok(settled, "the turn never settled");
  // No parts on the terminal update, so the runtime's upsert keeps the text
  // that was streamed instead of replacing it with an empty bubble.
  assert.equal(settled.item?.parts.length, 0);
  assert.equal(settled.item?.feedbackRef, MESSAGE_ID);
  assert.equal(events.at(-1)?.type, "response.complete");
  assert.ok(!events.some((event) => event.type === "error"));
});

test("a stream that stops without done is reported as failed", async () => {
  const events = await collect([
    `event: sources\ndata: ${sourcesFrame}\n\nevent: delta\ndata: {"text":"Open "}\n\n`,
  ]);
  // The text that did arrive stays on the thread -- it is real -- but the turn
  // is never presented as a finished answer.
  assert.ok(events.some((event) => event.type === "response.delta"));
  assert.ok(
    events.some(
      (event) => event.type === "error" && event.code === "answer_unavailable",
    ),
  );
  assert.ok(!events.some((event) => event.type === "response.complete"));
  assert.ok(
    !events.some(
      (event) =>
        event.type === "thread.item" &&
        event.item?.status === "complete",
    ),
  );
});

test("an error frame is terminal and never completes the turn", async () => {
  const events = await collect([
    `event: sources\ndata: ${sourcesFrame}\n\n`,
    `event: error\ndata: {"code":"provider_budget_exhausted","retryable":true}\n\n`,
  ]);
  assert.ok(events.some((event) => event.type === "error"));
  assert.ok(!events.some((event) => event.type === "response.complete"));
});

test("a done with no message id offers nothing to rate", async () => {
  const events = await collect([
    `event: sources\ndata: ${sourcesFrame}\n\nevent: delta\ndata: {"text":"Hi"}\n\n`,
    `event: done\ndata: {"conversationRef":"${CONVERSATION}"}\n\n`,
  ]);
  const settled = events.find(
    (event) =>
      event.type === "thread.item" &&
      event.item?.status === "complete",
  );
  assert.ok(settled);
  // A rating posted against an id the server never minted is refused, so the
  // honest response to a missing id is no control at all.
  assert.equal(settled.item?.feedbackRef, undefined);
});

test("a JSON response still renders exactly the answer it always did", async () => {
  // This is the live path until the streaming Edge Function is deployed by
  // hand, and it is also what any non-streaming caller keeps getting.
  const events: RuntimeEvent[] = [];
  const adapter = mountAdapter(async () => ({
    ok: true,
    body: null,
    headers: { get: () => "application/json" },
    json: async () => ({
      ok: true,
      conversationRef: CONVERSATION,
      message: {
        id: MESSAGE_ID,
        role: "assistant",
        content: "Buffered answer.",
        sources: [{ sourceRef: "s1", title: "Resetting a lesson" }],
        parts: [],
      },
    }),
  }));
  await adapter.sendText(
    {
      conversationId: CONVERSATION,
      text: "how do I reset a lesson?",
      page: {},
      attachmentIds: [],
      signal: undefined,
    },
    (event) => events.push(event),
  );
  const settled = events.find(
    (event) =>
      event.type === "thread.item" &&
      event.item?.status === "complete",
  );
  assert.ok(settled);
  const parts = settled.item?.parts ?? [];
  assert.equal(parts[0]?.text, "Buffered answer.");
  assert.ok(parts.some((part) => part.kind === "source"));
  assert.equal(settled.item?.feedbackRef, MESSAGE_ID);
  assert.ok(events.some((event) => event.type === "response.complete"));
});

/**
 * The host identity hook, RUN rather than read.
 *
 * `circle-install.test.ts` pins the source of this hook; source contracts
 * cannot tell you whether a hook that throws takes the widget down with it, or
 * whether an install that never opted in still sends exactly the body it used
 * to. These execute it.
 */

/** A non-streamed answer, so `sendText` falls through to the JSON branch. */
function jsonAnswerResponse() {
  return {
    ok: true,
    body: null,
    headers: {
      get: (name: string) =>
        name === "content-type" ? "application/json" : null,
    },
    json: async () => ({
      ok: true,
      message: { text: "Buffered answer.", sources: [] },
    }),
  };
}

async function askBody(hostIdentity?: unknown) {
  let sent: Record<string, unknown> = {};
  const adapter = mountAdapter(async (_url, init) => {
    sent = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    return jsonAnswerResponse();
  }, hostIdentity);
  await adapter.sendText(
    {
      conversationId: CONVERSATION,
      text: "how do I reset a lesson?",
      page: {},
      attachmentIds: [],
      signal: undefined,
    },
    () => {},
  );
  return sent;
}

/**
 * The identity object is created inside the `vm` realm, so its prototype is
 * that realm's `Object.prototype` and `deepStrictEqual` rejects it however
 * identical the contents are. Flattening it here keeps the assertions about
 * values rather than about realms.
 */
async function bootstrapIdentity(hostIdentity?: unknown) {
  const adapter = mountAdapter(
    async () => ({
      ok: true,
      json: async () => ({ ok: true, branding: {} }),
    }),
    hostIdentity,
  );
  const result = await adapter.bootstrap({ tenantKey: `wk_${"a".repeat(40)}` });
  return { ...result.identity };
}

test("an install that declares no identity sends exactly what it always sent", async () => {
  const sent = await askBody(undefined);
  assert.deepEqual(Object.keys(sent).sort(), [
    "conversationRef",
    "courseRef",
    "key",
    "question",
  ]);
  assert.deepEqual(await bootstrapIdentity(undefined), { tier: "anonymous" });
});

test("a declared identity is forwarded as self_reported, from an object or a function", async () => {
  const declared = { ref: "circle:1234567", displayName: "Ada L" };
  for (const hook of [declared, () => declared]) {
    const sent = await askBody(hook);
    assert.equal(sent.visitorRef, "circle:1234567");
    assert.equal(sent.visitorTier, "self_reported");
    assert.deepEqual(await bootstrapIdentity(hook), {
      tier: "self_reported",
      displayName: "Ada L",
    });
  }
});

test("the widget never sends a tier it cannot substantiate", async () => {
  // A page that claims to have verified somebody is still only a page.
  const sent = await askBody({ ref: "circle:1234567", tier: "verified" });
  assert.equal(sent.visitorTier, "self_reported");
  const identity = await bootstrapIdentity({
    ref: "circle:1234567",
    tier: "verified",
  });
  assert.equal(identity.tier, "self_reported");
});

test("a reference the database would refuse never leaves the page", async () => {
  for (const [label, ref] of [
    ["an email address", "ada@example.com"],
    ["whitespace", "circle 1234567"],
    ["too short", "ab"],
    ["too long for surface_visitor_key", "x".repeat(181)],
  ] as const) {
    const sent = await askBody({ ref });
    assert.equal(sent.visitorRef, undefined, `${label} was forwarded`);
    assert.equal(sent.visitorTier, undefined, `${label} was labelled`);
  }
});

test("a broken host hook degrades to anonymous instead of breaking the widget", async () => {
  for (const hook of [
    () => {
      throw new Error("the host page blew up");
    },
    // Not awaited, deliberately: a question must not wait on the host page.
    () => Promise.resolve({ ref: "circle:1234567" }),
    null,
    "circle:1234567",
    { displayName: "Ada L" },
  ]) {
    const sent = await askBody(hook);
    assert.equal(sent.visitorRef, undefined);
    assert.equal(sent.question, "how do I reset a lesson?");
    assert.deepEqual(await bootstrapIdentity(hook), { tier: "anonymous" });
  }
});
