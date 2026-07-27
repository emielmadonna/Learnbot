import type {
  ChatCompletion,
  ChatCompletionInput,
  ChatStreamChunk,
  JsonObject,
  LLMProvider,
  Money,
  ProviderError,
  ProviderOutcome,
  ProviderRequestContext,
  ProviderResult,
  ProviderStreamEvent,
  UsageQuantity,
} from "@course-ai/contracts";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_EVENT_BYTES = 262_144;
const DEFAULT_MAX_ERROR_BODY_BYTES = 16_384;
const ZERO_COST: Money = { amount: 0, currency: "USD" };
const encoder = new TextEncoder();

export type OpenAICredentialResolver = (
  context: ProviderRequestContext,
  signal: AbortSignal,
) => Promise<string>;

export interface OpenAIResponsesAdapterOptions {
  readonly id: string;
  readonly credentialResolver: OpenAICredentialResolver;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxEventBytes?: number;
  readonly maxErrorBodyBytes?: number;
  readonly now?: () => number;
  readonly estimateUsageCost?: (
    model: string,
    usage: readonly UsageQuantity[],
  ) => Money | Promise<Money>;
}

export interface OpenAIResponsesStreamOptions {
  readonly signal?: AbortSignal;
}

export type ChatTextStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "done";
      readonly finishReason: string;
      readonly result: Omit<ProviderResult<void>, "value">;
    }
  | { readonly type: "error"; readonly error: ProviderError };

interface NormalizedOptions {
  readonly id: string;
  readonly credentialResolver: OpenAICredentialResolver;
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxEventBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly now: () => number;
  readonly estimateUsageCost?: OpenAIResponsesAdapterOptions["estimateUsageCost"];
}

interface ParsedCompleted {
  readonly responseId?: string;
  readonly usage: readonly UsageQuantity[];
}

type ParsedEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly completed: ParsedCompleted }
  | { readonly type: "ignored" }
  | { readonly type: "error"; readonly error: ProviderError };

class AdapterFailure extends Error {
  constructor(readonly providerError: ProviderError) {
    super(providerError.message);
  }
}

function providerError(
  adapterId: string,
  code: ProviderError["code"],
  message: string,
  retryable: boolean,
  extra: {
    readonly providerStatus?: number;
    readonly safeDetails?: JsonObject;
  } = {},
): ProviderError {
  return {
    code,
    message,
    retryable,
    adapterId,
    ...(extra.providerStatus === undefined
      ? {}
      : { providerStatus: extra.providerStatus }),
    ...(extra.safeDetails === undefined
      ? {}
      : { safeDetails: extra.safeDetails }),
  };
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("The OpenAI Responses endpoint must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "The OpenAI Responses endpoint must be an HTTPS URL without credentials or a fragment.",
    );
  }
  return parsed.toString();
}

function normalizeOptions(
  options: OpenAIResponsesAdapterOptions,
): NormalizedOptions {
  if (options.id.trim() === "") {
    throw new TypeError("The adapter id must not be empty.");
  }
  return {
    id: options.id,
    credentialResolver: options.credentialResolver,
    fetch: options.fetch ?? globalThis.fetch,
    endpoint: normalizeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT),
    maxRequestBytes: boundedPositiveInteger(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
    ),
    maxResponseBytes: boundedPositiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
    maxEventBytes: boundedPositiveInteger(
      options.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      "maxEventBytes",
    ),
    maxErrorBodyBytes: boundedPositiveInteger(
      options.maxErrorBodyBytes,
      DEFAULT_MAX_ERROR_BODY_BYTES,
      "maxErrorBodyBytes",
    ),
    now: options.now ?? Date.now,
    ...(options.estimateUsageCost === undefined
      ? {}
      : { estimateUsageCost: options.estimateUsageCost }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function safeRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id");
  return value !== null && value.length <= 256 ? value : undefined;
}

function usageFrom(response: Record<string, unknown>): readonly UsageQuantity[] {
  const usage = response.usage;
  if (!isRecord(usage)) {
    throw new Error("missing usage");
  }
  const fields = [
    ["input_tokens", usage.input_tokens],
    ["output_tokens", usage.output_tokens],
    ["total_tokens", usage.total_tokens],
  ] as const;
  if (
    fields.some(
      ([, quantity]) =>
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0,
    )
  ) {
    throw new Error("invalid usage");
  }
  return fields.map(([unit, quantity]) => ({
    unit,
    quantity: quantity as number,
  }));
}

function containsRefusal(response: Record<string, unknown>): boolean {
  if (!Array.isArray(response.output)) {
    return false;
  }
  return response.output.some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    if (item.type === "refusal") {
      return true;
    }
    return (
      Array.isArray(item.content) &&
      item.content.some(
        (content) => isRecord(content) && content.type === "refusal",
      )
    );
  });
}

