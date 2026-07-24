import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatCompletionInput,
  ProviderRequestContext,
  ProviderStreamEvent,
  ChatStreamChunk,
} from "@course-ai/contracts";
import {
  OpenAIResponsesAdapter,
  type OpenAIResponsesAdapterOptions,
  type OpenAIResponsesStreamOptions,
} from "../src/openai-responses.js";

const context = (
  overrides: Partial<ProviderRequestContext> = {},
): ProviderRequestContext => ({
  requestId: "request-123",
  traceId: "trace-123",
  tenantId: "tenant-123",
  actorId: "actor-123",
  fundingSource: "platform",
  deadlineMs: Date.now() + 10_000,
  ...overrides,
});

const input: ChatCompletionInput = {
  model: "requested-model",
  messages: [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hello" },
  ],
};

function sse(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function completed(): string {
  return sse("response.completed", {
    response: {
      id: "resp_123",
      status: "completed",
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
      },
    },
  });
}

function streamResponse(
  chunks: readonly (string | Uint8Array)[],
  init: ResponseInit = {},
): Response {
  const textEncoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? textEncoder.encode(chunk) : chunk,
          );
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "openai-request-123",
      },
      ...init,
    },
  );
}

function adapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<OpenAIResponsesAdapterOptions> = {},
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({
    id: "openai-responses",
    credentialResolver: async () => "super-secret-token",
    fetch: fetchImplementation,
    ...overrides,
  });
}

async function collect(
  instance: OpenAIResponsesAdapter,
  requestContext = context(),
  requestInput = input,
  options: OpenAIResponsesStreamOptions = {},
): Promise<readonly ProviderStreamEvent<ChatStreamChunk>[]> {
  const events: ProviderStreamEvent<ChatStreamChunk>[] = [];
  for await (const event of instance.streamChat(
    requestContext,
    requestInput,
    options,
  )) {
    events.push(event);
  }
  return events;
}

test("streams text, finish, usage, safe correlation, and store:false", async () => {
  let capturedBody = "";
  let capturedHeaders: Headers | undefined;
  const instance = adapter(
    (async (_url, init) => {
      capturedBody = String(init?.body);
      capturedHeaders = new Headers(init?.headers);
      return streamResponse([
        sse("response.created", { response: { id: "resp_123" } }),
        sse("response.output_text.delta", { delta: "Hello" }),
        sse("response.output_text.delta", { delta: " world" }),
        completed(),
      ]);
    }) as typeof fetch,
  );

  const events = await collect(instance);

  assert.deepEqual(events.map((event) => event.type), [
    "data",
    "data",
    "data",
    "complete",
  ]);
  assert.deepEqual(events[0], {
    type: "data",
    value: { type: "text.delta", text: "Hello" },
  });
  assert.deepEqual(events[2], {
    type: "data",
    value: { type: "finish", reason: "stop" },
  });
  const terminal = events[3];
  assert.equal(terminal?.type, "complete");
  if (terminal?.type !== "complete") {
    assert.fail("expected complete event");
  }
  assert.deepEqual(terminal.result.usage, [
    { unit: "input_tokens", quantity: 3 },
    { unit: "output_tokens", quantity: 2 },
    { unit: "total_tokens", quantity: 5 },
  ]);
  assert.equal(
    terminal.result.providerMetadata.providerRequestId,
    "openai-request-123",
  );
  assert.equal(capturedHeaders?.get("x-client-request-id"), "request-123");
  assert.equal(
    capturedHeaders?.get("authorization"),
    "Bearer super-secret-token",
  );
  assert.deepEqual(JSON.parse(capturedBody), {
    model: "requested-model",
    input: [{ role: "user", content: "Hello" }],
    instructions: "Be concise.",
    stream: true,
    store: false,
  });
});

test("parses SSE fields and JSON split across arbitrary byte chunks", async () => {
  const wire =
    sse("response.output_text.delta", { delta: "chunked" }) + completed();
  const bytes = new TextEncoder().encode(wire);
  const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
  const events = await collect(
    adapter((async () => streamResponse(chunks)) as typeof fetch),
  );
  assert.deepEqual(events[0], {
    type: "data",
    value: { type: "text.delta", text: "chunked" },
  });
  assert.equal(events.at(-1)?.type, "complete");
});

test("maps a provider error event without exposing its body", async () => {
  const secretProviderMessage = "internal-provider-secret";
  const events = await collect(
    adapter(
      (async () =>
        streamResponse([
          sse("error", {
            error: { message: secretProviderMessage, code: "internal" },
          }),
        ])) as typeof fetch,
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal(
    events[0]?.type === "error" ? events[0].error.code : undefined,
    "provider_error",
  );
  assert.equal(JSON.stringify(events).includes(secretProviderMessage), false);
});

test("fails closed on provider failure and refusal events", async (t) => {
  await t.test("response.failed", async () => {
    const events = await collect(
      adapter(
        (async () =>
          streamResponse([
            sse("response.failed", {
              response: {
                status: "failed",
                error: { message: "provider-internal-failure" },
              },
            }),
          ])) as typeof fetch,
      ),
    );
    assert.equal(events[0]?.type, "error");
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "provider_error",
    );
    assert.equal(JSON.stringify(events).includes("provider-internal"), false);
  });

  await t.test("refusal inside completed response", async () => {
    const events = await collect(
      adapter(
        (async () =>
          streamResponse([
            sse("response.completed", {
              response: {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [
                      { type: "refusal", refusal: "sensitive-refusal-text" },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 1,
                  output_tokens: 0,
                  total_tokens: 1,
                },
              },
            }),
          ])) as typeof fetch,
      ),
    );
    assert.equal(events[0]?.type, "error");
    if (events[0]?.type !== "error") {
      assert.fail("expected error event");
    }
    assert.equal(events[0].error.code, "provider_error");
    assert.equal(events[0].error.safeDetails?.refusal, true);
    assert.equal(JSON.stringify(events).includes("sensitive-refusal"), false);
  });
});

test("normalizes non-2xx responses with bounded, non-leaking metadata", async () => {
  const providerBody = JSON.stringify({
    error: { message: "do-not-return-this-provider-message" },
  });
  const events = await collect(
    adapter(
      (async () =>
        new Response(providerBody, {
          status: 429,
          headers: { "x-request-id": "rate-limit-request" },
        })) as typeof fetch,
      { maxErrorBodyBytes: 8 },
    ),
  );
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type !== "error") {
    assert.fail("expected error event");
  }
  assert.equal(events[0].error.code, "rate_limited");
  assert.equal(events[0].error.providerStatus, 429);
  assert.deepEqual(events[0].error.safeDetails, {
    responseBodyBytes: 8,
    responseBodyTruncated: true,
    providerRequestId: "rate-limit-request",
  });
  assert.equal(JSON.stringify(events).includes("do-not-return"), false);
});

