import type {
  AnyDomainEvent,
  IsoTimestamp,
  OpportunityAuditEntry,
  OpportunityEvidenceRecord,
  OpportunityFeedback,
  QuarantinedEvent,
  StudentOpportunity,
  TenantId,
} from "./types.js";

export type EventAppendOutcome =
  | { readonly outcome: "appended" }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "conflict"; readonly issue: string };

export interface EventRepository {
  /**
   * Production implementations MUST atomically enforce uniqueness on
   * (tenant,event_id) and non-null (tenant,idempotency_key), comparing the
   * canonical fingerprint when either key already exists.
   */
  append(event: AnyDomainEvent, canonicalFingerprint: string): Promise<EventAppendOutcome>;
  list(tenantId: TenantId): Promise<readonly AnyDomainEvent[]>;
}

export interface EventQuarantineRepository {
  append(record: QuarantinedEvent): Promise<void>;
  list(tenantId?: TenantId): Promise<readonly QuarantinedEvent[]>;
}

export interface EvidenceRepository {
  get(
    tenantId: TenantId,
    kind: OpportunityEvidenceRecord["kind"],
    refId: string,
  ): Promise<OpportunityEvidenceRecord | undefined>;
}

export interface OpportunityRepository {
  create(opportunity: StudentOpportunity): Promise<void>;
  get(tenantId: TenantId, opportunityId: string): Promise<StudentOpportunity | undefined>;
  compareAndSetStatus(
    tenantId: TenantId,
    opportunityId: string,
    expectedStatus: StudentOpportunity["status"],
    nextStatus: StudentOpportunity["status"],
    audit: OpportunityAuditEntry,
  ): Promise<StudentOpportunity | undefined>;
  /** Feedback and its audit record MUST commit atomically. */
  appendFeedback(
    feedback: OpportunityFeedback,
    audit: OpportunityAuditEntry,
  ): Promise<void>;
  listFeedback(
    tenantId: TenantId,
    opportunityId: string,
  ): Promise<readonly OpportunityFeedback[]>;
  listAudit(
    tenantId: TenantId,
    opportunityId: string,
  ): Promise<readonly OpportunityAuditEntry[]>;
}

export interface IntelligenceClock {
  now(): IsoTimestamp;
}

export interface IntelligenceIdFactory {
  next(prefix: "quarantine" | "feedback" | "audit"): string;
}
