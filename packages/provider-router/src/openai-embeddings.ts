import type {
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingProvider,
  JsonObject,
  Money,
  ProviderError,
  ProviderOutcome,
  ProviderRequestContext,
  UsageQuantity,
} from "@course-ai/contracts";
import type { OpenAICredentialResolver } from "./openai-responses.js";

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULT_MAX_INPUTS = 256;
const OPENAI_MAX_INPUTS = 2_048;
const DEFAULT_MAX_DIMENSIONS = 4_096;
const DEFAULT_MAX_REQUEST_BYTES = 4_194_304;
const DEFAULT_MAX_RESPONSE_BYTES = 134_217_728;
const DEFAULT_MAX_ERROR_BODY_BYTES = 16_384;
const ZERO_COST: Money = { amount: 0, currency: "USD" };
const encoder = new TextEncoder();

export interface OpenAIEmbeddingsAdapterOptions {
  readonly id: string;
  readonly credentialResolver: OpenAICredentialResolver;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly maxInputs?: number;
  readonly maxDimensions?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxErrorBodyBytes?: number;
  readonly now?: () => number;
  readonly estimateUsageCost?: (
    model: string,
    usage: readonly UsageQuantity[],
  ) => Money | Promise<Money>;
}

interface NormalizedOptions {
  readonly id: string;
  readonly credentialResolver: OpenAICredentialResolver;
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly maxInputs: number;
  readonly maxDimensions: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly now: () => number;
  readonly estimateUsageCost?: OpenAIEmbeddingsAdapterOptions["estimateUsageCost"];
}

interface ValidatedRequest {
  readonly body: string;
  readonly model: string;
  readonly inputCount: number;
  readonly requestedDimensions?: number;
}

