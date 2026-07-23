import type {
  ActorId,
  AsyncByteStream,
  ContentHash,
  CurrencyCode,
  IsoTimestamp,
  JsonObject,
  JsonValue,
  ProtectedObjectRef,
  RequestId,
  TenantId,
  TraceId,
} from "./common.js";
import type { FundingSource } from "./context.js";

export const CAPABILITIES = [
  "llm.chat",
  "embedding",
  "rerank",
  "speech.transcribe",
  "speech.synthesize",
  "voice.realtime",
  "vision.analyze",
  "image.generate",
  "storage",
  "queue",
  "email",
  "analytics",
  "auth",
  "vector",
  "observability",
  "webhook",
  "billing",
  "mcp",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type ProviderHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown";

export interface ProviderRequestContext {
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly tenantId: TenantId;
  readonly actorId?: ActorId;
  readonly fundingSource: FundingSource;
  /** Absolute Unix timestamp shared across all attempts. */
  readonly deadlineMs: number;
  readonly idempotencyKey?: string;
}

export interface UsageQuantity {
  readonly quantity: number;
  readonly unit: string;
}

export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export interface ProviderResult<T> {
  readonly value: T;
  readonly provider: string;
  readonly adapterId: string;
  readonly modelOrSku?: string;
  readonly latencyMs: number;
  readonly usage: readonly UsageQuantity[];
  readonly estimatedCost: Money;
  /**
   * Redacted, bounded integration metadata. Core policy must not depend on
   * fields here without first normalizing them into a contract field.
   */
  readonly providerMetadata: JsonObject;
  readonly degradedFrom?: readonly string[];
}

export type ProviderErrorCode =
  | "aborted"
  | "deadline_exceeded"
  | "invalid_request"
  | "authentication_failed"
  | "permission_denied"
  | "capability_unavailable"
  | "feature_unsupported"
  | "rate_limited"
  | "budget_exceeded"
  | "provider_unavailable"
  | "provider_error"
  | "response_invalid";

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly adapterId?: string;
  readonly providerStatus?: number;
  readonly safeDetails?: JsonObject;
}

export type ProviderOutcome<T> =
  | { readonly ok: true; readonly result: ProviderResult<T> }
  | {
      readonly ok: false;
      readonly error: ProviderError;
      readonly attempts: readonly ProviderAttempt[];
    };

export interface ProviderAttempt {
  readonly adapterId: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly errorCode?: ProviderErrorCode;
  readonly estimatedCost?: Money;
}

export interface ProviderHealth {
  readonly status: ProviderHealthStatus;
  readonly checkedAt: IsoTimestamp;
  readonly latencyMs?: number;
  readonly reasonCode?: string;
}

export interface CapabilityDescriptor {
  readonly capability: Capability;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface ProviderAdapter {
  readonly id: string;
  capabilities(): Promise<readonly CapabilityDescriptor[]>;
  health(capability: Capability): Promise<ProviderHealth>;
}

export interface CircuitBreakerPolicy {
  readonly failures: number;
  readonly resetMs: number;
}

export interface RoutePolicy {
  readonly tenantId: TenantId;
  readonly capability: Capability;
  readonly primaryAdapter: string;
  readonly fallbackAdapters: readonly string[];
  /** Vault handle only; never a raw credential. */
  readonly secretRef?: string;
  readonly fundingSource: FundingSource;
  readonly allowFundingSourceFallback: boolean;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly circuitBreaker: CircuitBreakerPolicy;
  readonly requiredFeatures: readonly string[];
  readonly maxEstimatedCost?: Money;
}

export interface RouteOptions {
  readonly requiredFeatures?: readonly string[];
  readonly modelOrSku?: string;
  readonly idempotent?: boolean;
}

export interface RouteDecision {
  readonly capability: Capability;
  readonly adapterId: string;
  readonly policyVersion: string;
  readonly fundingSource: FundingSource;
  readonly degradedFrom?: readonly string[];
}

export interface CapabilityRouter<TInput, TOutput> {
  readonly capability: Capability;
  route(
    context: ProviderRequestContext,
    options?: RouteOptions,
  ): Promise<ProviderOutcome<RouteDecision>>;
  execute(
    context: ProviderRequestContext,
    input: TInput,
    options?: RouteOptions,
  ): Promise<ProviderOutcome<TOutput>>;
}

export interface StreamingCapabilityRouter<TInput, TEvent> {
  readonly capability: Capability;
  stream(
    context: ProviderRequestContext,
    input: TInput,
    options?: RouteOptions,
  ): AsyncIterable<ProviderStreamEvent<TEvent>>;
}

export type ProviderStreamEvent<T> =
  | { readonly type: "data"; readonly value: T }
  | {
      readonly type: "complete";
      readonly result: Omit<ProviderResult<void>, "value">;
    }
  | { readonly type: "error"; readonly error: ProviderError };

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: JsonValue;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ChatCompletionInput {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly responseSchema?: JsonObject;
}

export type ChatStreamChunk =
  | { readonly type: "text.delta"; readonly text: string }
  | {
      readonly type: "tool_call.delta";
      readonly callId: string;
      readonly toolName: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "finish"; readonly reason: string };

export interface ChatCompletion {
  readonly message: ModelMessage;
  readonly finishReason: string;
}

export interface LLMProvider extends ProviderAdapter {
  streamChat(
    context: ProviderRequestContext,
    input: ChatCompletionInput,
  ): AsyncIterable<ProviderStreamEvent<ChatStreamChunk>>;
  complete(
    context: ProviderRequestContext,
    input: ChatCompletionInput,
  ): Promise<ProviderOutcome<ChatCompletion>>;
}

export interface EmbeddingInput {
  readonly texts: readonly string[];
  readonly model?: string;
  readonly dimensions?: number;
}

export interface EmbeddingOutput {
  readonly vectors: readonly (readonly number[])[];
}

export interface EmbeddingProvider extends ProviderAdapter {
  embed(
    context: ProviderRequestContext,
    input: EmbeddingInput,
  ): Promise<ProviderOutcome<EmbeddingOutput>>;
}

export interface RerankDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata?: JsonObject;
}

