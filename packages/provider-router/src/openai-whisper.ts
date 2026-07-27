import type {
  JsonObject,
  Money,
  ProviderError,
  ProviderRequestContext,
  ProviderStreamEvent,
  TranscriptEvent,
  TranscriptionOptions,
  TranscriptionProvider,
  UsageQuantity,
} from "@course-ai/contracts";
import type { OpenAICredentialResolver } from "./openai-responses.js";

/**
 * OpenAI Whisper batch transcription adapter for the `speech.transcribe`
 * capability (docs/PLAN.md Section 4: "audio/video via transcription").
 *
 * This is scaffolding for a future upload media type, not part of the file
 * type taken end to end in this pass (plain text / transcript uploads,
 * which already arrive as text and need no transcription at all). It exists
 * now because the plan calls for it explicitly and because every provider
 * call in this codebase — including ones not yet wired to a route — goes
 * through `provider-router` rather than a vendor SDK. Nothing imports this
 * adapter yet; it activates the moment a caller constructs it with a real
 * `credentialResolver`, which the console only does when `OPENAI_API_KEY`
 * is configured (see `.env.example`).
 *
 * Whisper's REST endpoint is a single batch call, not a token stream, so
 * `transcribe()` — which the `TranscriptionProvider` contract shapes as a
 * stream — always yields exactly one `"final"` event before completing.
 * That is a correct, honest implementation of the contract for a
 * non-streaming backend, not a shortcut: no `"partial"` event is ever
 * fabricated.
 */

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";
// Matches the upload size ceiling already used for quarantine uploads
// (`requested_size_bytes not between 1 and 26214400` in
// infra/supabase/migrations/0026_authenticated_quarantine_uploads.sql) and
// OpenAI's own 25 MiB limit for this endpoint.
const DEFAULT_MAX_AUDIO_BYTES = 26_214_400;
const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_ERROR_BODY_BYTES = 16_384;
const ZERO_COST: Money = { amount: 0, currency: "USD" };

export interface OpenAIWhisperAdapterOptions {
  readonly id: string;
  readonly credentialResolver: OpenAICredentialResolver;
  readonly model?: string;
  /** OpenAI infers audio format from this filename's extension, not the byte content. */
  readonly filename?: string;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly maxAudioBytes?: number;
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
  readonly model: string;
  readonly filename: string;
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly maxAudioBytes: number;
  readonly maxResponseBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly now: () => number;
  readonly estimateUsageCost?: OpenAIWhisperAdapterOptions["estimateUsageCost"];
}

