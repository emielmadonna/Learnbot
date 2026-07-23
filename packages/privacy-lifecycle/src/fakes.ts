import { PrivacyLifecycleError } from "./errors.js";
import type {
  DataMutationResult,
  ExportArtifactRepository,
  IntegrityProvider,
  JobCreateOutcome,
  JobCreateReceipt,
  LegalHoldRepository,
  PersonalDataRepository,
  PolicyRepository,
  PrivacyAuditRepository,
  PrivacyAuthorizer,
  PrivacyClock,
  PrivacyIdFactory,
  PrivacyJobRepository,
  SubjectIdentityRepository,
} from "./repositories.js";
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

export interface ExplicitPrivacyGrant {
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly role: AuthorizationRequest["role"];
  readonly purpose: AuthorizationRequest["purpose"];
  readonly operation: AuthorizationRequest["operation"];
  /** Omit only for tenant-level operations; "*" is an explicit tenant-wide grant. */
  readonly subjectId?: string;
  readonly confirmationGrantId?: string;
  readonly policyVersion: string;
}

export class ExplicitGrantPrivacyAuthorizer implements PrivacyAuthorizer {
  readonly requests: AuthorizationRequest[] = [];

  constructor(private readonly grants: readonly ExplicitPrivacyGrant[]) {}

  async authorize(
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    this.requests.push(clone(request));
    const grant = this.grants.find(
      (candidate) =>
        candidate.tenantId === request.tenantId &&
        candidate.actorId === request.actorId &&
        candidate.role === request.role &&
        candidate.purpose === request.purpose &&
        candidate.operation === request.operation &&
        (request.subjectId === undefined
          ? candidate.subjectId === undefined
          : candidate.subjectId === request.subjectId ||
            candidate.subjectId === "*") &&
        (request.confirmationGrantId === undefined
          ? candidate.confirmationGrantId === undefined
          : candidate.confirmationGrantId === request.confirmationGrantId),
    );
    return grant === undefined
      ? {
          allowed: false,
          policyVersion: "deny-by-default-v1",
          reasonCode: "no_exact_grant",
        }
      : {
          allowed: true,
          policyVersion: grant.policyVersion,
          reasonCode: "exact_grant",
        };
  }
}

export class InMemorySubjectIdentityRepository
  implements SubjectIdentityRepository
{
  readonly #identities = new Map<string, SubjectIdentity>();
  readonly #tombstones = new Map<string, IdentityTombstone>();

  constructor(identities: readonly SubjectIdentity[] = []) {
    for (const identity of identities) {
      this.#identities.set(key(identity.tenantId, identity.subjectId), clone(identity));
    }
  }

  async get(
    tenantId: TenantId,
    subjectId: string,
  ): Promise<SubjectIdentity | undefined> {
    const identity = this.#identities.get(key(tenantId, subjectId));
    return identity === undefined ? undefined : clone(identity);
  }

  async tombstone(tombstone: IdentityTombstone): Promise<IdentityTombstone> {
    const identityKey = key(tombstone.tenantId, tombstone.subjectId);
    const existing = this.#tombstones.get(identityKey);
    if (existing !== undefined) return clone(existing);
    const identity = this.#identities.get(identityKey);
    if (
      identity === undefined ||
      identity.tenantId !== tombstone.tenantId ||
      identity.subjectId !== tombstone.subjectId
    ) {
      throw new PrivacyLifecycleError(
        "privacy.invalid_input",
        "Cannot tombstone an identity outside the exact tenant subject.",
      );
    }
    this.#identities.set(identityKey, { ...identity, status: "tombstoned" });
    this.#tombstones.set(identityKey, clone(tombstone));
    return clone(tombstone);
  }

  async getTombstone(
    tenantId: TenantId,
    subjectId: string,
  ): Promise<IdentityTombstone | undefined> {
    const tombstone = this.#tombstones.get(key(tenantId, subjectId));
    return tombstone === undefined ? undefined : clone(tombstone);
  }
}

