import assert from "node:assert/strict";
import test from "node:test";
import type {
  ImageGenerationInput,
  ProtectedObjectRef,
  ProviderRequestContext,
} from "@course-ai/contracts";
import {
  OpenAIImageAdapter,
  type OpenAIImageAdapterOptions,
} from "../src/openai-image.js";

const context = (
  overrides: Partial<ProviderRequestContext> = {},
): ProviderRequestContext => ({
  requestId: "request-image-123",
  traceId: "trace-image-123",
  tenantId: "tenant-123",
  actorId: "actor-123",
  fundingSource: "platform",
  deadlineMs: Date.now() + 10_000,
  ...overrides,
});

const input: ImageGenerationInput = {
  prompt: "A friendly stylized bobblehead character, idle resting pose.",
  background: "transparent",
  quality: "medium",
};

const oneByOnePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function imageResponse(
  overrides: Record<string, unknown> = {},
  init: ResponseInit = {},
): Response {
  return new Response(
    JSON.stringify({
      created: 1,
      data: [{ b64_json: oneByOnePngBase64, revised_prompt: "revised" }],
      usage: { input_tokens: 20, output_tokens: 80, total_tokens: 100 },
      ...overrides,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "openai-image-request-123",
      },
      ...init,
    },
  );
}

const storedRef: ProtectedObjectRef = {
  objectId: "object-1",
  storageKey: "tenant-123/branding/user-1/set-1/avatar-pose-idle.png",
  contentHash: "hash",
  sizeBytes: 68,
  mediaType: "image/png",
};

function adapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<OpenAIImageAdapterOptions> = {},
): OpenAIImageAdapter {
  return new OpenAIImageAdapter({
    id: "openai-image",
    model: "gpt-image-1",
    credentialResolver: async () => "super-secret-token",
    store: async () => storedRef,
    fetch: fetchImplementation,
    ...overrides,
  });
}

test("generates a text-to-image request, stores the bytes, and reports usage", async () => {
  let capturedBody = "";
  let capturedHeaders: Headers | undefined;
  let capturedEndpoint = "";
  const instance = adapter(
    (async (url, init) => {
      capturedEndpoint = String(url);
      capturedBody = String(init?.body);
      capturedHeaders = new Headers(init?.headers);
      return imageResponse();
    }) as typeof fetch,
  );

  const outcome = await instance.generate(context(), input);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail("expected image generation success");
  assert.deepEqual(outcome.result.value.object, storedRef);
  assert.equal(outcome.result.value.revisedPrompt, "revised");
  assert.deepEqual(outcome.result.usage, [
    { unit: "input_tokens", quantity: 20 },
    { unit: "output_tokens", quantity: 80 },
    { unit: "total_tokens", quantity: 100 },
  ]);
  assert.equal(outcome.result.providerMetadata.editUsed, false);
  assert.equal(capturedEndpoint, "https://api.openai.com/v1/images/generations");
  assert.equal(capturedHeaders?.get("authorization"), "Bearer super-secret-token");
  assert.equal(capturedHeaders?.get("x-client-request-id"), "request-image-123");
  assert.deepEqual(JSON.parse(capturedBody), {
    model: "gpt-image-1",
    prompt: input.prompt,
    size: "1024x1024",
    n: 1,
    output_format: "png",
    background: "transparent",
    quality: "medium",
  });
});

test("uses the edits endpoint and resolves reference bytes when references are supplied", async () => {
  const sourceRef: ProtectedObjectRef = {
    objectId: "source-1",
    storageKey: "tenant-123/branding/user-1/consent/source.png",
    contentHash: "source-hash",
    sizeBytes: 10,
    mediaType: "image/png",
  };
  let capturedEndpoint = "";
  let capturedForm: FormData | undefined;
  let resolvedRef: ProtectedObjectRef | undefined;
  const instance = adapter(
    (async (url, init) => {
      capturedEndpoint = String(url);
      capturedForm = init?.body as FormData;
      return imageResponse();
    }) as typeof fetch,
    {
      objectResolver: async (_ctx, ref) => {
        resolvedRef = ref;
        return new Uint8Array([1, 2, 3]);
      },
    },
  );

  const outcome = await instance.generate(context(), {
    ...input,
    references: [sourceRef],
  });
  assert.equal(outcome.ok, true);
  assert.equal(capturedEndpoint, "https://api.openai.com/v1/images/edits");
  assert.equal(capturedForm?.get("background"), "transparent");
  assert.equal(capturedForm?.get("quality"), "medium");
  assert.deepEqual(resolvedRef, sourceRef);
  if (!outcome.ok) assert.fail("expected image edit success");
  assert.equal(outcome.result.providerMetadata.editUsed, true);
});

test("fails closed when references are supplied but no resolver is configured", async () => {
  const instance = adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
  );
  const outcome = await instance.generate(context(), {
    ...input,
    references: [
      {
        objectId: "o",
        storageKey: "k",
        contentHash: "h",
        sizeBytes: 1,
        mediaType: "image/png",
      },
    ],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? undefined : outcome.error.code, "feature_unsupported");
});

