import type {
  AnyDomainEvent,
  EventType,
  QuarantinedEvent,
} from "./types.js";
import { EVENT_TYPES } from "./types.js";

type EventValidationFailure = {
  readonly valid: false;
  readonly reasonCode: QuarantinedEvent["reasonCode"];
  readonly issues: readonly string[];
};
export type EventValidationResult =
  | { readonly valid: true; readonly event: AnyDomainEvent }
  | EventValidationFailure;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined || isFiniteNonNegative(value);
}

function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => jsonSafe(entry, seen));
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((entry) => jsonSafe(entry, seen));
  seen.delete(value);
  return valid;
}

function payloadRecord(
  payload: unknown,
  keys: readonly string[],
): payload is UnknownRecord {
  return isRecord(payload) && hasOnlyKeys(payload, keys);
}

function validatePayload(type: EventType, payload: unknown): boolean {
  switch (type) {
    case "widget_loaded":
    case "widget_opened":
    case "widget_closed":
    case "widget_expanded":
    case "widget_minimized":
    case "session_start":
    case "voice_permission_requested":
      return isRecord(payload) && jsonSafe(payload);
    case "widget_resized":
      return (
        payloadRecord(payload, ["width", "height"]) &&
        isFiniteNonNegative(payload.width) &&
        isFiniteNonNegative(payload.height)
      );
    case "message_sent":
      return (
        payloadRecord(payload, ["messageId", "modality", "attachmentCount"]) &&
        isNonEmptyString(payload.messageId) &&
        (payload.modality === "text" || payload.modality === "voice") &&
        Number.isInteger(payload.attachmentCount) &&
        isFiniteNonNegative(payload.attachmentCount)
      );
    case "response_streamed":
      return (
        payloadRecord(payload, ["messageId", "interrupted", "latencyMs"]) &&
        isNonEmptyString(payload.messageId) &&
        typeof payload.interrupted === "boolean" &&
        optionalNonNegative(payload.latencyMs)
      );
    case "response_rated":
      return (
        payloadRecord(payload, ["messageId", "rating", "reason"]) &&
        isNonEmptyString(payload.messageId) &&
        (payload.rating === "positive" || payload.rating === "negative") &&
        optionalString(payload.reason)
      );
    case "source_clicked":
      return (
        payloadRecord(payload, ["messageId", "sourceId"]) &&
        isNonEmptyString(payload.messageId) &&
        isNonEmptyString(payload.sourceId)
      );
    case "diagram_viewed":
    case "diagram_zoomed":
      return (
        payloadRecord(payload, ["messageId", "assetId"]) &&
        isNonEmptyString(payload.messageId) &&
        isNonEmptyString(payload.assetId)
      );
    case "conversation_resumed":
      return (
        payloadRecord(payload, ["conversationId"]) &&
        isNonEmptyString(payload.conversationId)
      );
    case "page_view":
      return (
        payloadRecord(payload, ["url", "title", "course", "module", "lesson"]) &&
        isNonEmptyString(payload.url) &&
        optionalString(payload.title) &&
        optionalString(payload.course) &&
        optionalString(payload.module) &&
        optionalString(payload.lesson)
      );
    case "session_end":
      return (
        payloadRecord(payload, ["durationMs", "reason"]) &&
        optionalNonNegative(payload.durationMs) &&
        optionalString(payload.reason)
      );
    case "module_progress":
      return (
        payloadRecord(payload, ["course", "module", "lesson", "action"]) &&
        isNonEmptyString(payload.course) &&
        optionalString(payload.module) &&
        optionalString(payload.lesson) &&
        (payload.action === "lesson_completed" ||
          payload.action === "section_completed" ||
          payload.action === "course_completed")
      );
    case "member_joined":
      return (
        payloadRecord(payload, ["externalMemberRef"]) &&
        optionalString(payload.externalMemberRef)
      );
    case "low_confidence_answer":
      return (
        payloadRecord(payload, ["messageId", "confidence"]) &&
        isNonEmptyString(payload.messageId) &&
        isUnitInterval(payload.confidence)
      );
    case "no_kb_coverage":
      return (
        payloadRecord(payload, ["messageId", "queryHash"]) &&
        isNonEmptyString(payload.messageId) &&
        isNonEmptyString(payload.queryHash)
      );
    case "voice_permission_result":
      return (
        payloadRecord(payload, ["result"]) &&
        (payload.result === "granted" ||
          payload.result === "denied" ||
          payload.result === "dismissed" ||
          payload.result === "unavailable")
      );
    case "voice_session_started":
      return (
        payloadRecord(payload, ["mode", "recording"]) &&
        (payload.mode === "push_to_talk" || payload.mode === "tap_to_start") &&
        typeof payload.recording === "boolean"
      );
    case "voice_session_ended":
      return (
        payloadRecord(payload, ["reason", "durationMs"]) &&
        isNonEmptyString(payload.reason) &&
        isFiniteNonNegative(payload.durationMs)
      );
    case "voice_interrupted":
      return (
        payloadRecord(payload, ["messageId", "stopLatencyMs"]) &&
        optionalString(payload.messageId) &&
        optionalNonNegative(payload.stopLatencyMs)
      );
    case "voice_fallback_to_text":
      return (
        payloadRecord(payload, ["reasonCode"]) &&
        isNonEmptyString(payload.reasonCode)
      );
    case "transcript_partial":
      return (
        payloadRecord(payload, ["characterCount", "latencyMs"]) &&
        Number.isInteger(payload.characterCount) &&
        isFiniteNonNegative(payload.characterCount) &&
        optionalNonNegative(payload.latencyMs)
      );
    case "transcript_final":
      return (
        payloadRecord(payload, ["characterCount", "confidence"]) &&
        Number.isInteger(payload.characterCount) &&
        isFiniteNonNegative(payload.characterCount) &&
        (payload.confidence === undefined || isUnitInterval(payload.confidence))
      );
  }
}