export interface RerankInput {
  readonly query: string;
  readonly documents: readonly RerankDocument[];
  readonly topK?: number;
  readonly model?: string;
}

export interface RerankScore {
  readonly documentId: string;
  readonly score: number;
}

export interface RerankProvider extends ProviderAdapter {
  rerank(
    context: ProviderRequestContext,
    input: RerankInput,
  ): Promise<ProviderOutcome<readonly RerankScore[]>>;
}

export interface TranscriptionOptions {
  readonly language?: string;
  readonly vocabulary?: readonly string[];
  readonly interimResults?: boolean;
}

export type TranscriptEvent =
  | {
      readonly type: "partial";
      readonly text: string;
      readonly startMs?: number;
      readonly endMs?: number;
    }
  | {
      readonly type: "final";
      readonly text: string;
      readonly confidence?: number;
      readonly startMs?: number;
      readonly endMs?: number;
    };

export interface TranscriptionProvider extends ProviderAdapter {
  transcribe(
    context: ProviderRequestContext,
    audio: AsyncByteStream,
    options: TranscriptionOptions,
  ): AsyncIterable<ProviderStreamEvent<TranscriptEvent>>;
}

export interface SpeechSynthesisOptions {
  readonly voiceId: string;
  readonly language?: string;
  readonly format?: "pcm16" | "mp3" | "opus";
  readonly sampleRateHz?: number;
}

export interface AudioChunk {
  readonly bytes: Uint8Array;
  readonly sequence: number;
  readonly mediaType: string;
}

export interface TextToSpeechProvider extends ProviderAdapter {
  synthesize(
    context: ProviderRequestContext,
    text: AsyncIterable<string>,
    options: SpeechSynthesisOptions,
  ): AsyncIterable<ProviderStreamEvent<AudioChunk>>;
}

export type RealtimeVoiceEvent =
  | { readonly type: "transcript.partial"; readonly text: string }
  | {
      readonly type: "transcript.final";
      readonly text: string;
      readonly confidence?: number;
    }
  | { readonly type: "response.delta"; readonly text: string }
  | { readonly type: "audio.chunk"; readonly chunk: AudioChunk }
  | { readonly type: "turn.end" }
  | { readonly type: "error"; readonly error: ProviderError };

export interface RealtimeVoiceSession {
  readonly id: string;
  sendAudio(chunk: Uint8Array): Promise<void>;
  commitTurn(): Promise<void>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<RealtimeVoiceEvent>;
  close(reason: string): Promise<void>;
}

export interface RealtimeVoiceOptions {
  readonly voiceId: string;
  readonly language?: string;
  readonly mode: "push_to_talk" | "tap_to_start";
  readonly enableBargeIn: boolean;
  readonly instructions?: string;
}

