export type IsoTimestamp = string;
export type TenantId = string;

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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type ActorType = "student" | "creator" | "owner" | "system";
export type IdentityTier = "verified" | "self_reported" | "anonymous";
export type EventSource = "widget" | "edge_api" | "dashboard" | "worker" | "webhook";

export interface EventPayloadMap {
  readonly widget_loaded: Readonly<Record<string, unknown>>;
  readonly widget_opened: Readonly<Record<string, unknown>>;
  readonly widget_closed: Readonly<Record<string, unknown>>;
  readonly widget_expanded: Readonly<Record<string, unknown>>;
  readonly widget_resized: { readonly width: number; readonly height: number };
  readonly widget_minimized: Readonly<Record<string, unknown>>;
  readonly message_sent: {
    readonly messageId: string;
    readonly modality: "text" | "voice";
    readonly attachmentCount: number;
  };
  readonly response_streamed: {
    readonly messageId: string;
    readonly interrupted: boolean;
    readonly latencyMs?: number;
  };
  readonly response_rated: {
    readonly messageId: string;
    readonly rating: "positive" | "negative";
    readonly reason?: string;
  };
  readonly source_clicked: { readonly messageId: string; readonly sourceId: string };
  readonly diagram_viewed: { readonly messageId: string; readonly assetId: string };
  readonly diagram_zoomed: { readonly messageId: string; readonly assetId: string };
  readonly conversation_resumed: { readonly conversationId: string };
  readonly page_view: {
    readonly url: string;
    readonly title?: string;
    readonly course?: string;
    readonly module?: string;
    readonly lesson?: string;
  };
  readonly session_start: Readonly<Record<string, unknown>>;
  readonly session_end: { readonly durationMs?: number; readonly reason?: string };
  readonly module_progress: {
    readonly course: string;
    readonly module?: string;
    readonly lesson?: string;
    readonly action: "lesson_completed" | "section_completed" | "course_completed";
  };
  readonly member_joined: { readonly externalMemberRef?: string };
  readonly low_confidence_answer: { readonly messageId: string; readonly confidence: number };
  readonly no_kb_coverage: { readonly messageId: string; readonly queryHash: string };
  readonly voice_permission_requested: Readonly<Record<string, unknown>>;
  readonly voice_permission_result: {
    readonly result: "granted" | "denied" | "dismissed" | "unavailable";
  };
  readonly voice_session_started: {
    readonly mode: "push_to_talk" | "tap_to_start";
    readonly recording: boolean;
  };
  readonly voice_session_ended: { readonly reason: string; readonly durationMs: number };
  readonly voice_interrupted: { readonly messageId?: string; readonly stopLatencyMs?: number };
  readonly voice_fallback_to_text: { readonly reasonCode: string };
  readonly transcript_partial: { readonly characterCount: number; readonly latencyMs?: number };
  readonly transcript_final: { readonly characterCount: number; readonly confidence?: number };
}

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
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly occurredAt: IsoTimestamp;
  readonly ingestedAt: IsoTimestamp;
  readonly source: EventSource;
  readonly identityTier?: IdentityTier;
  readonly consent: ConsentSnapshot;
  readonly payload: EventPayloadMap[TType];
  readonly idempotencyKey?: string;
  readonly traceId: string;
}

export type AnyDomainEvent = {
  [TType in EventType]: DomainEvent<TType>;
}[EventType];

export interface QuarantinedEvent {
  readonly quarantineId: string;
  readonly eventId?: string;
  readonly tenantId?: string;
  readonly reasonCode:
    | "unknown_event_type"
    | "unsupported_schema_version"
    | "invalid_envelope"
    | "invalid_payload"
    | "idempotency_conflict";
  readonly issues: readonly string[];
  readonly receivedAt: IsoTimestamp;
  readonly raw: unknown;
}

export interface EventIngestionResult {
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly quarantined: readonly QuarantinedEvent[];
}

export type DataSource =
  | "events"
  | "messages"
  | "retrieval"
  | "progress"
  | "identity";
export type SourceCoverageState = "complete" | "partial" | "missing" | "degraded";
export type OverallDataHealth = "healthy" | "partial" | "missing" | "degraded";

export interface SourceCoverage {
  readonly source: DataSource;
  readonly state: SourceCoverageState;
  readonly dataThrough?: IsoTimestamp;
  readonly observedRecords: number;
  readonly expectedRecords?: number;
  readonly reason?: string;
}

export interface IdentityCoverage {
  readonly state: "known" | "partial" | "unknown";
  readonly identifiedSubjects?: number;
  readonly observedSubjects?: number;
  readonly ratio?: number;
}

export interface DataHealthSnapshot {
  readonly tenantId: TenantId;
  readonly computedAt: IsoTimestamp;
  readonly state: OverallDataHealth;
  readonly dataThrough?: IsoTimestamp;
  readonly sources: readonly SourceCoverage[];
  readonly identityCoverage: IdentityCoverage;
  readonly limitations: readonly string[];
}

export type MetricState = "known" | "partial" | "unknown";