const ENVELOPE_KEYS = [
  "eventId",
  "schemaVersion",
  "type",
  "tenantId",
  "subjectUserId",
  "actorType",
  "conversationId",
  "sessionId",
  "occurredAt",
  "ingestedAt",
  "source",
  "identityTier",
  "consent",
  "payload",
  "idempotencyKey",
  "traceId",
] as const;

export function validateEvent(raw: unknown): EventValidationResult {
  if (!isRecord(raw)) {
    return {
      valid: false,
      reasonCode: "invalid_envelope",
      issues: ["event must be an object"],
    };
  }
  if (typeof raw.type !== "string" || !(EVENT_TYPES as readonly string[]).includes(raw.type)) {
    return {
      valid: false,
      reasonCode: "unknown_event_type",
      issues: ["type is not in the closed event taxonomy"],
    };
  }
  if (raw.schemaVersion !== 1) {
    return {
      valid: false,
      reasonCode: "unsupported_schema_version",
      issues: ["schemaVersion must equal 1"],
    };
  }

  const envelopeIssues: string[] = [];
  if (!hasOnlyKeys(raw, ENVELOPE_KEYS)) envelopeIssues.push("unknown envelope field");
  if (!isNonEmptyString(raw.eventId)) envelopeIssues.push("eventId is required");
  if (!isNonEmptyString(raw.tenantId)) envelopeIssues.push("tenantId is required");
  if (
    raw.actorType !== "student" &&
    raw.actorType !== "creator" &&
    raw.actorType !== "owner" &&
    raw.actorType !== "system"
  ) {
    envelopeIssues.push("actorType is invalid");
  }
  if (
    raw.source !== "widget" &&
    raw.source !== "edge_api" &&
    raw.source !== "dashboard" &&
    raw.source !== "worker" &&
    raw.source !== "webhook"
  ) {
    envelopeIssues.push("source is invalid");
  }
  if (
    raw.identityTier !== undefined &&
    raw.identityTier !== "verified" &&
    raw.identityTier !== "self_reported" &&
    raw.identityTier !== "anonymous"
  ) {
    envelopeIssues.push("identityTier is invalid");
  }
  for (const key of ["subjectUserId", "conversationId", "sessionId", "idempotencyKey"] as const) {
    if (raw[key] !== undefined && !isNonEmptyString(raw[key])) {
      envelopeIssues.push(`${key} must be a non-empty string`);
    }
  }
  if (!isNonEmptyString(raw.traceId)) envelopeIssues.push("traceId is required");
  if (!isIsoTimestamp(raw.occurredAt)) envelopeIssues.push("occurredAt is invalid");
  if (!isIsoTimestamp(raw.ingestedAt)) envelopeIssues.push("ingestedAt is invalid");
  if (
    !isRecord(raw.consent) ||
    !hasOnlyKeys(raw.consent, ["analytics", "voice", "recording"]) ||
    typeof raw.consent.analytics !== "boolean" ||
    (raw.consent.voice !== undefined && typeof raw.consent.voice !== "boolean") ||
    (raw.consent.recording !== undefined &&
      typeof raw.consent.recording !== "boolean")
  ) {
    envelopeIssues.push("consent snapshot is invalid");
  }
  if (envelopeIssues.length > 0) {
    return {
      valid: false,
      reasonCode: "invalid_envelope",
      issues: envelopeIssues,
    };
  }

  const type = raw.type as EventType;
  if (!validatePayload(type, raw.payload)) {
    return {
      valid: false,
      reasonCode: "invalid_payload",
      issues: [`payload is invalid for ${type}@1`],
    };
  }

  return { valid: true, event: raw as unknown as AnyDomainEvent };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function eventSemanticFingerprint(event: AnyDomainEvent): string {
  const {
    eventId: _eventId,
    ingestedAt: _ingestedAt,
    idempotencyKey: _idempotencyKey,
    traceId: _traceId,
    ...semanticFact
  } = event;
  return JSON.stringify(canonicalize(semanticFact));
}