function validateInput(
  adapterId: string,
  input: ChatCompletionInput,
): { readonly model: string; readonly body: string } {
  const model = nonEmptyString(input.model);
  if (model === undefined) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "A request-scoped model is required for OpenAI Responses.",
        false,
      ),
    );
  }
  if (input.messages.length === 0) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "At least one chat message is required.",
        false,
      ),
    );
  }
  if (
    input.tools !== undefined ||
    input.responseSchema !== undefined ||
    input.temperature !== undefined ||
    input.maxOutputTokens !== undefined
  ) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "feature_unsupported",
        "This adapter supports Responses API text streaming only.",
        false,
      ),
    );
  }

  const instructions: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of input.messages) {
    if (typeof message.content !== "string") {
      throw new AdapterFailure(
        providerError(
          adapterId,
          "invalid_request",
          "OpenAI Responses text messages must contain string content.",
          false,
        ),
      );
    }
    if (message.role === "system") {
      instructions.push(message.content);
    } else if (message.role === "user" || message.role === "assistant") {
      messages.push({ role: message.role, content: message.content });
    } else {
      throw new AdapterFailure(
        providerError(
          adapterId,
          "feature_unsupported",
          "Tool messages are not supported by this text streaming adapter.",
          false,
        ),
      );
    }
  }
  if (messages.length === 0) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "At least one user or assistant message is required.",
        false,
      ),
    );
  }

  return {
    model,
    body: JSON.stringify({
      model,
      input: messages,
      ...(instructions.length === 0
        ? {}
        : { instructions: instructions.join("\n\n") }),
      stream: true,
      store: false,
    }),
  };
}