test("propagates caller abort and absolute deadline to fetch", async (t) => {
  const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted === true) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;

  await t.test("caller abort", async () => {
    const controller = new AbortController();
    const pending = collect(adapter(hangingFetch), context(), input, {
      signal: controller.signal,
    });
    controller.abort();
    const events = await pending;
    assert.equal(events[0]?.type, "error");
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "aborted",
    );
  });

  await t.test("deadline", async () => {
    const events = await collect(
      adapter(hangingFetch),
      context({ deadlineMs: Date.now() + 10 }),
    );
    assert.equal(events[0]?.type, "error");
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "deadline_exceeded",
    );
  });

  await t.test("deadline bounds credential resolution", async () => {
    let resolverSignal: AbortSignal | undefined;
    const instance = new OpenAIResponsesAdapter({
      id: "openai-responses",
      credentialResolver: async (_context, signal) => {
        resolverSignal = signal;
        return await new Promise<string>(() => undefined);
      },
      fetch: (async () => assert.fail("fetch must not be called")) as typeof fetch,
    });
    const events = await collect(
      instance,
      context({ deadlineMs: Date.now() + 10 }),
    );
    assert.equal(resolverSignal?.aborted, true);
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "deadline_exceeded",
    );
  });
});

test("rejects oversized and malformed streaming events", async (t) => {
  await t.test("oversized event", async () => {
    const events = await collect(
      adapter(
        (async () =>
          streamResponse([
            sse("response.output_text.delta", { delta: "x".repeat(128) }),
          ])) as typeof fetch,
        { maxEventBytes: 64 },
      ),
    );
    assert.equal(events[0]?.type, "error");
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "response_invalid",
    );
  });

  await t.test("malformed JSON", async () => {
    const events = await collect(
      adapter(
        (async () =>
          streamResponse(["event: response.output_text.delta\ndata: {\n\n"])) as
          typeof fetch,
      ),
    );
    assert.equal(events[0]?.type, "error");
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "response_invalid",
    );
  });
});

test("rejects a truncated stream that lacks response.completed", async () => {
  const events = await collect(
    adapter(
      (async () =>
        streamResponse([
          sse("response.output_text.delta", { delta: "partial" }),
        ])) as typeof fetch,
    ),
  );
  assert.equal(events[0]?.type, "data");
  assert.equal(events[1]?.type, "error");
  assert.equal(
    events[1]?.type === "error" ? events[1].error.code : undefined,
    "response_invalid",
  );
});

test("never leaks credentials through resolver or network failures", async (t) => {
  await t.test("resolver failure", async () => {
    const resolverSecret = "resolver-secret-value";
    const instance = new OpenAIResponsesAdapter({
      id: "openai-responses",
      credentialResolver: async () => {
        throw new Error(resolverSecret);
      },
      fetch: (async () => {
        assert.fail("fetch must not be called");
      }) as typeof fetch,
    });
    const events = await collect(instance);
    assert.equal(JSON.stringify(events).includes(resolverSecret), false);
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "authentication_failed",
    );
  });

  await t.test("fetch failure", async () => {
    const fetchSecret = "super-secret-token";
    const events = await collect(
      adapter(
        (async () => {
          throw new Error(`network failed for ${fetchSecret}`);
        }) as typeof fetch,
      ),
    );
    assert.equal(JSON.stringify(events).includes(fetchSecret), false);
    assert.equal(
      events[0]?.type === "error" ? events[0].error.code : undefined,
      "provider_unavailable",
    );
  });
});

test("complete accumulates the neutral ChatCompletion result", async () => {
  const instance = adapter(
    (async () =>
      streamResponse([
        sse("response.output_text.delta", { delta: "final" }),
        sse("response.output_text.delta", { delta: " answer" }),
        completed(),
      ])) as typeof fetch,
  );
  const outcome = await instance.complete(context(), input);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    assert.fail("expected successful completion");
  }
  assert.deepEqual(outcome.result.value, {
    message: { role: "assistant", content: "final answer" },
    finishReason: "stop",
  });
});

test("requires request-scoped model selection and HTTPS endpoints", async () => {
  assert.throws(
    () =>
      new OpenAIResponsesAdapter({
        id: "unsafe",
        endpoint: "http://api.openai.com/v1/responses",
        credentialResolver: async () => "secret",
      }),
    /HTTPS/,
  );
  const events = await collect(
    adapter((async () => assert.fail("fetch must not be called")) as typeof fetch),
    context(),
    { messages: [{ role: "user", content: "hello" }] },
  );
  assert.equal(
    events[0]?.type === "error" ? events[0].error.code : undefined,
    "invalid_request",
  );
});
