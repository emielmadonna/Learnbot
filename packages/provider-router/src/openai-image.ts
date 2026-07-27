import type {
  GeneratedImage,
  ImageGenerationInput,
  ImageGenerationProvider,
  JsonObject,
  Money,
  ProtectedObjectRef,
  ProviderError,
  ProviderOutcome,
  ProviderRequestContext,
  UsageQuantity,
} from "@course-ai/contracts";
import type { OpenAICredentialResolver } from "./openai-responses.js";

/**
 * OpenAI `gpt-image-1` adapter for the `image.generate` capability
 * (docs/PLAN.md Section 7.1). It mirrors the shape of
 * {@link "./openai-responses.js" | OpenAIResponsesAdapter} and
 * {@link "./openai-embeddings.js" | OpenAIEmbeddingsAdapter}: request
 * validation before any network call, a bounded fetch with an abort-linked
 * deadline, redacted error mapping, and cost estimation injected by the
 * caller rather than hardcoded here.
 *
 * Two extra seams exist because this capability is not text-in/text-out:
 *
 *   - `objectResolver` turns a `ProtectedObjectRef` (a reference image — the
 *     creator's own consent photo, or an already-generated pose) into raw
 *     bytes so a later pose can be generated as an *edit* of an earlier one.
 *     Character consistency across a pose set comes from this, not from
 *     prompting alone. The adapter never reads storage itself; the
 *     composition root (the console route) supplies this callback exactly
 *     like it supplies `credentialResolver`.
 *   - `store` persists the bytes OpenAI returns and produces the
 *     `ProtectedObjectRef` the `ImageGenerationProvider` contract requires
 *     the result to carry. Storage is likewise never touched directly here —
 *     "nothing calls a vendor SDK directly" applies to the storage vendor
 *     (Supabase) exactly as much as it applies to OpenAI.
 *
 * `ImageGenerationInput` (packages/contracts/src/providers.ts) carries no
 * `model` field, unlike `ChatCompletionInput` — image generation is priced
 * and rate-limited per model in a way that makes a fixed adapter-per-model
 * the natural shape, so `model` is a constructor option instead.
 */

const DEFAULT_GENERATIONS_ENDPOINT =
  "https://api.openai.com/v1/images/generations";
const DEFAULT_EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits";
const DEFAULT_MAX_REFERENCES = 4;
const DEFAULT_MAX_REQUEST_BYTES = 33_554_432;
const DEFAULT_MAX_RESPONSE_BYTES = 33_554_432;
const DEFAULT_MAX_ERROR_BODY_BYTES = 16_384;
const ZERO_COST: Money = { amount: 0, currency: "USD" };
const encoder = new TextEncoder();

const ALLOWED_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024"]);
const ALLOWED_OUTPUT_FORMATS = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