export class InMemoryPersonalDataRepository
  implements PersonalDataRepository
{
  readonly #records = new Map<string, PersonalDataRecord>();
  readonly #receipts = new Map<string, DataDisposition>();
  readonly #failures = new Map<string, Array<Extract<DataMutationResult, { outcome: "failed" }>>>();

  constructor(records: readonly PersonalDataRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: PersonalDataRecord): void {
    this.#records.set(key(record.tenantId, record.id), clone(record));
  }

  removeForTest(tenantId: TenantId, recordId: string): void {
    this.#records.delete(key(tenantId, recordId));
  }

  failNext(
    tenantId: TenantId,
    recordId: string,
    failure: Extract<DataMutationResult, { outcome: "failed" }>,
  ): void {
    const failureKey = key(tenantId, recordId);
    this.#failures.set(failureKey, [
      ...(this.#failures.get(failureKey) ?? []),
      clone(failure),
    ]);
  }

  async listForSubject(
    tenantId: TenantId,
    subjectId: string,
  ): Promise<readonly PersonalDataRecord[]> {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.tenantId === tenantId && record.subjectId === subjectId,
      )
      .map(clone);
  }

  async listForRetention(
    tenantId: TenantId,
    dataClass: PersonalDataClass,
    createdBefore: IsoTimestamp,
  ): Promise<readonly PersonalDataRecord[]> {
    const cutoff = Date.parse(createdBefore);
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.tenantId === tenantId &&
          record.dataClass === dataClass &&
          Date.parse(record.createdAt) <= cutoff,
      )
      .map(clone);
  }

  async get(
    tenantId: TenantId,
    recordId: string,
  ): Promise<PersonalDataRecord | undefined> {
    const record = this.#records.get(key(tenantId, recordId));
    return record === undefined ? undefined : clone(record);
  }

  async applyDisposition(
    tenantId: TenantId,
    recordId: string,
    disposition: DataDisposition,
    jobId: string,
  ): Promise<DataMutationResult> {
    const receiptKey = key(tenantId, jobId, recordId);
    const existing = this.#receipts.get(receiptKey);
    if (existing !== undefined) {
      if (existing !== disposition) {
        return {
          outcome: "failed",
          retryable: false,
          safeMessage: "A different disposition was already applied by this job.",
        };
      }
      return { outcome: "already_applied", disposition };
    }
    const failureKey = key(tenantId, recordId);
    const failures = this.#failures.get(failureKey);
    const failure = failures?.shift();
    if (failure !== undefined) return clone(failure);
    const recordKey = key(tenantId, recordId);
    const record = this.#records.get(recordKey);
    if (record === undefined) return { outcome: "not_found" };
    if (record.tenantId !== tenantId) return { outcome: "not_found" };

    if (disposition === "delete") {
      this.#records.delete(recordKey);
    } else {
      this.#records.set(recordKey, {
        id: record.id,
        tenantId: record.tenantId,
        dataClass: record.dataClass,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        payload:
          disposition === "deidentify"
            ? { deidentified: true }
            : { retainedMinimal: true },
      });
    }
    this.#receipts.set(receiptKey, disposition);
    return { outcome: "applied", disposition };
  }
}

export class InMemoryPolicyRepository implements PolicyRepository {
  readonly #deletion = new Map<string, DeletionPolicy>();
  readonly #retention = new Map<string, RetentionPolicy>();

