import type {
  AssetId,
  ConversationId,
  IsoTimestamp,
  JsonObject,
  MessageId,
  SessionId,
  TenantId,
  TraceId,
} from "./common.js";
import type { ActorType, IdentityTier } from "./context.js";

export interface EventPayloadMap {
  widget_loaded: JsonObject;
  widget_opened: JsonObject;
  widget_closed: JsonObject;
  widget_expanded: JsonObject;
  widget_resized: { readonly width: number; readonly height: number };
  widget_minimized: JsonObject;
  message_sent: {
    readonly messageId: MessageId;
    readonly modality: "text" | "voice";
    readonly attachmentCount: number;
  };
  response_streamed: {
    readonly messageId: MessageId;
    readonly interrupted: boolean;
    readonly latencyMs?: number;
  };
  response_rated: {
    readonly messageId: MessageId;
    readonly rating: "positive" | "negative";
    readonly reason?: string;
  };
  source_clicked: {
    readonly messageId: MessageId;
    readonly sourceId: string;
  };
  diagram_viewed: { readonly messageId: MessageId; readonly assetId: AssetId };
  diagram_zoomed: { readonly messageId: MessageId; readonly assetId: AssetId };
  conversation_resumed: { readonly conversationId: ConversationId };
  page_view: {
    readonly url: string;
    readonly title?: string;
    readonly course?: string;
    readonly module?: string;
    readonly lesson?: string;
  };
  session_start: JsonObject;
  session_end: { readonly durationMs?: number; readonly reason?: string };
  module_progress: {
    readonly course: string;
    readonly module?: string;
    readonly lesson?: string;
    readonly action:
      | "lesson_completed"
      | "section_completed"
      | "course_completed";
  };
  member_joined: { readonly externalMemberRef?: string };
  low_confidence_answer: {
    readonly messageId: MessageId;
    readonly confidence: number;
  };
  no_kb_coverage: {
    readonly messageId: MessageId;
    readonly queryHash: string;
  };
  voice_permission_requested: JsonObject;
  voice_permission_result: {
    readonly result: "granted" | "denied" | "dismissed" | "unavailable";
  };
  voice_session_started: {
    readonly mode: "push_to_talk" | "tap_to_start";
    readonly recording: boolean;
  };
  voice_session_ended: {
    readonly reason: string;
    readonly durationMs: number;
  };
  voice_interrupted: {
    readonly messageId?: MessageId;
    readonly stopLatencyMs?: number;
  };
  voice_fallback_to_text: { readonly reasonCode: string };
  transcript_partial: {
    readonly characterCount: number;
    readonly latencyMs?: number;
  };
  transcript_final: {
    readonly characterCount: number;
    readonly confidence?: number;
  };
}

export type EventType = keyof EventPayloadMap;
export const EVENT_TYPES = [
  "widget_loaded",
  "widget_opened",
  "widget_closed",
  "widget_expanded",
  "widget_resized",
  "widget_minimized",
  "message_sent",
  "response_streamed",
  "response_rated",
  "source_clicked",
  "diagram_viewed",
  "diagram_zoomed",
  "conversation_resumed",
  "page_view",
  "session_start",
  "session_end",
  "module_progress",
  "member_joined",
  "low_confidence_answer",
  "no_kb_coverage",
  "voice_permission_requested",
  "voice_permission_result",
  "voice_session_started",
  "voice_session_ended",
  "voice_interrupted",
  "voice_fallback_to_text",
  "transcript_partial",
  "transcript_final",
] as const satisfies readonly EventType[];

export interface ConsentSnapshot {
  readonly analytics: boolean;
  readonly voice?: boolean;
  readonly recording?: boolean;
}

export interface DomainEvent<TType extends EventType = EventType> {
  readonly eventId: string;
  readonly schemaVersion: 1;
  readonly type: TType;
  readonly tenantId: TenantId;
  readonly subjectUserId?: string;
  readonly actorType: ActorType;
  readonly conversationId?: ConversationId;
  readonly sessionId?: SessionId;
  readonly occurredAt: IsoTimestamp;
  readonly ingestedAt: IsoTimestamp;
  readonly source: "widget" | "edge_api" | "dashboard" | "worker" | "webhook";
  readonly identityTier?: IdentityTier;
  readonly consent: ConsentSnapshot;
  readonly payload: EventPayloadMap[TType];
  readonly idempotencyKey?: string;
  readonly traceId: TraceId;
}

export type AnyDomainEvent = {
  [TType in EventType]: DomainEvent<TType>;
}[EventType];

export interface EventIngestionResult {
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly quarantined: readonly {
    readonly eventId?: string;
    readonly reasonCode: string;
  }[];
}

export interface EventSink {
  append(events: readonly AnyDomainEvent[]): Promise<EventIngestionResult>;
}

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
