export type TenantId = string;
export type IsoTimestamp = string;
export type IdentityTier = "verified" | "self_reported" | "anonymous";
export type PrivacyRole =
  | "owner"
  | "client_admin"
  | "client_viewer"
  | "student"
  | "system-worker";
export type PrivacyPurpose =
  | "subject_access_request"
  | "tenant_privacy_administration"
  | "legal_compliance"
  | "retention_enforcement";
export type PrivacyOperation =
  | "privacy.access.create"
  | "privacy.export.create"
  | "privacy.delete.create"
  | "privacy.retention.create"
  | "privacy.job.execute"
  | "privacy.job.read"
  | "privacy.export.verify";

export interface PrivacyActorContext {
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly role: PrivacyRole;
  readonly purpose: PrivacyPurpose;
  readonly requestId: string;
  readonly traceId: string;
}

export interface SubjectIdentity {
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly tier: IdentityTier;
  readonly status: "active" | "tombstoned";
  readonly createdAt: IsoTimestamp;
}

export const PERSONAL_DATA_CLASSES = [
  "profile",
  "events",
  "messages",
  "derived_insights",
  "evidence",
  "vectors",
  "assets",
  "attachments",
  "transcripts",
  "voice_recordings",
  "audit_legal",
] as const;
export type PersonalDataClass = (typeof PERSONAL_DATA_CLASSES)[number];

export interface PersonalDataRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId?: string;
  readonly dataClass: PersonalDataClass;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly payload: unknown;
}

export type DataDisposition = "delete" | "deidentify" | "retain_minimal";

export interface DeletionPolicy {
  readonly policyId: string;
  readonly tenantId: TenantId;
  readonly version: string;
  readonly approvedBy: string;
  readonly approvedAt: IsoTimestamp;
  readonly legalHoldMode: "suppress";
  /** No defaults: every class present in a deletion snapshot needs a rule. */
  readonly dispositions: Readonly<
    Partial<Record<PersonalDataClass, DataDisposition>>
  >;
}

export interface RetentionRule {
  readonly dataClass: PersonalDataClass;
  /** Explicit O-13 input. The package supplies no duration default. */
  readonly retentionDays: number;
  readonly disposition: DataDisposition;
}

export interface RetentionPolicy {
  readonly policyId: string;
  readonly tenantId: TenantId;
  readonly version: string;
  readonly approvedBy: string;
  readonly approvedAt: IsoTimestamp;
  readonly effectiveAt: IsoTimestamp;
  readonly legalHoldMode: "suppress";
  readonly region?: string;
  readonly rules: readonly RetentionRule[];
}

export interface PolicyRef {
  readonly policyId: string;
  readonly version: string;
}

export interface LegalHold {
  readonly holdId: string;
  readonly tenantId: TenantId;
  readonly status: "active" | "released";
  readonly reason: string;
  readonly startsAt: IsoTimestamp;
  readonly releasedAt?: IsoTimestamp;
  readonly subjectId?: string;
  readonly dataClasses?: readonly PersonalDataClass[];
  readonly recordIds?: readonly string[];
}

export interface IdentityTombstone {
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly identityTier: IdentityTier;
  readonly subjectDigest: string;
  readonly deletedAt: IsoTimestamp;
  readonly jobId: string;
  readonly policyVersion: string;
  readonly retainedLegalHoldIds: readonly string[];
}

export type PrivacyJobKind = "access" | "export" | "delete" | "retention";
export type PrivacyJobStatus =
  | "queued"
  | "running"
  | "partial"
  | "blocked"
  | "completed"
  | "failed";
export type PrivacyJobStage = "planning" | "processing" | "finalizing" | "done";

export type PrivacyBlockReason =
  | "subject_not_found"
  | "anonymous_identity"
  | "identity_tombstoned"
  | "policy_not_found"
  | "policy_invalid"
  | "policy_missing_data_class_rule"
  | "legal_hold"
  | "record_unavailable"
  | "adapter_failure";

export interface PrivacyItemFailure {
  readonly recordId: string;
  readonly code: "record_unavailable" | "adapter_failure";
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly attempt: number;
}