function providerError(
  adapterId: string,
  code: ProviderError["code"],
  message: string,
  retryable: boolean,
  extra: { readonly providerStatus?: number; readonly safeDetails?: JsonObject } = {},
): ProviderError {
  return {
    code,
    message,
    retryable,
    adapterId,
    ...(extra.providerStatus === undefined ? {} : { providerStatus: extra.providerStatus }),
    ...(extra.safeDetails === undefined ? {} : { safeDetails: extra.safeDetails }),
  };
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function normalizeOptions(options: OpenAIWhisperAdapterOptions): NormalizedOptions {
  if (options.id.trim() === "") {
    throw new TypeError("The adapter id must not be empty.");
  }
  return {
    id: options.id,
    credentialResolver: options.credentialResolver,
    model: options.model?.trim() || DEFAULT_MODEL,
    filename: options.filename?.trim() || "audio.wav",
    fetch: options.fetch ?? globalThis.fetch,
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    maxAudioBytes: positiveSafeInteger(options.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES, "maxAudioBytes"),
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
    ...(options.estimateUsageCost === undefined ? {} : { estimateUsageCost: options.estimateUsageCost }),
  };
}

// A Uint8Array's backing buffer can be typed as ArrayBufferLike (which
// admits SharedArrayBuffer), but BlobPart requires a real ArrayBuffer.
// Matches the identical helper in openai-image.ts.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bufferBounded(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) return { ok: false };
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total > maxBytes ? maxBytes : total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    bytes.set(chunk.subarray(0, bytes.length - offset), offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function httpErrorCode(status: number): ProviderError["code"] {
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 409 || status >= 500) return "provider_unavailable";
  return "invalid_request";
}

export class OpenAIWhisperAdapter implements TranscriptionProvider {
  readonly id: string;
  readonly #options: NormalizedOptions;

  constructor(options: OpenAIWhisperAdapterOptions) {
    this.#options = normalizeOptions(options);
    this.id = this.#options.id;
  }

  async capabilities() {
    return [
      {
        capability: "speech.transcribe" as const,
        features: ["batch", "language_hint", "vocabulary_prompt"],
        limits: { maxAudioBytes: this.#options.maxAudioBytes },
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

  async *transcribe(
    context: ProviderRequestContext,
    audio: AsyncIterable<Uint8Array>,
    options: TranscriptionOptions,
  ): AsyncIterable<ProviderStreamEvent<TranscriptEvent>> {
    const startedAt = this.#options.now();

    const buffered = await bufferBounded(audio, this.#options.maxAudioBytes);
    if (!buffered.ok) {
      yield {
        type: "error",
        error: providerError(
          this.id,
          "invalid_request",
          "The audio exceeds the configured size limit for transcription.",
          false,
          { safeDetails: { limitBytes: this.#options.maxAudioBytes } },
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
          "The provider deadline elapsed before the transcription request.",
          false,
        ),
      };
      return;
    }

    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), Math.min(remainingMs, 2_147_483_647));

    let credential: string;
    try {
      credential = await this.#options.credentialResolver(context, controller.signal);
      if (credential.trim() === "") throw new Error("empty credential");
    } catch {
      clearTimeout(deadlineTimer);
      yield {
        type: "error",
        error: providerError(this.id, "authentication_failed", "OpenAI credentials could not be resolved.", false),
      };
      return;
    }

    const formData = new FormData();
    formData.set("file", new Blob([toArrayBuffer(buffered.bytes)]), this.#options.filename);
    formData.set("model", this.#options.model);
    formData.set("response_format", "verbose_json");
    if (options.language !== undefined) formData.set("language", options.language);
    if (options.vocabulary !== undefined && options.vocabulary.length > 0) {
      formData.set("prompt", options.vocabulary.join(", ").slice(0, 900));
    }

    let response: Response;
    try {
      response = await this.#options.fetch(this.#options.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "x-client-request-id": context.requestId,
        },
        body: formData,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(deadlineTimer);
      yield {
        type: "error",
        error: providerError(this.id, "provider_unavailable", "OpenAI could not be reached.", true),
      };
      return;
    } finally {
      credential = "";
    }

    if (!response.ok) {
      const bodyText = await readBoundedText(response, this.#options.maxErrorBodyBytes);
      clearTimeout(deadlineTimer);
      yield {
        type: "error",
        error: providerError(
          this.id,
          httpErrorCode(response.status),
          "OpenAI rejected the transcription request.",
          response.status === 429 || response.status >= 500,
          { providerStatus: response.status, safeDetails: { responseBodyBytes: bodyText.length } },
        ),
      };
      return;
    }

    const bodyText = await readBoundedText(response, this.#options.maxResponseBytes);
    clearTimeout(deadlineTimer);

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      yield {
        type: "error",
        error: providerError(this.id, "response_invalid", "OpenAI returned an invalid transcription response.", true),
      };
      return;
    }
    if (!isRecord(parsed) || typeof parsed.text !== "string") {
      yield {
        type: "error",
        error: providerError(this.id, "response_invalid", "OpenAI's transcription response was missing text.", true),
      };
      return;
    }

    const durationSeconds =
      typeof parsed.duration === "number" && Number.isFinite(parsed.duration) && parsed.duration >= 0
        ? Math.ceil(parsed.duration)
        : 0;
    const usage: readonly UsageQuantity[] = [{ unit: "audio_seconds", quantity: durationSeconds }];

    let estimatedCost = ZERO_COST;
    try {
      estimatedCost = (await this.#options.estimateUsageCost?.(this.#options.model, usage)) ?? ZERO_COST;
    } catch {
      yield {
        type: "error",
        error: providerError(this.id, "provider_error", "Transcription cost accounting failed.", false),
      };
      return;
    }

    yield { type: "data", value: { type: "final", text: parsed.text } };
    yield {
      type: "complete",
      result: {
        provider: "openai",
        adapterId: this.id,
        modelOrSku: this.#options.model,
        latencyMs: Math.max(0, this.#options.now() - startedAt),
        usage,
        estimatedCost,
        providerMetadata: {
          costEstimated: this.#options.estimateUsageCost !== undefined,
          durationSeconds,
        },
      },
    };
  }
}
