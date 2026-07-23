import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  EphemeralClientSessionDescriptor,
  RealtimeVoiceSession,
  VoiceSessionContext,
  VoiceSessionEvent,
  VoiceSessionOptions,
} from "../src/index.js";
import {
  DeterministicVoiceRuntime,
  FakeRealtimeVoiceAdapter,
  FakeRealtimeVoiceTransport,
  MemoryVoiceCostSink,
  MemoryVoiceUsageSink,
  RealtimeVoiceOrchestrator,
} from "../src/index.js";

const NOW = Date.UTC(2026, 6, 23, 18);
const LONG_LIVED_SECRET = "vault://tenant-alpha/realtime-primary";

function context(
  overrides: Partial<VoiceSessionContext> = {},
): VoiceSessionContext {
  return {
    requestId: "request-alpha-1",
    traceId: "trace-alpha-1",
    tenantId: "tenant-alpha",
    actorId: "student-alpha",
    conversationId: "conversation-alpha",
    sessionId: "browser-session-alpha",
    fundingSource: "tenant_byok",
    deadlineMs: NOW + 10_000,
    idempotencyKey: "voice-alpha-1",
    ...overrides,
  };
}

function options(
  overrides: Partial<VoiceSessionOptions> = {},
): VoiceSessionOptions {
  return {
    voiceId: "warm-guide",
    language: "en-US",
    mode: "tap_to_start",
    enableBargeIn: true,
    instructions: "Ground every answer in the active lesson.",
    inputMediaType: "audio/pcm;rate=24000",
    outputMediaType: "audio/pcm;rate=24000",
    reconnect: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 250,
    },
    secretRef: LONG_LIVED_SECRET,
    ...overrides,
  };
}

function subject(input: {
  open: ConstructorParameters<
    typeof FakeRealtimeVoiceAdapter
  >[0]["openSteps"];
  resume?: ConstructorParameters<
    typeof FakeRealtimeVoiceAdapter
  >[0]["openSteps"];
  runtime?: DeterministicVoiceRuntime;
}) {
  const runtime = input.runtime ?? new DeterministicVoiceRuntime(NOW);
  const adapter = new FakeRealtimeVoiceAdapter({
    nowMs: NOW,
    openSteps: input.open,
    ...(input.resume === undefined ? {} : { resumeSteps: input.resume }),
  });
  const usage = new MemoryVoiceUsageSink();
  const costs = new MemoryVoiceCostSink();
  const orchestrator = new RealtimeVoiceOrchestrator({
    adapter,
    usageSink: usage,
    costSink: costs,
    clock: runtime,
    sleeper: runtime,
    ids: runtime,
  });
  return { runtime, adapter, usage, costs, orchestrator };
}

async function startSession(
  orchestrator: RealtimeVoiceOrchestrator,
  sessionContext = context(),
  sessionOptions = options(),
): Promise<RealtimeVoiceSession> {
  const result = await orchestrator.start({
    context: sessionContext,
    options: sessionOptions,
  });
  if (!result.ok) throw new Error(result.error.message);
  assert.equal(result.ok, true);
  return result.session;
}

async function nextType(
  iterator: AsyncIterator<VoiceSessionEvent>,
  type: VoiceSessionEvent["type"],
): Promise<VoiceSessionEvent> {
  for (let index = 0; index < 100; index += 1) {
    const next = await iterator.next();
    assert.equal(next.done, false, `event stream ended before ${type}`);
    if (!next.done && next.value.type === type) return next.value;
  }
  throw new Error(`did not receive event ${type}`);
}

async function nextState(
  iterator: AsyncIterator<VoiceSessionEvent>,
  state: Extract<
    VoiceSessionEvent,
    { readonly type: "session.state" }
  >["state"],
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const event = await nextType(iterator, "session.state");
    if (event.type === "session.state" && event.state === state) return;
  }
  throw new Error(`did not receive state ${state}`);
}

test("VOICE-01: package is provider-neutral and depends only on shared contracts", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies), [
    "@course-ai/contracts",
  ]);

  for (const filename of await readdir(join(process.cwd(), "src"))) {
    if (!filename.endsWith(".ts")) continue;
    const source = await readFile(
      join(process.cwd(), "src", filename),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    assert.ok(
      imports.every(
        (specifier) =>
          specifier === "@course-ai/contracts" ||
          specifier?.startsWith("./") === true,
      ),
      `${filename} contains a non-contract, non-local import`,
    );
  }
});