export interface ExportManifestItem {
  readonly recordId: string;
  readonly dataClass: PersonalDataClass;
  readonly artifactRef: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ExportManifest {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly identityTier: Exclude<IdentityTier, "anonymous">;
  readonly createdAt: IsoTimestamp;
  readonly dataThrough: IsoTimestamp;
  readonly items: readonly ExportManifestItem[];
  readonly itemCount: number;
  readonly totalBytes: number;
  readonly rootSha256: string;
}

export interface AccessResult {
  readonly kind: "access";
  readonly recordCount: number;
  readonly dataThrough: IsoTimestamp;
  readonly countsByClass: Readonly<Partial<Record<PersonalDataClass, number>>>;
}

export interface ExportResult {
  readonly kind: "export";
  readonly manifestId: string;
  readonly itemCount: number;
  readonly totalBytes: number;
  readonly rootSha256: string;
}

export interface DeletionResult {
  readonly kind: "delete";
  readonly tombstone: IdentityTombstone;
  readonly deleted: number;
  readonly deidentified: number;
  readonly retainedMinimal: number;
}

export interface RetentionResult {
  readonly kind: "retention";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly dataThrough: IsoTimestamp;
  readonly deleted: number;
  readonly deidentified: number;
  readonly retainedMinimal: number;
}

export type PrivacyJobResult =
  | AccessResult
  | ExportResult
  | DeletionResult
  | RetentionResult;

export interface PrivacyJob {
  readonly jobId: string;
  readonly tenantId: TenantId;
  readonly kind: PrivacyJobKind;
  readonly status: PrivacyJobStatus;
  readonly stage: PrivacyJobStage;
  readonly version: number;
  readonly subjectId?: string;
  readonly identityTier?: IdentityTier;
  readonly requestedBy: {
    readonly actorId: string;
    readonly role: PrivacyRole;
    readonly purpose: PrivacyPurpose;
  };
  readonly requestedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly dataThrough: IsoTimestamp;
  readonly idempotencyKey: string;
  readonly policyRef?: PolicyRef;
  readonly confirmationGrantId?: string;
  readonly targetRecordIds: readonly string[];
  readonly dispositions: Readonly<Record<string, DataDisposition>>;
  readonly completedRecordIds: readonly string[];
  readonly heldRecordIds: readonly string[];
  readonly heldBy: Readonly<Record<string, readonly string[]>>;
  readonly attempts: Readonly<Record<string, number>>;
  readonly failures: readonly PrivacyItemFailure[];
  readonly accessCounts: Readonly<Partial<Record<PersonalDataClass, number>>>;
  readonly exportItems: readonly ExportManifestItem[];
  readonly dispositionCounts: {
    readonly deleted: number;
    readonly deidentified: number;
    readonly retainedMinimal: number;
  };
  readonly blockedReasons: readonly PrivacyBlockReason[];
  readonly retryable: boolean;
  readonly result?: PrivacyJobResult;
}

export interface CreateAccessCommand {
  readonly kind: "access";
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly idempotencyKey: string;
}

export interface CreateExportCommand {
  readonly kind: "export";
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly idempotencyKey: string;
}

export interface CreateDeleteCommand {
  readonly kind: "delete";
  readonly tenantId: TenantId;
  readonly subjectId: string;
  readonly idempotencyKey: string;
  readonly policyRef: PolicyRef;
  readonly confirmationGrantId: string;
}

export interface CreateRetentionCommand {
  readonly kind: "retention";
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly policyRef: PolicyRef;
  readonly dataThrough: IsoTimestamp;
}

export type CreatePrivacyJobCommand =
  | CreateAccessCommand
  | CreateExportCommand
  | CreateDeleteCommand
  | CreateRetentionCommand;

export interface AuthorizationRequest {
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly role: PrivacyRole;
  readonly purpose: PrivacyPurpose;
  readonly operation: PrivacyOperation;
  readonly subjectId?: string;
  readonly confirmationGrantId?: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly policyVersion: string;
  readonly reasonCode: string;
}

export type PrivacyAuditAction =
  | "authorization_denied"
  | "job_created"
  | "job_replayed"
  | "idempotency_conflict"
  | "job_resumed"
  | "job_partial"
  | "job_blocked"
  | "job_completed"
  | "manifest_verified"
  | "manifest_invalid";

export interface PrivacyAuditEntry {
  readonly auditId: string;
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly role: PrivacyRole;
  readonly purpose: PrivacyPurpose;
  readonly action: PrivacyAuditAction;
  readonly operation: PrivacyOperation;
  readonly targetType: "subject" | "tenant" | "job" | "manifest";
  readonly targetRef: string;
  readonly occurredAt: IsoTimestamp;
  readonly requestId: string;
  readonly traceId: string;
  readonly authorizationPolicyVersion?: string;
  readonly resultCode: string;
  readonly jobId?: string;
}

export interface ManifestVerification {
  readonly valid: boolean;
  readonly manifestId: string;
  readonly checkedItems: number;
  readonly issues: readonly string[];
}