function parseProviderEvent(
  adapterId: string,
  rawData: string,
  providerRequestId: string | undefined,
): ParsedEvent {
  if (rawData === "[DONE]") {
    return {
      type: "error",
      error: providerError(
        adapterId,
        "response_invalid",
        "The OpenAI response stream ended before a completion event.",
        true,
        {
          safeDetails: {
            eventType: "done_without_completion",
            ...(providerRequestId === undefined
              ? {}
              : { providerRequestId }),
          },
        },
      ),
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return {
      type: "error",
      error: providerError(
        adapterId,
        "response_invalid",
        "OpenAI returned a malformed streaming event.",
        true,
        {
          safeDetails: {
            eventType: "malformed_json",
            ...(providerRequestId === undefined
              ? {}
              : { providerRequestId }),
          },
        },
      ),
    };
  }
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return {
      type: "error",
      error: providerError(
        adapterId,
        "response_invalid",
        "OpenAI returned an invalid streaming event.",
        true,
        {
          safeDetails: {
            eventType: "missing_type",
            ...(providerRequestId === undefined
              ? {}
              : { providerRequestId }),
          },
        },
      ),
    };
  }

  if (payload.type === "response.output_text.delta") {
    if (typeof payload.delta !== "string") {
      return {
        type: "error",
        error: providerError(
          adapterId,
          "response_invalid",
          "OpenAI returned an invalid text delta.",
          true,
          {
            safeDetails: {
              eventType: payload.type,
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
            },
          },
        ),
      };
    }
    return { type: "delta", text: payload.delta };
  }

  if (payload.type === "response.completed") {
    if (!isRecord(payload.response) || payload.response.status !== "completed") {
      return {
        type: "error",
        error: providerError(
          adapterId,
          "provider_error",
          "OpenAI did not complete the response.",
          false,
          {
            safeDetails: {
              eventType: payload.type,
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
            },
          },
        ),
      };
    }
    if (containsRefusal(payload.response)) {
      return {
        type: "error",
        error: providerError(
          adapterId,
          "provider_error",
          "OpenAI refused the response.",
          false,
          {
            safeDetails: {
              eventType: payload.type,
              refusal: true,
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
            },
          },
        ),
      };
    }
    try {
      const responseId = nonEmptyString(payload.response.id);
      return {
        type: "completed",
        completed: {
          ...(responseId === undefined ? {} : { responseId }),
          usage: usageFrom(payload.response),
        },
      };
    } catch {
      return {
        type: "error",
        error: providerError(
          adapterId,
          "response_invalid",
          "OpenAI completed the response without valid token usage.",
          true,
          {
            safeDetails: {
              eventType: payload.type,
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
            },
          },
        ),
      };
    }
  }

  if (
    payload.type === "error" ||
    payload.type === "response.failed" ||
    payload.type === "response.incomplete"
  ) {
    return {
      type: "error",
      error: providerError(
        adapterId,
        "provider_error",
        "OpenAI could not complete the response.",
        payload.type !== "response.incomplete",
        {
          safeDetails: {
            eventType: payload.type,
            ...(providerRequestId === undefined
              ? {}
              : { providerRequestId }),
          },
        },
      ),
    };
  }

  if (
    payload.type === "response.refusal.delta" ||
    payload.type === "response.refusal.done"
  ) {
    return {
      type: "error",
      error: providerError(
        adapterId,
        "provider_error",
        "OpenAI refused the response.",
        false,
        {
          safeDetails: {
            eventType: payload.type,
            refusal: true,
            ...(providerRequestId === undefined
              ? {}
              : { providerRequestId }),
          },
        },
      ),
    };
  }

  return { type: "ignored" };
}

async function readBoundedErrorBody(
  response: Response,
  maxBytes: number,
): Promise<{ readonly capturedBytes: number; readonly truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { capturedBytes: 0, truncated: false };
  }
  let capturedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      capturedBytes += result.value.byteLength;
      if (capturedBytes > maxBytes) {
        capturedBytes = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } catch {
    truncated = true;
  }
  return { capturedBytes, truncated };
}