test("VOICE-02: lifecycle normalizes audio, transcript, assistant output, usage and cost", async () => {
  const transport = new FakeRealtimeVoiceTransport("provider-session-1");
  const fixture = subject({ open: [{ type: "success", transport }] });
  const session = await startSession(fixture.orchestrator);
  const events = session.events()[Symbol.asyncIterator]();

  const opening = await nextType(events, "session.state");
  assert.deepEqual(opening, {
    type: "session.state",
    previousState: "idle",
    state: "opening",
  });
  const connected = await nextType(events, "session.state");
  assert.equal(connected.type === "session.state" && connected.state, "connected");

  await session.sendAudio(new Uint8Array([1, 2, 3]));
  await session.commitTurn();
  assert.equal(transport.audioChunks.length, 1);
  assert.equal(transport.commitCount, 1);

  transport.emit({ type: "turn.started", sequence: 10, turnId: "turn-1" });
  transport.emit({
    type: "transcript.partial",
    sequence: 11,
    text: "What is",
  });
  transport.emit({
    type: "transcript.final",
    sequence: 12,
    text: "What is a Minimum Day?",
    confidence: 0.98,
    turnId: "turn-1",
  });
  transport.emit({
    type: "assistant.text.delta",
    sequence: 13,
    text: "It is ",
    turnId: "turn-1",
  });
  transport.emit({
    type: "assistant.text.final",
    sequence: 14,
    text: "It is the smallest version of your habit.",
    turnId: "turn-1",
  });
  transport.emit({
    type: "assistant.audio.delta",
    sequence: 15,
    chunk: {
      bytes: new Uint8Array([9, 8]),
      sequence: 1,
      mediaType: "audio/pcm",
    },
    turnId: "turn-1",
  });
  transport.emit({
    type: "usage",
    sequence: 16,
    usage: [
      { quantity: 1.5, unit: "realtime_second" },
      { quantity: 3, unit: "input_audio_second" },
    ],
    estimatedCost: { amount: 0.004, currency: "USD" },
    modelOrSku: "voice-model",
  });
  transport.emit({ type: "turn.completed", sequence: 17, turnId: "turn-1" });

  const transcript = await nextType(events, "transcript.final");
  assert.equal(
    transcript.type === "transcript.final" && transcript.conversationId,
    "conversation-alpha",
  );
  const assistantAudio = await nextType(events, "assistant.audio");
  assert.equal(
    assistantAudio.type === "assistant.audio" &&
      assistantAudio.chunk.bytes.byteLength,
    2,
  );
  const usageEvent = await nextType(events, "usage");
  const costEvent = await nextType(events, "cost");
  assert.equal(
    usageEvent.type === "usage" && usageEvent.event.tenantId,
    "tenant-alpha",
  );
  assert.equal(
    costEvent.type === "cost" && costEvent.event.estimatedCost.amount,
    0.004,
  );
  await nextType(events, "turn.completed");
  assert.equal(session.state, "connected");
  assert.equal(fixture.usage.events.length, 1);
  assert.equal(fixture.costs.events.length, 1);
  assert.equal(
    fixture.costs.events[0]?.providerSessionId,
    "provider-session-1",
  );
  await session.close();
  assert.deepEqual(transport.closeReasons, ["user_closed"]);
});

test("VOICE-03: barge-in and explicit cancellation interrupt the active turn", async () => {
  const transport = new FakeRealtimeVoiceTransport("provider-session-barge");
  const fixture = subject({ open: [{ type: "success", transport }] });
  const session = await startSession(fixture.orchestrator);
  const events = session.events()[Symbol.asyncIterator]();
  await session.sendText("Explain the lesson");
  transport.emit({ type: "turn.started", sequence: 2, turnId: "turn-barge" });
  await nextType(events, "turn.started");

  await session.bargeIn();
  assert.equal(transport.interruptCount, 1);
  assert.equal(session.state, "listening");
  const interrupted = await nextType(events, "turn.interrupted");
  assert.equal(
    interrupted.type === "turn.interrupted" && interrupted.turnId,
    "turn-barge",
  );

  await session.cancelTurn();
  assert.equal(transport.interruptCount, 2);
  assert.equal(session.state, "connected");
  await session.close();
});

