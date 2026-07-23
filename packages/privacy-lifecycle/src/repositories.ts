import type {
  AuthorizationDecision,
  AuthorizationRequest,
  DataDisposition,
  DeletionPolicy,
  ExportManifest,
  ExportManifestItem,
  IdentityTombstone,
  IsoTimestamp,
  LegalHold,
  PersonalDataClass,
  PersonalDataRecord,
  PrivacyAuditEntry,
  PrivacyJob,
  RetentionPolicy,
  SubjectIdentity,
  TenantId,
} from "./types.js";

export interface PrivacyAuthorizer {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export interface SubjectIdentityRepository {
  get(tenantId: TenantId, subjectId: string): Promise<SubjectIdentity | undefined>;
  tombstone(tombstone: IdentityTombstone): Promise<IdentityTombstone>;
  getTombstone(
    tenantId: TenantId,
    subjectId: string,
  ): Promise<IdentityTombstone | undefined>;
}

export type DataMutationResult =
  | { readonly outcome: "applied"; readonly disposition: DataDisposition }
  | { readonly outcome: "already_applied"; readonly disposition: DataDisposition }
  | { readonly outcome: "not_found" }
  | {
      readonly outcome: "failed";
      readonly retryable: boolean;
      readonly safeMessage: string;
    };

export interface PersonalDataRepository {
  listForSubject(
    tenantId: TenantId,
    subjectId: string,
  ): Promise<readonly PersonalDataRecord[]>;
  listForRetention(
    tenantId: TenantId,
    dataClass: PersonalDataClass,
    createdBefore: IsoTimestamp,
  ): Promise<readonly PersonalDataRecord[]>;
  get(tenantId: TenantId, recordId: string): Promise<PersonalDataRecord | undefined>;
  applyDisposition(
    tenantId: TenantId,
    recordId: string,
    disposition: DataDisposition,
    jobId: string,
  ): Promise<DataMutationResult>;
}

export interface PolicyRepository {
  getDeletionPolicy(
    tenantId: TenantId,
    policyId: string,
    version: string,
  ): Promise<DeletionPolicy | undefined>;
  getRetentionPolicy(
    tenantId: TenantId,
    policyId: string,
    version: string,
  ): Promise<RetentionPolicy | undefined>;
}

export interface LegalHoldRepository {
  activeForRecord(
    tenantId: TenantId,
    record: PersonalDataRecord,
    asOf: IsoTimestamp,
  ): Promise<readonly LegalHold[]>;
}

export interface JobCreateReceipt {
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly jobId: string;
}

export type JobCreateOutcome =
  | { readonly outcome: "created"; readonly job: PrivacyJob }
  | { readonly outcome: "duplicate"; readonly job: PrivacyJob }
  | { readonly outcome: "conflict"; readonly existingJobId: string };

export interface PrivacyJobRepository {
  create(
    job: PrivacyJob,
    receipt: JobCreateReceipt,
    audit: PrivacyAuditEntry,
  ): Promise<JobCreateOutcome>;
  get(tenantId: TenantId, jobId: string): Promise<PrivacyJob | undefined>;
  commit(
    tenantId: TenantId,
    expectedVersion: number,
    job: PrivacyJob,
    audit: PrivacyAuditEntry,
  ): Promise<boolean>;
}

export interface PrivacyAuditRepository {
  append(entry: PrivacyAuditEntry): Promise<void>;
  list(tenantId: TenantId): Promise<readonly PrivacyAuditEntry[]>;
}

export interface ExportArtifactRepository {
  put(
    tenantId: TenantId,
    jobId: string,
    recordId: string,
    serializedData: string,
    sha256: string,
  ): Promise<ExportManifestItem>;
  read(tenantId: TenantId, artifactRef: string): Promise<string | undefined>;
  saveManifest(manifest: ExportManifest): Promise<void>;
  getManifest(
    tenantId: TenantId,
    manifestId: string,
  ): Promise<ExportManifest | undefined>;
}

export interface IntegrityProvider {
  sha256(value: string): string;
}

export interface PrivacyClock {
  now(): IsoTimestamp;
}

export interface PrivacyIdFactory {
  next(prefix: "privacy_job" | "privacy_audit" | "export_manifest"): string;
}