export interface RealtimeVoiceProvider extends ProviderAdapter {
  openSession(
    context: ProviderRequestContext,
    options: RealtimeVoiceOptions,
  ): Promise<ProviderOutcome<RealtimeVoiceSession>>;
}

export interface VisionInput {
  readonly image: ProtectedObjectRef;
  readonly instruction: string;
  readonly responseSchema?: JsonObject;
}

export interface VisionProvider extends ProviderAdapter {
  analyze(
    context: ProviderRequestContext,
    input: VisionInput,
  ): Promise<ProviderOutcome<JsonValue>>;
}

export interface ImageGenerationInput {
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
  readonly outputMediaType?: string;
  readonly references?: readonly ProtectedObjectRef[];
}

export interface GeneratedImage {
  readonly object: ProtectedObjectRef;
  readonly revisedPrompt?: string;
}

export interface ImageGenerationProvider extends ProviderAdapter {
  generate(
    context: ProviderRequestContext,
    input: ImageGenerationInput,
  ): Promise<ProviderOutcome<GeneratedImage>>;
}

export interface StoragePutInput {
  readonly key: string;
  readonly body: AsyncByteStream;
  readonly mediaType: string;
  readonly sizeBytes?: number;
  readonly contentHash?: ContentHash;
  readonly metadata?: JsonObject;
}

export interface StorageProvider extends ProviderAdapter {
  put(
    context: ProviderRequestContext,
    input: StoragePutInput,
  ): Promise<ProviderOutcome<ProtectedObjectRef>>;
  getSignedUrl(
    context: ProviderRequestContext,
    key: string,
    ttlSeconds: number,
  ): Promise<ProviderOutcome<string>>;
}

export interface QueueJob {
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly type: string;
  readonly schemaVersion: number;
  readonly idempotencyKey: string;
  readonly payloadRef: ProtectedObjectRef;
  readonly priority: number;
  readonly traceId: TraceId;
}

export interface QueueProvider extends ProviderAdapter {
  enqueue(
    context: ProviderRequestContext,
    job: QueueJob,
  ): Promise<ProviderOutcome<string>>;
}

export interface EmailMessage {
  readonly templateId: string;
  readonly recipientRef: string;
  readonly variables: JsonObject;
  readonly idempotencyKey: string;
}

export interface EmailProvider extends ProviderAdapter {
  send(
    context: ProviderRequestContext,
    message: EmailMessage,
  ): Promise<ProviderOutcome<string>>;
}

export interface AnalyticsProvider extends ProviderAdapter {
  capture(
    context: ProviderRequestContext,
    events: readonly JsonObject[],
  ): Promise<ProviderOutcome<void>>;
}

export interface AuthenticationInput {
  readonly token: string;
  readonly expectedAudience?: string;
}

export interface AuthenticationIdentity {
  readonly subject: string;
  readonly claims: JsonObject;
  readonly expiresAt?: IsoTimestamp;
}

export interface AuthenticationProvider extends ProviderAdapter {
  verify(
    input: AuthenticationInput,
  ): Promise<ProviderOutcome<AuthenticationIdentity>>;
}

export interface VectorRow {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly vector: readonly number[];
  readonly metadata: JsonObject;
}

export interface VectorQuery {
  readonly tenantId: TenantId;
  readonly vector: readonly number[];
  readonly topK: number;
  readonly filter?: JsonObject;
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: JsonObject;
}

export interface VectorDatabaseProvider extends ProviderAdapter {
  upsert(
    context: ProviderRequestContext,
    rows: readonly VectorRow[],
  ): Promise<ProviderOutcome<void>>;
  query(
    context: ProviderRequestContext,
    query: VectorQuery,
  ): Promise<ProviderOutcome<readonly VectorMatch[]>>;
}

export interface ObservabilityProvider extends ProviderAdapter {
  emit(
    context: ProviderRequestContext,
    signal: JsonObject,
  ): Promise<ProviderOutcome<void>>;
}

export interface WebhookDelivery {
  readonly destinationRef: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly signatureVersion: string;
  readonly idempotencyKey: string;
}

export interface WebhookProvider extends ProviderAdapter {
  deliver(
    context: ProviderRequestContext,
    delivery: WebhookDelivery,
  ): Promise<ProviderOutcome<JsonObject>>;
}

export interface BillingProvider extends ProviderAdapter {
  reportUsage(
    context: ProviderRequestContext,
    usage: JsonObject,
  ): Promise<ProviderOutcome<void>>;
}