test("validates the prompt, size and reference count before any fetch", async (t) => {
  const instance = adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
    { maxReferences: 1 },
  );
  const cases: ReadonlyArray<readonly [string, ImageGenerationInput]> = [
    ["empty prompt", { prompt: "  " }],
    ["prompt too long", { prompt: "x".repeat(4_001) }],
    ["only width supplied", { prompt: "ok", width: 512 }],
    ["unsupported size", { prompt: "ok", width: 100, height: 100 }],
    ["unsupported output media type", { prompt: "ok", outputMediaType: "image/gif" }],
    [
      "too many references",
      {
        prompt: "ok",
        references: [
          { objectId: "a", storageKey: "a", contentHash: "a", sizeBytes: 1, mediaType: "image/png" },
          { objectId: "b", storageKey: "b", contentHash: "b", sizeBytes: 1, mediaType: "image/png" },
        ],
      },
    ],
  ];
  for (const [name, invalid] of cases) {
    await t.test(name, async () => {
      const outcome = await instance.generate(context(), invalid);
      assert.equal(outcome.ok, false);
      if (outcome.ok) assert.fail("expected request failure");
      assert.equal(outcome.error.code, "invalid_request");
    });
  }
});

test("rejects unsafe endpoints and oversized requests", async () => {
  assert.throws(
    () =>
      new OpenAIImageAdapter({
        id: "unsafe",
        model: "gpt-image-1",
        generationsEndpoint: "http://api.openai.com/v1/images/generations",
        credentialResolver: async () => "secret",
        store: async () => storedRef,
      }),
    /HTTPS/,
  );
  const outcome = await adapter(
    (async () => assert.fail("fetch must not be called")) as typeof fetch,
    { maxRequestBytes: 8 },
  ).generate(context(), input);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? undefined : outcome.error.code, "invalid_request");
});

test("maps non-2xx and malformed responses to safe, closed failures", async (t) => {
  await t.test("http error", async () => {
    const outcome = await adapter(
      (async () =>
        new Response("provider secret detail", {
          status: 429,
          headers: { "x-request-id": "rate-limit-request" },
        })) as typeof fetch,
      { maxErrorBodyBytes: 8 },
    ).generate(context(), input);
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail("expected provider failure");
    assert.equal(outcome.error.code, "rate_limited");
    assert.deepEqual(outcome.error.safeDetails, {
      responseBodyBytes: 8,
      responseBodyTruncated: true,
      providerRequestId: "rate-limit-request",
    });
  });

  await t.test("missing image data", async () => {
    const outcome = await adapter(
      (async () => imageResponse({ data: [] })) as typeof fetch,
    ).generate(context(), input);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? undefined : outcome.error.code, "response_invalid");
  });

  await t.test("non-JSON content type", async () => {
    const outcome = await adapter(
      (async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })) as typeof fetch,
    ).generate(context(), input);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? undefined : outcome.error.code, "response_invalid");
  });
});

test("fails closed when the storage callback throws, without losing the image", async () => {
  const outcome = await adapter(
    (async () => imageResponse()) as typeof fetch,
    {
      store: async () => {
        throw new Error("storage unavailable");
      },
    },
  ).generate(context(), input);
  assert.equal(outcome.ok, false);
  if (outcome.ok) assert.fail("expected storage failure");
  assert.equal(outcome.error.code, "provider_error");
  assert.equal(JSON.stringify(outcome).includes("storage unavailable"), false);
});

test("uses injected cost estimation and fails closed when accounting fails", async (t) => {
  await t.test("estimated cost", async () => {
    const outcome = await adapter(
      (async () => imageResponse()) as typeof fetch,
      { estimateUsageCost: async () => ({ amount: 0.06, currency: "USD" }) },
    ).generate(context(), input);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) assert.fail("expected image generation success");
    assert.deepEqual(outcome.result.estimatedCost, { amount: 0.06, currency: "USD" });
    assert.equal(outcome.result.providerMetadata.costEstimated, true);
  });

  await t.test("accounting error", async () => {
    const secret = "pricing-secret";
    const outcome = await adapter(
      (async () => imageResponse()) as typeof fetch,
      {
        estimateUsageCost: async () => {
          throw new Error(secret);
        },
      },
    ).generate(context(), input);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? undefined : outcome.error.code, "provider_error");
    assert.equal(JSON.stringify(outcome).includes(secret), false);
  });
});

test("reports a deadline_exceeded failure without leaking credentials", async () => {
  const secret = "super-secret-token-value";
  const outcome = await adapter(
    (async () =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`network path with ${secret}`)), 50);
      })) as typeof fetch,
    { credentialResolver: async () => secret },
  ).generate(context({ deadlineMs: Date.now() + 10 }), input);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? undefined : outcome.error.code, "deadline_exceeded");
  assert.equal(JSON.stringify(outcome).includes(secret), false);
});