interface ParsedResponse {
  readonly value: EmbeddingOutput;
  readonly usage: readonly UsageQuantity[];
  readonly dimensions: number;
}

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

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum?: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    (maximum !== undefined && resolved > maximum)
  ) {
    throw new TypeError(
      maximum === undefined
        ? `${name} must be a positive safe integer.`
        : `${name} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return resolved;
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("The OpenAI Embeddings endpoint must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "The OpenAI Embeddings endpoint must be an HTTPS URL without credentials or a fragment.",
    );
  }
  return parsed.toString();
}

function normalizeOptions(
  options: OpenAIEmbeddingsAdapterOptions,
): NormalizedOptions {
  if (options.id.trim() === "") {
    throw new TypeError("The adapter id must not be empty.");
  }
  return {
    id: options.id,
    credentialResolver: options.credentialResolver,
    fetch: options.fetch ?? globalThis.fetch,
    endpoint: normalizeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT),
    maxInputs: positiveSafeInteger(
      options.maxInputs,
      DEFAULT_MAX_INPUTS,
      "maxInputs",
      OPENAI_MAX_INPUTS,
    ),
    maxDimensions: positiveSafeInteger(
      options.maxDimensions,
      DEFAULT_MAX_DIMENSIONS,
      "maxDimensions",
    ),
    maxRequestBytes: positiveSafeInteger(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
    ),
    maxResponseBytes: positiveSafeInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
    maxErrorBodyBytes: positiveSafeInteger(
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id");
  return value !== null && value.length <= 256 ? value : undefined;
}

function validateRequest(
  adapterId: string,
  input: EmbeddingInput,
  options: NormalizedOptions,
): ValidatedRequest {
  const model = nonEmptyString(input.model);
  if (model === undefined) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "A request-scoped model is required for OpenAI Embeddings.",
        false,
      ),
    );
  }
  if (input.texts.length === 0 || input.texts.length > options.maxInputs) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "The OpenAI embedding batch has an invalid input count.",
        false,
        { safeDetails: { maxInputs: options.maxInputs } },
      ),
    );
  }
  if (input.texts.some((text) => text.trim() === "")) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "OpenAI embedding inputs must not be empty.",
        false,
      ),
    );
  }
  if (
    input.dimensions !== undefined &&
    (!Number.isSafeInteger(input.dimensions) ||
      input.dimensions <= 0 ||
      input.dimensions > options.maxDimensions)
  ) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "The requested embedding dimensions are invalid.",
        false,
        { safeDetails: { maxDimensions: options.maxDimensions } },
      ),
    );
  }

  return {
    model,
    inputCount: input.texts.length,
    ...(input.dimensions === undefined
      ? {}
      : { requestedDimensions: input.dimensions }),
    body: JSON.stringify({
      model,
      input: input.texts,
      encoding_format: "float",
      ...(input.dimensions === undefined
        ? {}
        : { dimensions: input.dimensions }),
    }),
  };
}

function parseUsage(value: unknown): readonly UsageQuantity[] {
  if (!isRecord(value)) {
    throw new Error("missing usage");
  }
  const promptTokens = value.prompt_tokens;
  const totalTokens = value.total_tokens;
  if (
    typeof promptTokens !== "number" ||
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    typeof totalTokens !== "number" ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens < promptTokens
  ) {
    throw new Error("invalid usage");
  }
  return [
    { unit: "input_tokens", quantity: promptTokens },
    { unit: "total_tokens", quantity: totalTokens },
  ];
}

function parseResponse(
  payload: unknown,
  request: ValidatedRequest,
  maxDimensions: number,
): ParsedResponse {
  if (
    !isRecord(payload) ||
    payload.object !== "list" ||
    !Array.isArray(payload.data) ||
    payload.data.length !== request.inputCount
  ) {
    throw new Error("invalid response envelope");
  }
  const responseModel = nonEmptyString(payload.model);
  if (
    responseModel === undefined ||
    responseModel.length > 256 ||
    responseModel !== request.model
  ) {
    throw new Error("invalid response model");
  }

  const vectors: Array<readonly number[] | undefined> = Array.from({
    length: request.inputCount,
  });
  let dimensions: number | undefined;
  for (const item of payload.data) {
    if (
      !isRecord(item) ||
      item.object !== "embedding" ||
      typeof item.index !== "number" ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= request.inputCount ||
      vectors[item.index] !== undefined ||
      !Array.isArray(item.embedding) ||
      item.embedding.length === 0 ||
      item.embedding.length > maxDimensions ||
      item.embedding.some(
        (component) =>
          typeof component !== "number" || !Number.isFinite(component),
      )
    ) {
      throw new Error("invalid embedding item");
    }
    if (dimensions === undefined) {
      dimensions = item.embedding.length;
    } else if (item.embedding.length !== dimensions) {
      throw new Error("inconsistent dimensions");
    }
    vectors[item.index] = item.embedding as number[];
  }
  if (
    dimensions === undefined ||
    vectors.some((vector) => vector === undefined) ||
    (request.requestedDimensions !== undefined &&
      dimensions !== request.requestedDimensions)
  ) {
    throw new Error("incomplete embedding result");
  }

  return {
    value: { vectors: vectors as readonly (readonly number[])[] },
    usage: parseUsage(payload.usage),
    dimensions,
  };
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
          : status === 408 || status === 409 || status >= 500
            ? "provider_unavailable"
            : "invalid_request";
  return providerError(
    adapterId,
    code,
    "OpenAI rejected the Embeddings API request.",
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

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly capturedBytes: number;
      readonly truncated: boolean;
    }
> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { ok: true, bytes: new Uint8Array() };
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (totalBytes + result.value.byteLength > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          capturedBytes: maxBytes,
          truncated: true,
        };
      }
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  } catch {
    return { ok: false, capturedBytes: totalBytes, truncated: true };
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function readBoundedErrorBody(
  response: Response,
  maxBytes: number,
): Promise<{ readonly capturedBytes: number; readonly truncated: boolean }> {
  const result = await readBoundedBody(response, maxBytes);
  return result.ok
    ? { capturedBytes: result.bytes.byteLength, truncated: false }
    : {
        capturedBytes: result.capturedBytes,
        truncated: result.truncated,
      };
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

export class OpenAIEmbeddingsAdapter implements EmbeddingProvider {
  readonly id: string;
  readonly #options: NormalizedOptions;

  constructor(options: OpenAIEmbeddingsAdapterOptions) {
    this.#options = normalizeOptions(options);
    this.id = this.#options.id;
  }

  async capabilities() {
    return [
      {
        capability: "embedding" as const,
        features: ["text", "batch", "dimensions"],
        limits: {
          inputs: this.#options.maxInputs,
          dimensions: this.#options.maxDimensions,
          requestBytes: this.#options.maxRequestBytes,
          responseBytes: this.#options.maxResponseBytes,
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

  async embed(
    context: ProviderRequestContext,
    input: EmbeddingInput,
  ): Promise<ProviderOutcome<EmbeddingOutput>> {
    const startedAt = this.#options.now();
    let request: ValidatedRequest;
    try {
      request = validateRequest(this.id, input, this.#options);
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof AdapterFailure
            ? cause.providerError
            : providerError(
                this.id,
                "invalid_request",
                "The OpenAI embedding request was invalid.",
                false,
              ),
        attempts: [],
      };
    }
    if (encoder.encode(request.body).byteLength > this.#options.maxRequestBytes) {
      return {
        ok: false,
        error: providerError(
          this.id,
          "invalid_request",
          "The OpenAI embedding request exceeds the configured size limit.",
          false,
          { safeDetails: { limitBytes: this.#options.maxRequestBytes } },
        ),
        attempts: [],
      };
    }

    const remainingMs = context.deadlineMs - this.#options.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return {
        ok: false,
        error: providerError(
          this.id,
          "deadline_exceeded",
          "The provider deadline elapsed before the OpenAI embedding request.",
          false,
        ),
        attempts: [],
      };
    }

    const controller = new AbortController();
    let deadlineElapsed = false;
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
      return {
        ok: false,
        error: providerError(
          this.id,
          deadlineElapsed ? "deadline_exceeded" : "authentication_failed",
          deadlineElapsed
            ? "The OpenAI embedding request exceeded its deadline."
            : "OpenAI credentials could not be resolved.",
          false,
        ),
        attempts: [],
      };
    }

    let response: Response;
    try {
      response = await this.#options.fetch(this.#options.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "x-client-request-id": context.requestId,
        },
        body: request.body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(deadlineTimer);
      return {
        ok: false,
        error: providerError(
          this.id,
          deadlineElapsed ? "deadline_exceeded" : "provider_unavailable",
          deadlineElapsed
            ? "The OpenAI embedding request exceeded its deadline."
            : "OpenAI could not be reached.",
          !deadlineElapsed,
        ),
        attempts: [],
      };
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
      return {
        ok: false,
        error: httpError(
          this.id,
          response.status,
          providerRequestId,
          bodyMetadata,
        ),
        attempts: [],
      };
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType?.includes("application/json") !== true) {
      clearTimeout(deadlineTimer);
      await response.body?.cancel();
      return {
        ok: false,
        error: providerError(
          this.id,
          "response_invalid",
          "OpenAI returned a non-JSON embedding response.",
          true,
          {
            safeDetails: {
              contentTypeAccepted: false,
              ...(providerRequestId === undefined
                ? {}
                : { providerRequestId }),
            },
          },
        ),
        attempts: [],
      };
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > this.#options.maxResponseBytes
    ) {
      clearTimeout(deadlineTimer);
      await response.body?.cancel();
      return {
        ok: false,
        error: providerError(
          this.id,
          "response_invalid",
          "The OpenAI embedding response exceeds the configured size limit.",
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
        attempts: [],
      };
    }

    const boundedBody = await readBoundedBody(
      response,
      this.#options.maxResponseBytes,
    );
    clearTimeout(deadlineTimer);
    if (!boundedBody.ok) {
      return {
        ok: false,
        error: providerError(
          this.id,
          deadlineElapsed ? "deadline_exceeded" : "response_invalid",
          deadlineElapsed
            ? "The OpenAI embedding response exceeded its deadline."
            : "The OpenAI embedding response exceeds the configured size limit.",
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
        attempts: [],
      };
    }

    let parsed: ParsedResponse;
    try {
      const body = new TextDecoder("utf-8", { fatal: true }).decode(
        boundedBody.bytes,
      );
      parsed = parseResponse(
        JSON.parse(body) as unknown,
        request,
        this.#options.maxDimensions,
      );
    } catch {
      return {
        ok: false,
        error: providerError(
          this.id,
          "response_invalid",
          "OpenAI returned an invalid embedding response.",
          true,
          {
            safeDetails:
              providerRequestId === undefined ? {} : { providerRequestId },
          },
        ),
        attempts: [],
      };
    }

    let estimatedCost = ZERO_COST;
    try {
      estimatedCost =
        (await this.#options.estimateUsageCost?.(
          request.model,
          parsed.usage,
        )) ?? ZERO_COST;
    } catch {
      return {
        ok: false,
        error: providerError(
          this.id,
          "provider_error",
          "OpenAI embedding cost accounting failed.",
          false,
          {
            safeDetails:
              providerRequestId === undefined ? {} : { providerRequestId },
          },
        ),
        attempts: [],
      };
    }

    return {
      ok: true,
      result: {
        value: parsed.value,
        provider: "openai",
        adapterId: this.id,
        modelOrSku: request.model,
        latencyMs: Math.max(0, this.#options.now() - startedAt),
        usage: parsed.usage,
        estimatedCost,
        providerMetadata: {
          costEstimated: this.#options.estimateUsageCost !== undefined,
          dimensions: parsed.dimensions,
          inputCount: request.inputCount,
          ...(providerRequestId === undefined
            ? {}
            : { providerRequestId }),
        },
      },
    };
  }
}
