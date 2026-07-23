# Provider Routers

## Rule

Product services import capability contracts and routers only. Provider SDK imports are confined to adapter packages. Platform defaults named in v3 are adapter configuration, not domain dependencies.

## Common contracts

```ts
type Capability =
  | "llm.chat"|"embedding"|"rerank"|"speech.transcribe"|"speech.synthesize"
  | "voice.realtime"|"vision.analyze"|"image.generate"|"storage"|"queue"
  | "email"|"analytics"|"auth"|"vector"|"observability"|"webhook"
  | "billing"|"mcp";

interface ProviderRequestContext {
  requestId: string; traceId: string; tenantId: string; actorId?: string;
  fundingSource: "platform"|"tenant_byok"; deadlineMs: number;
}
interface ProviderResult<T> {
  value: T; provider: string; modelOrSku?: string; latencyMs: number;
  usage: Array<{quantity:number; unit:string}>; estimatedCost: number;
  providerMetadata: Record<string, unknown>; degradedFrom?: string[];
}
interface ProviderHealth {
  status: "healthy"|"degraded"|"unavailable"|"unknown";
  checkedAt: string; latencyMs?: number; reasonCode?: string;
}
interface ProviderAdapter {
  readonly id: string;
  capabilities(): Promise<Array<{capability:Capability; features:string[]; limits:Record<string,number>}>>;
  health(capability: Capability): Promise<ProviderHealth>;
}
interface RoutePolicy {
  tenantId: string; capability: Capability; primaryAdapter: string;
  fallbackAdapters: string[]; secretRef?: string;
  timeoutMs: number; maxAttempts: number; circuitBreaker: {failures:number; resetMs:number};
  requiredFeatures: string[]; maxEstimatedCost?: number;
}
```

Routers resolve tenant policy → validate capability/feature/secret → consult health/circuit → execute within one total deadline → retry only safe/idempotent operations → compatible fallback → emit audit/trace/cost per attempt → return typed degradation or failure. Provider metadata is stored separately and never drives core policy without normalization.

## Capability interfaces

```ts
interface LLMProvider extends ProviderAdapter {
  streamChat(ctx:ProviderRequestContext, input:{messages:unknown[]; tools?:unknown[]; model?:string}): AsyncIterable<unknown>;
  complete(ctx:ProviderRequestContext, input:unknown): Promise<ProviderResult<unknown>>;
}
interface EmbeddingProvider extends ProviderAdapter { embed(ctx:ProviderRequestContext, texts:string[]):Promise<ProviderResult<number[][]>>; }
interface RerankProvider extends ProviderAdapter { rerank(ctx:ProviderRequestContext, query:string, docs:string[]):Promise<ProviderResult<number[]>>; }
interface TranscriptionProvider extends ProviderAdapter { transcribe(ctx:ProviderRequestContext, audio:ReadableStream, options:unknown):AsyncIterable<unknown>; }
interface TextToSpeechProvider extends ProviderAdapter { synthesize(ctx:ProviderRequestContext, text:AsyncIterable<string>, voice:string):AsyncIterable<unknown>; }
interface RealtimeVoiceProvider extends ProviderAdapter { openSession(ctx:ProviderRequestContext, options:unknown):Promise<ProviderResult<RealtimeVoiceSession>>; }
interface VisionProvider extends ProviderAdapter { analyze(ctx:ProviderRequestContext, image:unknown, schema:unknown):Promise<ProviderResult<unknown>>; }
interface ImageGenerationProvider extends ProviderAdapter { generate(ctx:ProviderRequestContext, spec:unknown):Promise<ProviderResult<unknown>>; }
interface StorageProvider extends ProviderAdapter { put(ctx:ProviderRequestContext, key:string, body:unknown):Promise<ProviderResult<unknown>>; getSignedUrl(ctx:ProviderRequestContext,key:string,ttlSec:number):Promise<ProviderResult<string>>; }
interface QueueProvider extends ProviderAdapter { enqueue(ctx:ProviderRequestContext, job:unknown):Promise<ProviderResult<string>>; }
interface EmailProvider extends ProviderAdapter { send(ctx:ProviderRequestContext, message:unknown):Promise<ProviderResult<string>>; }
interface AnalyticsProvider extends ProviderAdapter { capture(ctx:ProviderRequestContext, events:unknown[]):Promise<ProviderResult<void>>; }
interface AuthenticationProvider extends ProviderAdapter { verify(token:string):Promise<ProviderResult<unknown>>; }
interface VectorDatabaseProvider extends ProviderAdapter { upsert(ctx:ProviderRequestContext, rows:unknown[]):Promise<ProviderResult<void>>; query(ctx:ProviderRequestContext,q:unknown):Promise<ProviderResult<unknown[]>>; }
interface ObservabilityProvider extends ProviderAdapter { emit(ctx:ProviderRequestContext, signal:unknown):Promise<ProviderResult<void>>; }
interface WebhookProvider extends ProviderAdapter { deliver(ctx:ProviderRequestContext, delivery:unknown):Promise<ProviderResult<unknown>>; }
interface BillingProvider extends ProviderAdapter { reportUsage(ctx:ProviderRequestContext, usage:unknown):Promise<ProviderResult<void>>; }
interface ToolRouter { invoke(ctx:ProviderRequestContext, grant:ToolGrant, input:unknown):Promise<ProviderResult<unknown>>; }
interface MCPRegistry { resolve(tenantId:string, serverId:string, tool:string):Promise<RegisteredTool>; }
```

`RealtimeVoiceSession`, `ToolGrant` and `RegisteredTool` are defined in [Voice](13-VOICE-MODE.md) and [MCP](14-MCP-AND-TOOLS-ARCHITECTURE.md).

## BYOK and secrets

Configuration stores only a Vault handle, prefix/status and policy. Resolution occurs server-side just-in-time. Logs, errors, traces and provider metadata are redacted. Key test/rotate/revoke actions are authorized and audited. Fallback cannot change from tenant-funded to platform-funded without explicit policy.

## Conformance tests

Every adapter passes contract fixtures for capabilities, timeout/abort, error normalization, usage/cost, metadata redaction, health, idempotency and streaming cleanup. Router tests cover tenant selection, defaults, BYOK, missing feature, open circuit, fallback compatibility, total deadline, cost cap and graceful degradation.
