import type {
  ActorId,
  AudioChunk,
  ConversationId,
  FundingSource,
  IsoTimestamp,
  JsonObject,
  Money,
  ProviderErrorCode,
  ProviderRequestContext,
  RequestId,
  SessionId,
  TenantId,
  TraceId,
  UsageQuantity,
} from "@course-ai/contracts";

/**
 * Realtime voice requires an authenticated actor and durable conversation.
 * This deliberately tightens ProviderRequestContext's optional actor field.
 */
export interface VoiceSessionContext extends ProviderRequestContext {
  readonly actorId: ActorId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
}

export type VoiceSessionState =
  | "idle"
  | "opening"
  | "connected"
  | "listening"
  | "responding"
  | "reconnecting"
  | "text_handoff"
  | "closing"
  | "closed"
  | "failed";

export interface ReconnectPolicy {
  /** Total resume attempts after the original connection. */
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface VoiceSessionOptions {
  readonly voiceId: string;
  readonly language?: string;
  readonly mode: "push_to_talk" | "tap_to_start";
  readonly enableBargeIn: boolean;
  readonly instructions?: string;
  readonly inputMediaType: string;
  readonly outputMediaType: string;
  readonly reconnect: ReconnectPolicy;
  /**
   * Opaque server-side credential handle. It may reach an adapter, but is
   * excluded from all descriptors, normalized errors, events and telemetry.
   */
  readonly secretRef?: string;
}

/**
 * Safe to return to an authenticated browser. clientToken MUST be ephemeral
 * and scoped by the adapter to this exact tenant/session/conversation tuple.
 */
export interface EphemeralClientSessionDescriptor {
  readonly credentialKind: "ephemeral";
  readonly clientToken: string;
  readonly expiresAt: IsoTimestamp;
  readonly endpoint: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly providerSessionId: string;
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
}

export interface VoiceResumeCheckpoint {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly lastEventSequence: number;
  readonly lastCompletedTurnId?: string;
}

export interface AdapterOpenOptions {
  readonly voiceId: string;
  readonly language?: string;
  readonly mode: "push_to_talk" | "tap_to_start";
  readonly enableBargeIn: boolean;
  readonly instructions?: string;
  readonly inputMediaType: string;
  readonly outputMediaType: string;
  readonly signal: AbortSignal;
  /** Opaque server-side handle only. */
  readonly secretRef?: string;
}

export interface AdapterResumeOptions {
  readonly signal: AbortSignal;
  /** Opaque server-side handle only. */
  readonly secretRef?: string;
}

export type VoiceAdapterErrorCode =
  | ProviderErrorCode
  | "connection_lost"
  | "session_expired"
  | "session_mismatch"
  | "protocol_error";

export interface VoiceAdapterError {
  readonly code: VoiceAdapterErrorCode;
  /** Adapter-authored message is treated as unsafe and is never forwarded. */
  readonly message?: string;
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly safeDetails?: JsonObject;
}

export type VoiceAdapterOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VoiceAdapterError };

export type VoiceAdapterEvent =
  | {
      readonly type: "input_audio.accepted";
      readonly sequence: number;
      readonly byteLength: number;
    }
  | {
      readonly type: "transcript.partial";
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "transcript.final";
      readonly sequence: number;
      readonly text: string;
      readonly confidence?: number;
      readonly turnId: string;
    }
  | {
      readonly type: "assistant.text.delta";
      readonly sequence: number;
      readonly text: string;
      readonly turnId: string;
    }
  | {
      readonly type: "assistant.text.final";
      readonly sequence: number;
      readonly text: string;
      readonly turnId: string;
    }
  | {
      readonly type: "assistant.audio.delta";
      readonly sequence: number;
      readonly chunk: AudioChunk;
      readonly turnId: string;
    }
  | {
      readonly type: "turn.started";
      readonly sequence: number;
      readonly turnId: string;
    }
  | {
      readonly type: "turn.completed";
      readonly sequence: number;
      readonly turnId: string;
    }
  | {
      readonly type: "turn.interrupted";
      readonly sequence: number;
      readonly turnId: string;
    }
  | {
      readonly type: "usage";
      readonly sequence: number;
      readonly usage: readonly UsageQuantity[];
      readonly estimatedCost: Money;
      readonly modelOrSku?: string;
    }
  | {
      readonly type: "disconnected";
      readonly sequence: number;
      readonly retryable: boolean;
      readonly reasonCode: string;
    }
  | {
      readonly type: "error";
      readonly sequence: number;
      readonly error: VoiceAdapterError;
    };

export interface RealtimeVoiceTransport {
  readonly providerSessionId: string;
  sendAudio(chunk: Uint8Array): Promise<void>;
  commitTurn(): Promise<void>;
  sendText(text: string): Promise<void>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<VoiceAdapterEvent>;
  close(reason: string): Promise<void>;
}

export interface VoiceAdapterConnection {
  readonly descriptor: EphemeralClientSessionDescriptor;
  readonly transport: RealtimeVoiceTransport;
}