export type MetricResult<TValue> =
  | {
      readonly state: "known";
      readonly value: TValue;
      readonly dataThrough: IsoTimestamp;
      readonly evidenceRefs: readonly string[];
      readonly limitations: readonly [];
    }
  | {
      readonly state: "partial";
      readonly value: TValue;
      readonly dataThrough?: IsoTimestamp;
      readonly evidenceRefs: readonly string[];
      readonly limitations: readonly string[];
    }
  | {
      readonly state: "unknown";
      readonly dataThrough?: IsoTimestamp;
      readonly evidenceRefs: readonly string[];
      readonly limitations: readonly string[];
    };

export interface ConfusionMetric {
  readonly lessonId: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly questionsAttributed: number;
  readonly activeStudents: number;
  readonly questionsPerActiveStudent: number;
}

export interface QuestionObservation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly clusterId: string;
  readonly occurredAt: IsoTimestamp;
  readonly retrievalConfidence?: number;
}

export interface ContentGapMetric {
  readonly clusterId: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly questionCount: number;
  readonly confidenceObservationCount: number;
  readonly averageRetrievalConfidence?: number;
  readonly isContentGap?: boolean;
}

export interface ActivityObservation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectUserId: string;
  readonly occurredAt: IsoTimestamp;
}

export interface StallMetric {
  readonly subjectUserId: string;
  readonly activeDaysInFourteenDayWindow: number;
  readonly inactiveDays: number;
  readonly completionRatio: number;
  readonly stalled: boolean;
}

export interface LessonCompletionObservation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectUserId: string;
  readonly lessonId: string;
  readonly completedAt: IsoTimestamp;
}

export interface ModuleVelocityMetric {
  readonly subjectUserId: string;
  readonly lessonsPerWeek: number;
  readonly sameTenantCohortMedian: number;
  readonly differenceFromMedian: number;
  readonly comparison: "slower" | "same" | "faster";
}

export type EvidenceKind = "message" | "event" | "metric";

export interface OpportunityEvidenceRecord {
  readonly tenantId: TenantId;
  readonly kind: EvidenceKind;
  readonly refId: string;
  readonly fact: string;
  readonly excerpt?: string;
  readonly capturedAt: IsoTimestamp;
}

export type OpportunityKind =
  | "support_needed"
  | "offer_fit"
  | "high_intent"
  | "win"
  | "stall";
export type OpportunityLabel = "watch" | "warm" | "hot" | "unknown";
export type OpportunityStatus =
  | "new"
  | "seen"
  | "actioned"
  | "dismissed"
  | "converted"
  | "expired";

export interface StudentOpportunity {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly endUserId: string;
  readonly offerId?: string;
  readonly kind: OpportunityKind;
  readonly score?: number;
  readonly label: OpportunityLabel;
  readonly confidence: number;
  readonly computedAt: IsoTimestamp;
  readonly evidenceThrough: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly policyVersion: string;
  readonly identityTier: Exclude<IdentityTier, "anonymous">;
  readonly evidence: readonly OpportunityEvidenceRecord[];
  readonly limitations: readonly string[];
  readonly status: OpportunityStatus;
  readonly reviewMode: "human_only";
}

export interface OpportunityCandidate {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly endUserId: string;
  readonly offerId?: string;
  readonly kind: OpportunityKind;
  readonly score?: number;
  readonly label: OpportunityLabel;
  readonly confidence: number;
  readonly computedAt: IsoTimestamp;
  readonly evidenceThrough: IsoTimestamp;
  /** Supplied by an owner-approved policy. This package chooses no duration. */
  readonly expiresAt: IsoTimestamp;
  readonly policyVersion: string;
  readonly identityTier: IdentityTier;
  readonly evidenceRefs: readonly { readonly kind: EvidenceKind; readonly refId: string }[];
  readonly limitations: readonly string[];
}

export interface OpportunityEligibility {
  readonly analyticsConsent: "granted" | "revoked";
  readonly freshness: "fresh" | "stale";
  readonly coverage: "sufficient" | "insufficient";
  readonly tenantHealth: OverallDataHealth;
}

export type OpportunitySuppressionReason =
  | "anonymous_identity"
  | "analytics_consent_revoked"
  | "stale_evidence"
  | "insufficient_coverage"
  | "tenant_degraded"
  | "invalid_candidate"
  | "missing_evidence"
  | "cross_tenant_evidence";

export type OpportunityEvaluation =
  | { readonly outcome: "surfaced"; readonly opportunity: StudentOpportunity }
  | {
      readonly outcome: "suppressed";
      readonly candidateId: string;
      readonly reasons: readonly OpportunitySuppressionReason[];
    };

export interface HumanReviewActor {
  readonly actorId: string;
  readonly role: "creator" | "owner";
}

export type OpportunityFeedbackKind =
  | "dismissed_false_positive"
  | "wrong_offer"
  | "helpful";

export interface OpportunityFeedback {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly opportunityId: string;
  readonly kind: OpportunityFeedbackKind;
  readonly note?: string;
  readonly actor: HumanReviewActor;
  readonly createdAt: IsoTimestamp;
}

export interface OpportunityAuditEntry {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly opportunityId: string;
  readonly action: "status_changed" | "feedback_recorded";
  readonly actor: HumanReviewActor;
  readonly occurredAt: IsoTimestamp;
  readonly fromStatus?: OpportunityStatus;
  readonly toStatus?: OpportunityStatus;
  readonly feedbackId?: string;
  readonly reason?: string;
}