  constructor(input: {
    readonly deletion?: readonly DeletionPolicy[];
    readonly retention?: readonly RetentionPolicy[];
  } = {}) {
    for (const policy of input.deletion ?? []) {
      this.#deletion.set(
        key(policy.tenantId, policy.policyId, policy.version),
        clone(policy),
      );
    }
    for (const policy of input.retention ?? []) {
      this.#retention.set(
        key(policy.tenantId, policy.policyId, policy.version),
        clone(policy),
      );
    }
  }

  async getDeletionPolicy(
    tenantId: TenantId,
    policyId: string,
    version: string,
  ): Promise<DeletionPolicy | undefined> {
    const policy = this.#deletion.get(key(tenantId, policyId, version));
    return policy === undefined ? undefined : clone(policy);
  }

  async getRetentionPolicy(
    tenantId: TenantId,
    policyId: string,
    version: string,
  ): Promise<RetentionPolicy | undefined> {
    const policy = this.#retention.get(key(tenantId, policyId, version));
    return policy === undefined ? undefined : clone(policy);
  }
}

export class InMemoryLegalHoldRepository implements LegalHoldRepository {
  constructor(readonly holds: LegalHold[] = []) {}

  release(holdId: string, releasedAt: IsoTimestamp): void {
    const index = this.holds.findIndex((hold) => hold.holdId === holdId);
    const hold = this.holds[index];
    if (hold !== undefined) {
      this.holds[index] = {
        ...hold,
        status: "released",
        releasedAt,
      };
    }
  }

  async activeForRecord(
    tenantId: TenantId,
    record: PersonalDataRecord,
    asOf: IsoTimestamp,
  ): Promise<readonly LegalHold[]> {
    const at = Date.parse(asOf);
    return this.holds
      .filter(
        (hold) =>
          hold.tenantId === tenantId &&
          hold.status === "active" &&
          Date.parse(hold.startsAt) <= at &&
          (hold.releasedAt === undefined || Date.parse(hold.releasedAt) > at) &&
          (hold.subjectId === undefined || hold.subjectId === record.subjectId) &&
          (hold.dataClasses === undefined ||
            hold.dataClasses.includes(record.dataClass)) &&
          (hold.recordIds === undefined || hold.recordIds.includes(record.id)),
      )
      .map(clone);
  }
}

export class InMemoryPrivacyStore
  implements PrivacyJobRepository, PrivacyAuditRepository
{
  readonly #jobs = new Map<string, PrivacyJob>();
  readonly #receipts = new Map<string, JobCreateReceipt>();
  readonly #audit: PrivacyAuditEntry[] = [];

  async create(
    job: PrivacyJob,
    receipt: JobCreateReceipt,
    audit: PrivacyAuditEntry,
  ): Promise<JobCreateOutcome> {
    const receiptKey = key(receipt.tenantId, receipt.idempotencyKey);
    const existingReceipt = this.#receipts.get(receiptKey);
    if (existingReceipt !== undefined) {
      const existingJob = this.#jobs.get(
        key(existingReceipt.tenantId, existingReceipt.jobId),
      )!;
      return existingReceipt.fingerprint === receipt.fingerprint
        ? { outcome: "duplicate", job: clone(existingJob) }
        : { outcome: "conflict", existingJobId: existingReceipt.jobId };
    }
    if (
      job.tenantId !== receipt.tenantId ||
      job.jobId !== receipt.jobId ||
      audit.tenantId !== job.tenantId ||
      audit.jobId !== job.jobId
    ) {
      throw new PrivacyLifecycleError(
        "privacy.cross_tenant",
        "Job, receipt, and creation audit must share one tenant and job.",
      );
    }
    this.#jobs.set(key(job.tenantId, job.jobId), clone(job));
    this.#receipts.set(receiptKey, clone(receipt));
    this.#audit.push(clone(audit));
    return { outcome: "created", job: clone(job) };
  }

  async get(
    tenantId: TenantId,
    jobId: string,
  ): Promise<PrivacyJob | undefined> {
    const job = this.#jobs.get(key(tenantId, jobId));
    return job === undefined ? undefined : clone(job);
  }

  async commit(
    tenantId: TenantId,
    expectedVersion: number,
    job: PrivacyJob,
    audit: PrivacyAuditEntry,
  ): Promise<boolean> {
    const jobKey = key(tenantId, job.jobId);
    const current = this.#jobs.get(jobKey);
    if (current === undefined || current.version !== expectedVersion) return false;
    if (
      job.tenantId !== tenantId ||
      job.version !== expectedVersion + 1 ||
      audit.tenantId !== tenantId ||
      audit.jobId !== job.jobId
    ) {
      throw new PrivacyLifecycleError(
        "privacy.cross_tenant",
        "Job update and audit must share one tenant and version transition.",
      );
    }
    this.#jobs.set(jobKey, clone(job));
    this.#audit.push(clone(audit));
    return true;
  }

  async append(entry: PrivacyAuditEntry): Promise<void> {
    this.#audit.push(clone(entry));
  }

  async list(tenantId: TenantId): Promise<readonly PrivacyAuditEntry[]> {
    return this.#audit
      .filter((entry) => entry.tenantId === tenantId)
      .map(clone);
  }
}