export interface RealtimeVoiceAdapter {
  readonly id: string;
  readonly provider: string;
  openSession(
    context: VoiceSessionContext,
    options: AdapterOpenOptions,
  ): Promise<VoiceAdapterOutcome<VoiceAdapterConnection>>;
  resumeSession(
    context: VoiceSessionContext,
    checkpoint: VoiceResumeCheckpoint,
    options: AdapterResumeOptions,
  ): Promise<VoiceAdapterOutcome<VoiceAdapterConnection>>;
}

export interface NormalizedVoiceError {
  readonly code: VoiceAdapterErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly fallback: "retry" | "text" | "none";
  readonly adapterId?: string;
  readonly providerStatus?: number;
  readonly safeDetails?: JsonObject;
}

export interface VoiceUsageEvent {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly fundingSource: FundingSource;
  readonly usage: readonly UsageQuantity[];
  readonly modelOrSku?: string;
  readonly occurredAt: IsoTimestamp;
}

export interface VoiceCostEvent {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly providerSessionId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly fundingSource: FundingSource;
  readonly estimatedCost: Money;
  readonly usage: readonly UsageQuantity[];
  readonly modelOrSku?: string;
  readonly occurredAt: IsoTimestamp;
}

export interface VoiceUsageSink {
  recordUsage(event: VoiceUsageEvent): Promise<void>;
}

export interface VoiceCostSink {
  recordCost(event: VoiceCostEvent): Promise<void>;
}

export type VoiceSessionEvent =
  | {
      readonly type: "session.state";
      readonly state: VoiceSessionState;
      readonly previousState: VoiceSessionState;
    }
  | {
      readonly type: "input.audio";
      readonly sequence: number;
      readonly byteLength: number;
    }
  | {
      readonly type: "input.text";
      readonly text: string;
      readonly conversationId: ConversationId;
    }
  | {
      readonly type: "transcript.partial";
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "transcript.final";
      readonly sequence: number;
      readonly text: string;
      readonly confidence?: number;
      readonly turnId: string;
      readonly conversationId: ConversationId;
    }
  | {
      readonly type: "assistant.text.delta";
      readonly sequence: number;
      readonly text: string;
      readonly turnId: string;
      readonly conversationId: ConversationId;
    }
  | {
      readonly type: "assistant.text.final";
      readonly sequence: number;
      readonly text: string;
      readonly turnId: string;
      readonly conversationId: ConversationId;
    }
  | {
      readonly type: "assistant.audio";
      readonly sequence: number;
      readonly chunk: AudioChunk;
      readonly turnId: string;
      readonly conversationId: ConversationId;
    }
  | {
      readonly type: "turn.started" | "turn.completed" | "turn.interrupted";
      readonly sequence: number;
      readonly turnId: string;
      readonly conversationId: ConversationId;
    }
  | {
      readonly type: "usage";
      readonly event: VoiceUsageEvent;
    }
  | {
      readonly type: "cost";
      readonly event: VoiceCostEvent;
    }
  | {
      readonly type: "session.reconnect_scheduled";
      readonly attempt: number;
      readonly delayMs: number;
      readonly remainingDeadlineMs: number;
    }
  | {
      readonly type: "session.reconnected";
      readonly attempt: number;
      readonly providerSessionId: string;
    }
  | {
      readonly type: "session.text_handoff";
      readonly handoff: TextConversationHandoff;
    }
  | {
      readonly type: "error";
      readonly error: NormalizedVoiceError;
    };

export interface ConversationTurnSnapshot {
  readonly turnId: string;
  readonly userText?: string;
  readonly assistantText?: string;
  readonly status: "streaming" | "complete" | "interrupted";
}

export interface TextConversationHandoff {
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly fundingSource: FundingSource;
  readonly modality: "text";
  readonly reason: "user_requested" | "voice_unavailable" | "deadline";
  readonly turns: readonly ConversationTurnSnapshot[];
  readonly lastEventSequence: number;
}

export interface VoiceClock {
  nowMs(): number;
}

export interface VoiceSleeper {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface VoiceIdFactory {
  next(prefix: string): string;
}

export interface RealtimeVoiceOrchestratorDependencies {
  readonly adapter: RealtimeVoiceAdapter;
  readonly usageSink: VoiceUsageSink;
  readonly costSink: VoiceCostSink;
  readonly clock?: VoiceClock;
  readonly sleeper?: VoiceSleeper;
  readonly ids?: VoiceIdFactory;
}

export interface StartVoiceSessionInput {
  readonly context: VoiceSessionContext;
  readonly options: VoiceSessionOptions;
}

export interface RealtimeVoiceSession {
  readonly context: VoiceSessionContext;
  readonly state: VoiceSessionState;
  readonly clientDescriptor: EphemeralClientSessionDescriptor;
  sendAudio(chunk: Uint8Array): Promise<void>;
  commitTurn(): Promise<void>;
  sendText(text: string): Promise<void>;
  bargeIn(): Promise<void>;
  cancelTurn(): Promise<void>;
  handoffToText(
    reason?: TextConversationHandoff["reason"],
  ): Promise<TextConversationHandoff>;
  close(reason?: string): Promise<void>;
  events(): AsyncIterable<VoiceSessionEvent>;
}

export type StartVoiceSessionOutcome =
  | { readonly ok: true; readonly session: RealtimeVoiceSession }
  | { readonly ok: false; readonly error: NormalizedVoiceError };