test("VOICE-04: reconnect resumes the same scoped session with bounded backoff", async () => {
  const first = new FakeRealtimeVoiceTransport("provider-session-old");
  const resumed = new FakeRealtimeVoiceTransport("provider-session-resumed");
  const fixture = subject({
    open: [{ type: "success", transport: first }],
    resume: [{ type: "success", transport: resumed }],
  });
  const session = await startSession(fixture.orchestrator);
  const events = session.events()[Symbol.asyncIterator]();
  first.emit({
    type: "disconnected",
    sequence: 8,
    retryable: true,
    reasonCode: "network_reset",
  });

  const scheduled = await nextType(events, "session.reconnect_scheduled");
  assert.equal(
    scheduled.type === "session.reconnect_scheduled" && scheduled.delayMs,
    100,
  );
  const reconnected = await nextType(events, "session.reconnected");
  assert.equal(
    reconnected.type === "session.reconnected" &&
      reconnected.providerSessionId,
    "provider-session-resumed",
  );
  assert.deepEqual(fixture.runtime.sleepCalls, [100]);
  assert.equal(fixture.adapter.resumeCalls.length, 1);
  assert.deepEqual(fixture.adapter.resumeCalls[0]?.checkpoint, {
    tenantId: "tenant-alpha",
    conversationId: "conversation-alpha",
    sessionId: "browser-session-alpha",
    providerSessionId: "provider-session-old",
    lastEventSequence: 8,
  });
  assert.equal(session.clientDescriptor.providerSessionId, "provider-session-resumed");
  await session.close();
});

test("VOICE-05: reconnect retries are bounded and preserve the original deadline", async () => {
  const first = new FakeRealtimeVoiceTransport("provider-session-retry");
  const fixture = subject({
    open: [{ type: "success", transport: first }],
    resume: [
      {
        type: "failure",
        error: { code: "provider_unavailable", retryable: true },
      },
    ],
  });
  const session = await startSession(fixture.orchestrator);
  const events = session.events()[Symbol.asyncIterator]();
  first.emit({
    type: "disconnected",
    sequence: 1,
    retryable: true,
    reasonCode: "network",
  });
  await nextState(events, "reconnecting");
  await nextState(events, "failed");
  assert.equal(fixture.adapter.resumeCalls.length, 3);
  assert.deepEqual(fixture.runtime.sleepCalls, [100, 200, 250]);
  assert.ok(
    fixture.adapter.resumeCalls.every(
      (call) => call.context.deadlineMs === NOW + 10_000,
    ),
  );
});

test("VOICE-06: reconnect stops before backoff would cross the shared deadline", async () => {
  const first = new FakeRealtimeVoiceTransport("provider-session-deadline");
  const fixture = subject({
    open: [{ type: "success", transport: first }],
    resume: [
      {
        type: "failure",
        error: { code: "provider_unavailable", retryable: true },
      },
    ],
  });
  const session = await startSession(
    fixture.orchestrator,
    context({ deadlineMs: NOW + 150 }),
  );
  const events = session.events()[Symbol.asyncIterator]();
  first.emit({
    type: "disconnected",
    sequence: 1,
    retryable: true,
    reasonCode: "network",
  });
  const error = await nextType(events, "error");
  assert.equal(
    error.type === "error" && error.error.code,
    "deadline_exceeded",
  );
  assert.equal(fixture.adapter.resumeCalls.length, 1);
  assert.deepEqual(fixture.runtime.sleepCalls, [100]);
  assert.equal(session.state, "failed");
});

test("VOICE-07: expired initial deadlines fail before any provider call", async () => {
  const transport = new FakeRealtimeVoiceTransport("unused");
  const fixture = subject({ open: [{ type: "success", transport }] });
  const result = await fixture.orchestrator.start({
    context: context({ deadlineMs: NOW }),
    options: options(),
  });
  assert.equal(result.ok, false);
  assert.equal(
    !result.ok && result.error.code,
    "deadline_exceeded",
  );
  assert.equal(fixture.adapter.openCalls.length, 0);
});

