import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmbeddingInput,
  ProviderRequestContext,
} from "@course-ai/contracts";
import {
  OpenAIEmbeddingsAdapter,
  type OpenAIEmbeddingsAdapterOptions,
} from "../src/openai-embeddings.js";

const context = (
  overrides: Partial<ProviderRequestContext> = {},
): ProviderRequestContext => ({
  requestId: "request-embed-123",
  traceId: "trace-embed-123",
  tenantId: "tenant-123",
  actorId: "actor-123",
  fundingSource: "platform",
  deadlineMs: Date.now() + 10_000,
  ...overrides,
});

const input: EmbeddingInput = {
  model: "text-embedding-3-small",
  texts: ["first", "second"],
  dimensions: 3,
};

function embeddingResponse(
  overrides: Record<string, unknown> = {},
  init: ResponseInit = {},
): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
        { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 4, total_tokens: 4 },
      ...overrides,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "openai-embed-request-123",
      },
      ...init,
    },
  );
}

function adapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<OpenAIEmbeddingsAdapterOptions> = {},
): OpenAIEmbeddingsAdapter {
  return new OpenAIEmbeddingsAdapter({
    id: "openai-embeddings",
    credentialResolver: async () => "super-secret-token",
    fetch: fetchImplementation,
    ...overrides,
  });
}

test("returns ordered neutral vectors, usage, and safe correlation", async () => {
  let capturedBody = "";
  let capturedHeaders: Headers | undefined;
  const instance = adapter(
    (async (_url, init) => {
      capturedBody = String(init?.body);
      capturedHeaders = new Headers(init?.headers);
      return embeddingResponse({
        data: [
          { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
          { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
      });
    }) as typeof fetch,
  );

  const outcome = await instance.embed(context(), input);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    assert.fail("expected embedding success");
  }
  assert.deepEqual(outcome.result.value.vectors, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ]);
  assert.deepEqual(outcome.result.usage, [
    { unit: "input_tokens", quantity: 4 },
    { unit: "total_tokens", quantity: 4 },
  ]);
  assert.deepEqual(outcome.result.providerMetadata, {
    costEstimated: false,
    dimensions: 3,
    inputCount: 2,
    providerRequestId: "openai-embed-request-123",
  });
  assert.equal(capturedHeaders?.get("authorization"), "Bearer super-secret-token");
  assert.equal(capturedHeaders?.get("x-client-request-id"), "request-embed-123");
  assert.deepEqual(JSON.parse(capturedBody), {
    model: "text-embedding-3-small",
    input: ["first", "second"],
    encoding_format: "float",
    dimensions: 3,
  });
});

test("requires a model and rejects empty or over-limit batches before fetch", async (t) => {
  const instance = adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
    { maxInputs: 2 },
  );
  for (const [name, invalid] of [
    ["missing model", { texts: ["one"] }],
    ["empty batch", { model: "embedding-model", texts: [] }],
    ["empty text", { model: "embedding-model", texts: [" "] }],
    [
      "too many inputs",
      { model: "embedding-model", texts: ["one", "two", "three"] },
    ],
  ] as const) {
    await t.test(name, async () => {
      const outcome = await instance.embed(context(), invalid);
      assert.equal(outcome.ok, false);
      if (outcome.ok) {
        assert.fail("expected request failure");
      }
      assert.equal(outcome.error.code, "invalid_request");
    });
  }
});

test("rejects oversized requests and unsafe endpoints", async () => {
  assert.throws(
    () =>
      new OpenAIEmbeddingsAdapter({
        id: "unsafe",
        endpoint: "http://api.openai.com/v1/embeddings",
        credentialResolver: async () => "secret",
      }),
    /HTTPS/,
  );
  const outcome = await adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
    { maxRequestBytes: 32 },
  ).embed(context(), input);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? undefined : outcome.error.code, "invalid_request");
});

test("fails closed on malformed, duplicate, or inconsistent provider data", async (t) => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [
      "duplicate index",
      {
        data: [
          { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
          { object: "embedding", index: 0, embedding: [0.4, 0.5, 0.6] },
        ],
      },
    ],
    [
      "non-finite vector",
      {
        data: [
          { object: "embedding", index: 0, embedding: [0.1, 0.2, null] },
          { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      },
    ],
    [
      "wrong dimensions",
      {
        data: [
          { object: "embedding", index: 0, embedding: [0.1, 0.2] },
          { object: "embedding", index: 1, embedding: [0.4, 0.5] },
        ],
      },
    ],
    ["wrong model", { model: "unexpected-model" }],
    ["missing usage", { usage: undefined }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const outcome = await adapter(
        (async () => embeddingResponse(overrides)) as typeof fetch,
      ).embed(context(), input);
      assert.equal(outcome.ok, false);
      if (outcome.ok) {
        assert.fail("expected response failure");
      }
      assert.equal(outcome.error.code, "response_invalid");
    });
  }
});