function httpError(
  adapterId: string,
  status: number,
  providerRequestId: string | undefined,
  bodyMetadata: { readonly capturedBytes: number; readonly truncated: boolean },
): ProviderError {
  const code: ProviderError["code"] =
    status === 401
      ? "authentication_failed"
      : status === 403
        ? "permission_denied"
        : status === 429
          ? "rate_limited"
          : status >= 500
            ? "provider_unavailable"
            : "invalid_request";
  return providerError(
    adapterId,
    code,
    "OpenAI rejected the Responses API request.",
    status === 408 || status === 409 || status === 429 || status >= 500,
    {
      providerStatus: status,
      safeDetails: {
        responseBodyBytes: bodyMetadata.capturedBytes,
        responseBodyTruncated: bodyMetadata.truncated,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
      },
    },
  );
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (source === undefined) {
    return () => undefined;
  }
  if (source.aborted) {
    controller.abort(source.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

function splitSseEvents(buffer: string): {
  readonly events: readonly string[];
  readonly remainder: string;
} {
  const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const segments = normalized.split("\n\n");
  const remainder = segments.pop() ?? "";
  return { events: segments, remainder };
}

function dataForEvent(event: string): string | undefined {
  const data: string[] = [];
  for (const line of event.split("\n")) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return data.length === 0 ? undefined : data.join("\n");
}

export class OpenAIResponsesAdapter implements LLMProvider {
  readonly id: string;
  readonly #options: NormalizedOptions;

  constructor(options: OpenAIResponsesAdapterOptions) {
    this.#options = normalizeOptions(options);
    this.id = this.#options.id;
  }

  async capabilities() {
    return [
      {
        capability: "llm.chat" as const,
        features: ["text", "streaming"],
        limits: {
          requestBytes: this.#options.maxRequestBytes,
          responseBytes: this.#options.maxResponseBytes,
          eventBytes: this.#options.maxEventBytes,
        },
      },
    ];
  }

  async health() {
    return {
      status: "unknown" as const,
      checkedAt: new Date(this.#options.now()).toISOString(),
      reasonCode: "passive_adapter_no_probe",
    };
  }

  async *streamChat(
    context: ProviderRequestContext,
    input: ChatCompletionInput,
    streamOptions: OpenAIResponsesStreamOptions = {},
  ): AsyncIterable<ProviderStreamEvent<ChatStreamChunk>> {
    const startedAt = this.#options.now();
    let request: { readonly model: string; readonly body: string };
    try {
      request = validateInput(this.id, input);
    } catch (cause) {
      yield {
        type: "error",
        error:
          cause instanceof AdapterFailure
            ? cause.providerError
            : providerError(
                this.id,
                "invalid_request",
                "The OpenAI request was invalid.",
                false,
              ),
      };
      return;
    }

    if (encoder.encode(request.body).byteLength > this.#options.maxRequestBytes) {
      yield {
        type: "error",
        error: providerError(
          this.id,
          "invalid_request",
          "The OpenAI request exceeds the configured size limit.",
          false,
          { safeDetails: { limitBytes: this.#options.maxRequestBytes } },
        ),
      };
      return;
    }

    const remainingMs = context.deadlineMs - this.#options.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      yield {
        type: "error",
        error: providerError(
          this.id,
          "deadline_exceeded",
          "The provider deadline elapsed before the OpenAI request.",
          false,
        ),
      };
      return;
    }

    const controller = new AbortController();
    let deadlineElapsed = false;
    const unlinkSignal = linkAbortSignal(streamOptions.signal, controller);
    const deadlineTimer = setTimeout(
      () => {
        deadlineElapsed = true;
        controller.abort();
      },
      Math.min(remainingMs, 2_147_483_647),
    );
    let credential: string;
    try {
      credential = await awaitWithAbort(
        this.#options.credentialResolver(context, controller.signal),
        controller.signal,
      );
      if (credential.trim() === "") {
        throw new Error("empty credential");
      }
    } catch {
      clearTimeout(deadlineTimer);
      unlinkSignal();
      yield {
        type: "error",
        error: providerError(
          this.id,
          deadlineElapsed
            ? "deadline_exceeded"
            : controller.signal.aborted
              ? "aborted"
              : "authentication_failed",
          deadlineElapsed
            ? "The OpenAI request exceeded its deadline."
            : controller.signal.aborted
              ? "The OpenAI request was aborted."
              : "OpenAI credentials could not be resolved.",
          false,
        ),
      };
      return;
    }

    let response: Response;
    try {
      response = await this.#options.fetch(this.#options.endpoint, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "x-client-request-id": context.requestId,
        },
        body: request.body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(deadlineTimer);
      unlinkSignal();
      yield {
        type: "error",
        error: providerError(
          this.id,
          deadlineElapsed
            ? "deadline_exceeded"
            : controller.signal.aborted
              ? "aborted"
              : "provider_unavailable",
          deadlineElapsed
            ? "The OpenAI request exceeded its deadline."
            : controller.signal.aborted
              ? "The OpenAI request was aborted."
              : "OpenAI could not be reached.",
          !controller.signal.aborted,
        ),
      };
      return;
    } finally {
      credential = "";
    }

    const providerRequestId = safeRequestId(response);
    if (!response.ok) {
      const bodyMetadata = await readBoundedErrorBody(
        response,
        this.#options.maxErrorBodyBytes,
      );
      clearTimeout(deadlineTimer);
      unlinkSignal();
      yield {
        type: "error",
        error: httpError(
          this.id,
          response.status,
          providerRequestId,
          bodyMetadata,
        ),
      };
      return;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType?.includes("text/event-stream") !== true) {
      clearTimeout(deadlineTimer);
      unlinkSignal();
      await response.body?.cancel();
      yield {
        type: "error",
        error: providerError(
          this.id,
          "response_invalid",
          "OpenAI returned a non-streaming response.",
          true,
          {
            safeDetails: {
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
              contentTypeAccepted: false,
            },
          },
        ),
      };
      return;
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > this.#options.maxResponseBytes
    ) {
      clearTimeout(deadlineTimer);
      unlinkSignal();
      await response.body?.cancel();
      yield {
        type: "error",
        error: providerError(
          this.id,
          "response_invalid",
          "The OpenAI response exceeds the configured size limit.",
          true,
          {
            safeDetails: {
              limitBytes: this.#options.maxResponseBytes,
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
            },
          },
        ),
      };
      return;
    }
    if (response.body === null) {
      clearTimeout(deadlineTimer);
      unlinkSignal();
      yield {
        type: "error",
        error: providerError(
          this.id,
          "response_invalid",
          "OpenAI returned an empty response stream.",
          true,
          {
            safeDetails:
              providerRequestId === undefined ? {} : { providerRequestId },
          },
        ),
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let responseBytes = 0;
    let completed = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          break;
        }
        responseBytes += chunk.value.byteLength;
        if (responseBytes > this.#options.maxResponseBytes) {
          throw new AdapterFailure(
            providerError(
              this.id,
              "response_invalid",
              "The OpenAI response exceeds the configured size limit.",
              true,
              {
                safeDetails: {
                  limitBytes: this.#options.maxResponseBytes,
                  ...(providerRequestId === undefined
                    ? {}
                    : { providerRequestId }),
                },
              },
            ),
          );
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const split = splitSseEvents(buffer);
        buffer = split.remainder;
        if (encoder.encode(buffer).byteLength > this.#options.maxEventBytes) {
          throw new AdapterFailure(
            providerError(
              this.id,
              "response_invalid",
              "An OpenAI streaming event exceeds the configured size limit.",
              true,
              {
                safeDetails: {
                  limitBytes: this.#options.maxEventBytes,
                  ...(providerRequestId === undefined
                    ? {}
                    : { providerRequestId }),
                },
              },
            ),
          );
        }
        for (const rawEvent of split.events) {
          if (
            encoder.encode(rawEvent).byteLength > this.#options.maxEventBytes
          ) {
            throw new AdapterFailure(
              providerError(
                this.id,
                "response_invalid",
                "An OpenAI streaming event exceeds the configured size limit.",
                true,
                {
                  safeDetails: {
                    limitBytes: this.#options.maxEventBytes,
                    ...(providerRequestId === undefined
                      ? {}
                      : { providerRequestId }),
                  },
                },
              ),
            );
          }
          const data = dataForEvent(rawEvent);
          if (data === undefined) {
            continue;
          }
          const parsed = parseProviderEvent(
            this.id,
            data,
            providerRequestId,
          );
          if (parsed.type === "delta") {
            yield {
              type: "data",
              value: { type: "text.delta", text: parsed.text },
            };
          } else if (parsed.type === "error") {
            throw new AdapterFailure(parsed.error);
          } else if (parsed.type === "completed") {
            completed = true;
            const estimatedCost =
              (await this.#options.estimateUsageCost?.(
                request.model,
                parsed.completed.usage,
              )) ?? ZERO_COST;
            yield {
              type: "data",
              value: { type: "finish", reason: "stop" },
            };
            yield {
              type: "complete",
              result: {
                provider: "openai",
                adapterId: this.id,
                modelOrSku: request.model,
                latencyMs: Math.max(0, this.#options.now() - startedAt),
                usage: parsed.completed.usage,
                estimatedCost,
                providerMetadata: {
                  costEstimated:
                    this.#options.estimateUsageCost !== undefined,
                  ...(providerRequestId === undefined
                    ? {}
                    : { providerRequestId }),
                  ...(parsed.completed.responseId === undefined
                    ? {}
                    : { responseId: parsed.completed.responseId }),
                },
              },
            };
            return;
          }
        }
      }
      if (buffer.trim() !== "") {
        const data = dataForEvent(buffer);
        if (data !== undefined) {
          const parsed = parseProviderEvent(
            this.id,
            data,
            providerRequestId,
          );
          if (parsed.type === "error") {
            throw new AdapterFailure(parsed.error);
          }
        }
      }
      if (!completed) {
        throw new AdapterFailure(
          providerError(
            this.id,
            "response_invalid",
            "The OpenAI response stream ended before completion.",
            true,
            {
              safeDetails: {
                ...(providerRequestId === undefined
                  ? {}
                  : { providerRequestId }),
                truncated: true,
              },
            },
          ),
        );
      }
    } catch (cause) {
      yield {
        type: "error",
        error:
          cause instanceof AdapterFailure
            ? cause.providerError
            : providerError(
                this.id,
                deadlineElapsed
                  ? "deadline_exceeded"
                  : controller.signal.aborted
                    ? "aborted"
                    : "response_invalid",
                deadlineElapsed
                  ? "The OpenAI response exceeded its deadline."
                  : controller.signal.aborted
                    ? "The OpenAI response was aborted."
                    : "OpenAI returned an invalid response stream.",
                !controller.signal.aborted,
                {
                  safeDetails:
                    providerRequestId === undefined
                      ? {}
                      : { providerRequestId },
                },
              ),
      };
    } finally {
      clearTimeout(deadlineTimer);
      unlinkSignal();
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * A caller-friendly view of {@link streamChat} for transports (SSE, etc.)
   * that want to forward text as it arrives instead of buffering it.
   *
   * `streamChat` yields the low-level `ProviderStreamEvent<ChatStreamChunk>`
   * union, which nests the interesting cases (`data.value.type ===
   * "text.delta"`, `data.value.type === "finish"`) inside two levels of
   * tagged unions. This flattens that into three events a route handler can
   * forward almost verbatim: `delta` (text as it arrives), `done` (terminal,
   * carries the same result metadata `complete()` would have produced), and
   * `error`. It does not buffer text and it does not change what `complete()`
   * does — `complete()` still accumulates `streamChat` itself, unchanged.
   */
  async *streamChatText(
    context: ProviderRequestContext,
    input: ChatCompletionInput,
    streamOptions: OpenAIResponsesStreamOptions = {},
  ): AsyncGenerator<ChatTextStreamEvent> {
    let finishReason = "stop";
    for await (const event of this.streamChat(context, input, streamOptions)) {
      if (event.type === "error") {
        yield { type: "error", error: event.error };
        return;
      }
      if (event.type === "data") {
        if (event.value.type === "text.delta") {
          yield { type: "delta", text: event.value.text };
        } else if (event.value.type === "finish") {
          finishReason = event.value.reason;
        }
        continue;
      }
      yield { type: "done", finishReason, result: event.result };
      return;
    }
    yield {
      type: "error",
      error: providerError(
        this.id,
        "response_invalid",
        "The OpenAI response stream ended without a terminal event.",
        true,
      ),
    };
  }

  async complete(
    context: ProviderRequestContext,
    input: ChatCompletionInput,
  ): Promise<ProviderOutcome<ChatCompletion>> {
    let text = "";
    let finishReason = "stop";
    for await (const event of this.streamChat(context, input)) {
      if (event.type === "error") {
        return { ok: false, error: event.error, attempts: [] };
      }
      if (event.type === "data") {
        if (event.value.type === "text.delta") {
          text += event.value.text;
        } else if (event.value.type === "finish") {
          finishReason = event.value.reason;
        }
        continue;
      }
      return {
        ok: true,
        result: {
          value: {
            message: { role: "assistant", content: text },
            finishReason,
          },
          ...event.result,
        },
      };
    }
    return {
      ok: false,
      error: providerError(
        this.id,
        "response_invalid",
        "The OpenAI response stream ended without a terminal event.",
        true,
      ),
      attempts: [],
    };
  }
}