test("VOICE-08: tenant and session mismatches are rejected on open and resume", async () => {
  const wrongTenant = new FakeRealtimeVoiceTransport("wrong-tenant");
  const openFixture = subject({
    open: [
      {
        type: "success",
        transport: wrongTenant,
        descriptor: { tenantId: "tenant-beta" },
      },
    ],
  });
  const openResult = await openFixture.orchestrator.start({
    context: context(),
    options: options(),
  });
  assert.equal(openResult.ok, false);
  assert.equal(!openResult.ok && openResult.error.code, "session_mismatch");
  assert.deepEqual(wrongTenant.closeReasons, ["invalid_session_scope"]);

  const first = new FakeRealtimeVoiceTransport("correct-open");
  const wrongResume = new FakeRealtimeVoiceTransport("wrong-resume");
  const resumeFixture = subject({
    open: [{ type: "success", transport: first }],
    resume: [
      {
        type: "success",
        transport: wrongResume,
        descriptor: { sessionId: "another-browser-session" },
      },
    ],
  });
  const session = await startSession(resumeFixture.orchestrator);
  const events = session.events()[Symbol.asyncIterator]();
  first.emit({
    type: "disconnected",
    sequence: 2,
    retryable: true,
    reasonCode: "network",
  });
  const error = await nextType(events, "error");
  assert.equal(error.type === "error" && error.error.code, "session_mismatch");
  assert.equal(session.state, "failed");
  assert.deepEqual(wrongResume.closeReasons, ["invalid_session_scope"]);
});

test("VOICE-09: long-lived secrets are passed only as opaque adapter handles and are redacted", async () => {
  const fixture = subject({
    open: [
      {
        type: "failure",
        error: {
          code: "authentication_failed",
          retryable: false,
          message: `provider leaked ${LONG_LIVED_SECRET}`,
          safeDetails: {
            apiKey: LONG_LIVED_SECRET,
            nested: {
              debug: `unsafe ${LONG_LIVED_SECRET}`,
              reasonCode: "credential_rejected",
            },
          },
        },
      },
    ],
  });
  const result = await fixture.orchestrator.start({
    context: context(),
    options: options(),
  });
  assert.equal(result.ok, false);
  assert.equal(
    fixture.adapter.openCalls[0]?.options.secretRef,
    LONG_LIVED_SECRET,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(LONG_LIVED_SECRET), false);
  assert.equal(serialized.includes("provider leaked"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("credential_rejected"), true);

  const transport = new FakeRealtimeVoiceTransport("safe-descriptor");
  const extraProperty = {
    secretRef: LONG_LIVED_SECRET,
  } as unknown as Partial<EphemeralClientSessionDescriptor>;
  const successFixture = subject({
    open: [
      {
        type: "success",
        transport,
        descriptor: extraProperty,
      },
    ],
  });
  const descriptorResult = await successFixture.orchestrator.start({
    context: context(),
    options: options(),
  });
  assert.equal(
    descriptorResult.ok,
    false,
  );
  assert.equal(
    !descriptorResult.ok && descriptorResult.error.code,
    "response_invalid",
  );
  assert.equal(JSON.stringify(descriptorResult).includes(LONG_LIVED_SECRET), false);
  assert.deepEqual(transport.closeReasons, ["invalid_session_scope"]);
});

test("VOICE-10: voice and text share conversation continuity and safe handoff", async () => {
  const transport = new FakeRealtimeVoiceTransport("provider-session-text");
  const fixture = subject({ open: [{ type: "success", transport }] });
  const session = await startSession(fixture.orchestrator);
  const events = session.events()[Symbol.asyncIterator]();

  await session.sendText("Can I make the habit smaller?");
  assert.deepEqual(transport.textInputs, ["Can I make the habit smaller?"]);
  transport.emit({ type: "turn.started", sequence: 20, turnId: "text-turn" });
  transport.emit({
    type: "assistant.text.final",
    sequence: 21,
    turnId: "text-turn",
    text: "Yes. Keep the smallest version that preserves continuity.",
  });
  transport.emit({
    type: "turn.completed",
    sequence: 22,
    turnId: "text-turn",
  });
  await nextType(events, "turn.completed");

  const handoff = await session.handoffToText();
  assert.equal(handoff.modality, "text");
  assert.equal(handoff.tenantId, "tenant-alpha");
  assert.equal(handoff.actorId, "student-alpha");
  assert.equal(handoff.conversationId, "conversation-alpha");
  assert.equal(handoff.sessionId, "browser-session-alpha");
  assert.deepEqual(handoff.turns, [
    {
      turnId: "text-turn",
      userText: "Can I make the habit smaller?",
      assistantText:
        "Yes. Keep the smallest version that preserves continuity.",
      status: "complete",
    },
  ]);
  assert.equal(session.state, "text_handoff");
  const handoffEvent = await nextType(events, "session.text_handoff");
  assert.equal(
    handoffEvent.type === "session.text_handoff" &&
      handoffEvent.handoff.conversationId,
    "conversation-alpha",
  );
  assert.deepEqual(transport.closeReasons, ["text_handoff"]);
});