test("bounds non-2xx bodies without leaking provider or credential text", async () => {
  const providerSecret = "provider-secret-message";
  const outcome = await adapter(
    (async () =>
      new Response(providerSecret, {
        status: 429,
        headers: { "x-request-id": "rate-limit-request" },
      })) as typeof fetch,
    { maxErrorBodyBytes: 8 },
  ).embed(context(), input);
  assert.equal(outcome.ok, false);
  if (outcome.ok) {
    assert.fail("expected provider failure");
  }
  assert.equal(outcome.error.code, "rate_limited");
  assert.deepEqual(outcome.error.safeDetails, {
    responseBodyBytes: 8,
    responseBodyTruncated: true,
    providerRequestId: "rate-limit-request",
  });
  assert.equal(JSON.stringify(outcome).includes(providerSecret), false);
  assert.equal(JSON.stringify(outcome).includes("super-secret-token"), false);
});

test("bounds success bodies and requires JSON content type", async (t) => {
  await t.test("oversized body", async () => {
    const outcome = await adapter(
      (async () =>
        embeddingResponse(
          { padding: "x".repeat(512) },
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      { maxResponseBytes: 64 },
    ).embed(context(), input);
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.ok ? undefined : outcome.error.code,
      "response_invalid",
    );
  });

  await t.test("wrong content type", async () => {
    const outcome = await adapter(
      (async () =>
        embeddingResponse({}, { headers: { "content-type": "text/plain" } })) as
        typeof fetch,
    ).embed(context(), input);
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.ok ? undefined : outcome.error.code,
      "response_invalid",
    );
  });
});

test("deadline bounds credential resolution and fetch without leaking failures", async (t) => {
  await t.test("credential deadline", async () => {
    let resolverSignal: AbortSignal | undefined;
    const instance = new OpenAIEmbeddingsAdapter({
      id: "openai-embeddings",
      credentialResolver: async (_context, signal) => {
        resolverSignal = signal;
        return await new Promise<string>(() => undefined);
      },
      fetch: (async () => assert.fail("fetch must not be called")) as typeof fetch,
    });
    const outcome = await instance.embed(
      context({ deadlineMs: Date.now() + 10 }),
      input,
    );
    assert.equal(resolverSignal?.aborted, true);
    assert.equal(
      outcome.ok ? undefined : outcome.error.code,
      "deadline_exceeded",
    );
  });

  await t.test("fetch deadline", async () => {
    const outcome = await adapter(
      (async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("secret network path", "AbortError")),
            { once: true },
          );
        })) as typeof fetch,
    ).embed(context({ deadlineMs: Date.now() + 10 }), input);
    assert.equal(
      outcome.ok ? undefined : outcome.error.code,
      "deadline_exceeded",
    );
    assert.equal(JSON.stringify(outcome).includes("secret network path"), false);
  });
});

test("uses injected cost estimation and fails closed when accounting fails", async (t) => {
  await t.test("estimated cost", async () => {
    const outcome = await adapter(
      (async () => embeddingResponse()) as typeof fetch,
      {
        estimateUsageCost: async () => ({
          amount: 0.001,
          currency: "USD",
        }),
      },
    ).embed(context(), input);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      assert.fail("expected embedding success");
    }
    assert.deepEqual(outcome.result.estimatedCost, {
      amount: 0.001,
      currency: "USD",
    });
    assert.equal(outcome.result.providerMetadata.costEstimated, true);
  });

  await t.test("accounting error", async () => {
    const secret = "pricing-secret";
    const outcome = await adapter(
      (async () => embeddingResponse()) as typeof fetch,
      {
        estimateUsageCost: async () => {
          throw new Error(secret);
        },
      },
    ).embed(context(), input);
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.ok ? undefined : outcome.error.code,
      "provider_error",
    );
    assert.equal(JSON.stringify(outcome).includes(secret), false);
  });
});