export type OpenAIImageObjectResolver = (
  context: ProviderRequestContext,
  ref: ProtectedObjectRef,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export type OpenAIImageStore = (
  context: ProviderRequestContext,
  bytes: Uint8Array,
  mediaType: string,
) => Promise<ProtectedObjectRef>;

export interface OpenAIImageAdapterOptions {
  readonly id: string;
  /** Fixed per instance — see the module doc comment. */
  readonly model: string;
  readonly credentialResolver: OpenAICredentialResolver;
  /** Required only when a call supplies `input.references`. */
  readonly objectResolver?: OpenAIImageObjectResolver;
  readonly store: OpenAIImageStore;
  readonly fetch?: typeof fetch;
  readonly generationsEndpoint?: string;
  readonly editsEndpoint?: string;
  readonly maxReferences?: number;
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
  readonly model: string;
  readonly credentialResolver: OpenAICredentialResolver;
  readonly objectResolver?: OpenAIImageObjectResolver;
  readonly store: OpenAIImageStore;
  readonly fetch: typeof fetch;
  readonly generationsEndpoint: string;
  readonly editsEndpoint: string;
  readonly maxReferences: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly now: () => number;
  readonly estimateUsageCost?: OpenAIImageAdapterOptions["estimateUsageCost"];
}

interface ValidatedRequest {
  readonly prompt: string;
  readonly size: string;
  readonly outputFormat: string;
  readonly outputMediaType: string;
}

interface ParsedImageResponse {
  readonly bytes: Uint8Array;
  readonly usage: readonly UsageQuantity[];
  readonly revisedPrompt?: string;
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
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function normalizeEndpoint(name: string, endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError(`The OpenAI ${name} endpoint must be a valid URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      `The OpenAI ${name} endpoint must be an HTTPS URL without credentials or a fragment.`,
    );
  }
  return parsed.toString();
}

function normalizeOptions(
  options: OpenAIImageAdapterOptions,
): NormalizedOptions {
  if (options.id.trim() === "") {
    throw new TypeError("The adapter id must not be empty.");
  }
  if (options.model.trim() === "") {
    throw new TypeError("The adapter model must not be empty.");
  }
  return {
    id: options.id,
    model: options.model,
    credentialResolver: options.credentialResolver,
    ...(options.objectResolver === undefined
      ? {}
      : { objectResolver: options.objectResolver }),
    store: options.store,
    fetch: options.fetch ?? globalThis.fetch,
    generationsEndpoint: normalizeEndpoint(
      "images.generations",
      options.generationsEndpoint ?? DEFAULT_GENERATIONS_ENDPOINT,
    ),
    editsEndpoint: normalizeEndpoint(
      "images.edits",
      options.editsEndpoint ?? DEFAULT_EDITS_ENDPOINT,
    ),
    maxReferences: positiveSafeInteger(
      options.maxReferences,
      DEFAULT_MAX_REFERENCES,
      "maxReferences",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id");
  return value !== null && value.length <= 256 ? value : undefined;
}

function validatePrompt(adapterId: string, prompt: unknown): string {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (trimmed.length === 0 || trimmed.length > 4_000) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "An image prompt between 1 and 4000 characters is required.",
        false,
      ),
    );
  }
  return trimmed;
}

function resolveSize(
  adapterId: string,
  width: number | undefined,
  height: number | undefined,
): string {
  if (width === undefined && height === undefined) return "1024x1024";
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height)
  ) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "width and height must both be supplied as whole numbers, or both omitted.",
        false,
      ),
    );
  }
  const size = `${width}x${height}`;
  if (!ALLOWED_SIZES.has(size)) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "Unsupported image size for this model.",
        false,
        { safeDetails: { allowedSizes: [...ALLOWED_SIZES] } },
      ),
    );
  }
  return size;
}

function resolveOutputFormat(
  adapterId: string,
  outputMediaType: string | undefined,
): { readonly format: string; readonly mediaType: string } {
  const mediaType = (outputMediaType ?? "image/png").trim().toLowerCase();
  const format = ALLOWED_OUTPUT_FORMATS.get(mediaType);
  if (format === undefined) {
    throw new AdapterFailure(
      providerError(
        adapterId,
        "invalid_request",
        "Unsupported output media type.",
        false,
        { safeDetails: { allowed: [...ALLOWED_OUTPUT_FORMATS.keys()] } },
      ),
    );
  }
  return { format, mediaType };
}

function validateRequest(
  adapterId: string,
  input: ImageGenerationInput,
): ValidatedRequest {
  const prompt = validatePrompt(adapterId, input.prompt);
  const size = resolveSize(adapterId, input.width, input.height);
  const outputFormat = resolveOutputFormat(adapterId, input.outputMediaType);
  return {
    prompt,
    size,
    outputFormat: outputFormat.format,
    outputMediaType: outputFormat.mediaType,
  };
}

function extensionFor(mediaType: string): string {
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "jpg";
  return "png";
}

/** `Blob` requires a plain `ArrayBuffer`; a view's backing buffer can be a
 * `SharedArrayBuffer`, which `BlobPart` does not accept. Copying is cheap at
 * these sizes (single images) and keeps the type honest rather than casting
 * past it. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function usageFrom(usage: Record<string, unknown>): readonly UsageQuantity[] {
  const fields: ReadonlyArray<readonly [string, unknown]> = [
    ["input_tokens", usage.input_tokens],
    ["output_tokens", usage.output_tokens],
    ["total_tokens", usage.total_tokens],
  ];
  const quantities: UsageQuantity[] = [];
  for (const [unit, value] of fields) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      quantities.push({ unit, quantity: value });
    }
  }
  return quantities;
}

function parseImageResponse(payload: unknown): ParsedImageResponse {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error("invalid response envelope");
  }
  const first: unknown = payload.data[0];
  if (
    !isRecord(first) ||
    typeof first.b64_json !== "string" ||
    first.b64_json.trim() === ""
  ) {
    throw new Error("missing image data");
  }
  const bytes = base64ToBytes(first.b64_json);
  if (bytes.byteLength === 0) {
    throw new Error("empty image");
  }
  const revisedPrompt =
    typeof first.revised_prompt === "string" ? first.revised_prompt : undefined;
  const usage = isRecord(payload.usage) ? usageFrom(payload.usage) : [];
  return {
    bytes,
    usage,
    ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
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
    "OpenAI rejected the image request.",
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
      if (result.done) break;
      if (totalBytes + result.value.byteLength > maxBytes) {
        await reader.cancel();
        return { ok: false, capturedBytes: maxBytes, truncated: true };
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
    : { capturedBytes: result.capturedBytes, truncated: result.truncated };
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

export class OpenAIImageAdapter implements ImageGenerationProvider {
  readonly id: string;
  readonly #options: NormalizedOptions;

  constructor(options: OpenAIImageAdapterOptions) {
    this.#options = normalizeOptions(options);
    this.id = this.#options.id;
  }

  async capabilities() {
    return [
      {
        capability: "image.generate" as const,
        features: ["text_to_image", "reference_edit"],
        limits: {
          maxReferences: this.#options.maxReferences,
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

  async generate(
    context: ProviderRequestContext,
    input: ImageGenerationInput,
  ): Promise<ProviderOutcome<GeneratedImage>> {
    const startedAt = this.#options.now();
    let request: ValidatedRequest;
    try {
      request = validateRequest(this.id, input);
      if ((input.references?.length ?? 0) > this.#options.maxReferences) {
        throw new AdapterFailure(
          providerError(
            this.id,
            "invalid_request",
            "Too many reference images for one generation call.",
            false,
            { safeDetails: { maxReferences: this.#options.maxReferences } },
          ),
        );
      }
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof AdapterFailure
            ? cause.providerError
            : providerError(
                this.id,
                "invalid_request",
                "The image generation request was invalid.",
                false,
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
          "The provider deadline elapsed before the OpenAI image request.",
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
      if (credential.trim() === "") throw new Error("empty credential");
    } catch {
      clearTimeout(deadlineTimer);
      return {
        ok: false,
        error: providerError(
          this.id,
          deadlineElapsed ? "deadline_exceeded" : "authentication_failed",
          deadlineElapsed
            ? "The OpenAI image request exceeded its deadline."
            : "OpenAI credentials could not be resolved.",
          false,
        ),
        attempts: [],
      };
    }

    const references = input.references ?? [];
    const hasReferences = references.length > 0;
    let referenceBytes: ReadonlyArray<{
      readonly bytes: Uint8Array;
      readonly mediaType: string;
    }> = [];
    if (hasReferences) {
      if (this.#options.objectResolver === undefined) {
        clearTimeout(deadlineTimer);
        credential = "";
        return {
          ok: false,
          error: providerError(
            this.id,
            "feature_unsupported",
            "This adapter is not configured to resolve reference images.",
            false,
          ),
          attempts: [],
        };
      }
      try {
        referenceBytes = await Promise.all(
          references.map(async (ref) => ({
            bytes: await awaitWithAbort(
              this.#options.objectResolver!(context, ref, controller.signal),
              controller.signal,
            ),
            mediaType: ref.mediaType,
          })),
        );
      } catch {
        clearTimeout(deadlineTimer);
        credential = "";
        return {
          ok: false,
          error: providerError(
            this.id,
            deadlineElapsed
              ? "deadline_exceeded"
              : controller.signal.aborted
                ? "aborted"
                : "invalid_request",
            "A reference image could not be resolved.",
            false,
          ),
          attempts: [],
        };
      }
    }

    const endpoint = hasReferences
      ? this.#options.editsEndpoint
      : this.#options.generationsEndpoint;
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential}`,
      "x-client-request-id": context.requestId,
      accept: "application/json",
    };
    let body: BodyInit;
    let requestByteLength: number;
    if (hasReferences) {
      const form = new FormData();
      form.set("model", this.#options.model);
      form.set("prompt", request.prompt);
      form.set("size", request.size);
      form.set("n", "1");
      form.set("output_format", request.outputFormat);
      referenceBytes.forEach((reference, index) => {
        form.append(
          "image[]",
          new Blob([toArrayBuffer(reference.bytes)], { type: reference.mediaType }),
          `reference-${index}.${extensionFor(reference.mediaType)}`,
        );
      });
      body = form;
      requestByteLength =
        referenceBytes.reduce((total, ref) => total + ref.bytes.byteLength, 0) +
        encoder.encode(request.prompt).byteLength;
    } else {
      const json = JSON.stringify({
        model: this.#options.model,
        prompt: request.prompt,
        size: request.size,
        n: 1,
        output_format: request.outputFormat,
      });
      headers["content-type"] = "application/json";
      body = json;
      requestByteLength = encoder.encode(json).byteLength;
    }

    if (requestByteLength > this.#options.maxRequestBytes) {
      clearTimeout(deadlineTimer);
      credential = "";
      return {
        ok: false,
        error: providerError(
          this.id,
          "invalid_request",
          "The OpenAI image request exceeds the configured size limit.",
          false,
          { safeDetails: { limitBytes: this.#options.maxRequestBytes } },
        ),
        attempts: [],
      };
    }

    let response: Response;
    try {
      response = await this.#options.fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(deadlineTimer);
      return {
        ok: false,
        error: providerError(
          this.id,
          deadlineElapsed
            ? "deadline_exceeded"
            : controller.signal.aborted
              ? "aborted"
              : "provider_unavailable",
          deadlineElapsed
            ? "The OpenAI image request exceeded its deadline."
            : controller.signal.aborted
              ? "The OpenAI image request was aborted."
              : "OpenAI could not be reached.",
          !controller.signal.aborted,
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
        error: httpError(this.id, response.status, providerRequestId, bodyMetadata),
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
          "OpenAI returned a non-JSON image response.",
          true,
          {
            safeDetails: {
              contentTypeAccepted: false,
              ...(providerRequestId === undefined ? {} : { providerRequestId }),
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
          "The OpenAI image response exceeds the configured size limit.",
          true,
          {
            safeDetails: {
              limitBytes: this.#options.maxResponseBytes,
              ...(providerRequestId === undefined ? {} : { providerRequestId }),
            },
          },
        ),
        attempts: [],
      };
    }

    const boundedBody = await readBoundedBody(response, this.#options.maxResponseBytes);
    clearTimeout(deadlineTimer);
    if (!boundedBody.ok) {
      return {
        ok: false,
        error: providerError(
          this.id,
          deadlineElapsed ? "deadline_exceeded" : "response_invalid",
          deadlineElapsed
            ? "The OpenAI image response exceeded its deadline."
            : "The OpenAI image response exceeds the configured size limit.",
          true,
          {
            safeDetails: {
              limitBytes: this.#options.maxResponseBytes,
              ...(providerRequestId === undefined ? {} : { providerRequestId }),
            },
          },
        ),
        attempts: [],
      };
    }

    let parsed: ParsedImageResponse;
    try {
      const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(
        boundedBody.bytes,
      );
      parsed = parseImageResponse(JSON.parse(bodyText) as unknown);
    } catch {
      return {
        ok: false,
        error: providerError(
          this.id,
          "response_invalid",
          "OpenAI returned an invalid image response.",
          true,
          {
            safeDetails:
              providerRequestId === undefined ? {} : { providerRequestId },
          },
        ),
        attempts: [],
      };
    }

    let object: ProtectedObjectRef;
    try {
      object = await this.#options.store(
        context,
        parsed.bytes,
        request.outputMediaType,
      );
    } catch {
      return {
        ok: false,
        error: providerError(
          this.id,
          "provider_error",
          "The generated image could not be stored.",
          false,
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
          this.#options.model,
          parsed.usage,
        )) ?? ZERO_COST;
    } catch {
      return {
        ok: false,
        error: providerError(
          this.id,
          "provider_error",
          "OpenAI image cost accounting failed.",
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
        value: {
          object,
          ...(parsed.revisedPrompt === undefined
            ? {}
            : { revisedPrompt: parsed.revisedPrompt }),
        },
        provider: "openai",
        adapterId: this.id,
        modelOrSku: this.#options.model,
        latencyMs: Math.max(0, this.#options.now() - startedAt),
        usage: parsed.usage,
        estimatedCost,
        providerMetadata: {
          costEstimated: this.#options.estimateUsageCost !== undefined,
          editUsed: hasReferences,
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
        },
      },
    };
  }
}
