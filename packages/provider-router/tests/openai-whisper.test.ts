import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRequestContext } from "@course-ai/contracts";
import { OpenAIWhisperAdapter, type OpenAIWhisperAdapterOptions } from "../src/openai-whisper.js";

const context = (
  overrides: Partial<ProviderRequestContext> = {},
): ProviderRequestContext => ({
  requestId: "request-whisper-123",
  traceId: "trace-whisper-123",
  tenantId: "tenant-123",
  actorId: "actor-123",
  fundingSource: "platform",
  deadlineMs: Date.now() + 10_000,
  ...overrides,
});

async function* audioOf(...chunks: readonly number[][]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield new Uint8Array(chunk);
  }
}

function transcriptionResponse(
  overrides: Record<string, unknown> = {},
  init: ResponseInit = {},
): Response {
  return new Response(
    JSON.stringify({
      task: "transcribe",
      language: "english",
      duration: 12.4,
      text: "So today we begin the lesson.",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" }, ...init },
  );
}

function adapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<OpenAIWhisperAdapterOptions> = {},
): OpenAIWhisperAdapter {
  return new OpenAIWhisperAdapter({
    id: "openai-whisper",
    credentialResolver: async () => "super-secret-token",
    fetch: fetchImplementation,
    ...overrides,
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("transcribes audio to a single final event plus a complete summary", async () => {
  let capturedHeaders: Headers | undefined;
  let capturedBody: FormData | undefined;
  const instance = adapter(
    (async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = init?.body as FormData;
      return transcriptionResponse();
    }) as typeof fetch,
  );

  const events = await collect(
    instance.transcribe(context(), audioOf([1, 2, 3], [4, 5]), {}),
  );

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    type: "data",
    value: { type: "final", text: "So today we begin the lesson." },
  });
  const complete = events[1];
  assert.equal(complete?.type, "complete");
  if (complete?.type === "complete") {
    assert.deepEqual(complete.result.usage, [{ unit: "audio_seconds", quantity: 13 }]);
    assert.equal(complete.result.modelOrSku, "whisper-1");
    assert.equal(complete.result.provider, "openai");
  }
  assert.equal(capturedHeaders?.get("authorization"), "Bearer super-secret-token");
  assert.ok(capturedBody instanceof FormData);
  assert.equal(capturedBody?.get("model"), "whisper-1");
  assert.equal(capturedBody?.get("response_format"), "verbose_json");
});

test("passes language and vocabulary through as language and prompt", async () => {
  let capturedBody: FormData | undefined;
  const instance = adapter(
    (async (_url, init) => {
      capturedBody = init?.body as FormData;
      return transcriptionResponse();
    }) as typeof fetch,
  );

  await collect(
    instance.transcribe(context(), audioOf([1]), {
      language: "en",
      vocabulary: ["Photosynthesis", "Chlorophyll"],
    }),
  );

  assert.equal(capturedBody?.get("language"), "en");
  assert.equal(capturedBody?.get("prompt"), "Photosynthesis, Chlorophyll");
});

test("rejects audio larger than the configured limit before any fetch", async () => {
  const instance = adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
    { maxAudioBytes: 4 },
  );
  const events = await collect(instance.transcribe(context(), audioOf([1, 2, 3, 4, 5]), {}));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "invalid_request");
    assert.equal(events[0].error.retryable, false);
  }
});

test("maps an empty credential to authentication_failed without calling fetch", async () => {
  const instance = adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
    { credentialResolver: async () => "" },
  );
  const events = await collect(instance.transcribe(context(), audioOf([1, 2]), {}));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") assert.equal(events[0].error.code, "authentication_failed");
});

test("maps a 429 response to a retryable rate_limited error", async () => {
  const instance = adapter(
    (async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch,
  );
  const events = await collect(instance.transcribe(context(), audioOf([1, 2]), {}));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "rate_limited");
    assert.equal(events[0].error.retryable, true);
  }
});

test("rejects a response with no text as response_invalid", async () => {
  const instance = adapter(
    (async () => transcriptionResponse({ text: undefined })) as typeof fetch,
  );
  const events = await collect(instance.transcribe(context(), audioOf([1, 2]), {}));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") assert.equal(events[0].error.code, "response_invalid");
});

test("reports capabilities for the speech.transcribe capability only", async () => {
  const instance = adapter((async () => transcriptionResponse()) as typeof fetch);
  const capabilities = await instance.capabilities();
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0]?.capability, "speech.transcribe");
});