export class InMemoryExportArtifactRepository
  implements ExportArtifactRepository
{
  readonly #artifacts = new Map<string, string>();
  readonly #manifests = new Map<string, ExportManifest>();

  async put(
    tenantId: TenantId,
    jobId: string,
    recordId: string,
    serializedData: string,
    sha256: string,
  ): Promise<ExportManifestItem> {
    const artifactRef = `exports/${jobId}/${recordId}.json`;
    const artifactKey = key(tenantId, artifactRef);
    const existing = this.#artifacts.get(artifactKey);
    if (existing !== undefined && existing !== serializedData) {
      throw new Error("artifact conflict");
    }
    this.#artifacts.set(artifactKey, serializedData);
    const parsed = JSON.parse(serializedData) as { dataClass: PersonalDataClass };
    return {
      recordId,
      dataClass: parsed.dataClass,
      artifactRef,
      byteLength: new TextEncoder().encode(serializedData).byteLength,
      sha256,
    };
  }

  async read(
    tenantId: TenantId,
    artifactRef: string,
  ): Promise<string | undefined> {
    return this.#artifacts.get(key(tenantId, artifactRef));
  }

  async saveManifest(manifest: ExportManifest): Promise<void> {
    const manifestKey = key(manifest.tenantId, manifest.manifestId);
    const existing = this.#manifests.get(manifestKey);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(manifest)
    ) {
      throw new Error("manifest conflict");
    }
    this.#manifests.set(manifestKey, clone(manifest));
  }

  async getManifest(
    tenantId: TenantId,
    manifestId: string,
  ): Promise<ExportManifest | undefined> {
    const manifest = this.#manifests.get(key(tenantId, manifestId));
    return manifest === undefined ? undefined : clone(manifest);
  }

  tamperArtifact(tenantId: TenantId, artifactRef: string, value: string): void {
    this.#artifacts.set(key(tenantId, artifactRef), value);
  }

  tamperManifest(
    tenantId: TenantId,
    manifestId: string,
    mutate: (manifest: ExportManifest) => ExportManifest,
  ): void {
    const manifestKey = key(tenantId, manifestId);
    const manifest = this.#manifests.get(manifestKey);
    if (manifest !== undefined) this.#manifests.set(manifestKey, mutate(clone(manifest)));
  }
}

export class DeterministicPrivacyRuntime
  implements PrivacyClock, PrivacyIdFactory
{
  #sequence = 0;

  constructor(public currentTime: IsoTimestamp) {}

  now(): IsoTimestamp {
    return this.currentTime;
  }

  next(
    prefix: "privacy_job" | "privacy_audit" | "export_manifest",
  ): string {
    this.#sequence += 1;
    return `${prefix}_${this.#sequence}`;
  }
}

export class DeterministicIntegrityProvider implements IntegrityProvider {
  constructor(private readonly delegate: IntegrityProvider) {}

  sha256(value: string): string {
    return this.delegate.sha256(value);
  }
}
