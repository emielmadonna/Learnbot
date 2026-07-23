import { PrivacyLifecycleError, requirePrivacy } from "./errors.js";
import {
  canonicalJson,
  exportManifestRootInput,
  manifestRootInput,
} from "./integrity.js";
import {
  validateDeletionPolicy,
  validateRetentionPolicy,
} from "./policies.js";
import type {
  ExportArtifactRepository,
  IntegrityProvider,
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
  CreatePrivacyJobCommand,
  DataDisposition,
  DeletionPolicy,
  ExportManifest,
  ExportManifestItem,
  ManifestVerification,
  PersonalDataClass,
  PersonalDataRecord,
  PrivacyActorContext,
  PrivacyAuditAction,
  PrivacyAuditEntry,
  PrivacyBlockReason,
  PrivacyItemFailure,
  PrivacyJob,
  PrivacyOperation,
  RetentionPolicy,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function operationFor(
  kind: CreatePrivacyJobCommand["kind"],
): PrivacyOperation {
  switch (kind) {
    case "access":
      return "privacy.access.create";
    case "export":
      return "privacy.export.create";
    case "delete":
      return "privacy.delete.create";
    case "retention":
      return "privacy.retention.create";
  }
}

function fingerprint(
  context: PrivacyActorContext,
  command: CreatePrivacyJobCommand,
): string {
  const { idempotencyKey: _idempotencyKey, ...semanticCommand } = command;
  return canonicalJson({
    actorId: context.actorId,
    role: context.role,
    purpose: context.purpose,
    command: semanticCommand,
  });
}

function dispositionCounterKey(
  disposition: DataDisposition,
): "deleted" | "deidentified" | "retainedMinimal" {
  return disposition === "delete"
    ? "deleted"
    : disposition === "deidentify"
      ? "deidentified"
      : "retainedMinimal";
}

function auditTarget(command: CreatePrivacyJobCommand): {
  readonly targetType: "subject" | "tenant";
  readonly targetRef: string;
} {
  return command.kind === "retention"
    ? { targetType: "tenant", targetRef: command.tenantId }
    : { targetType: "subject", targetRef: command.subjectId };
}

interface PrivacyLifecycleDependencies {
  readonly authorizer: PrivacyAuthorizer;
  readonly identities: SubjectIdentityRepository;
  readonly data: PersonalDataRepository;
  readonly policies: PolicyRepository;
  readonly legalHolds: LegalHoldRepository;
  readonly jobs: PrivacyJobRepository;
  readonly audit: PrivacyAuditRepository;
  readonly artifacts: ExportArtifactRepository;
  readonly integrity: IntegrityProvider;
  readonly clock: PrivacyClock;
  readonly ids: PrivacyIdFactory;
}

export class PrivacyLifecycleService {
  constructor(private readonly dependencies: PrivacyLifecycleDependencies) {}

  async createJob(
    context: PrivacyActorContext,
    command: CreatePrivacyJobCommand,
  ): Promise<PrivacyJob> {
    const operation = operationFor(command.kind);
    await this.#validateContextAndTarget(
      context,
      command.tenantId,
      operation,
    );
    requirePrivacy(
      nonEmpty(command.idempotencyKey),
      "privacy.invalid_input",
      "An idempotency key is required.",
    );
    if (command.kind === "delete") {
      requirePrivacy(
        nonEmpty(command.confirmationGrantId),
        "privacy.invalid_input",
        "A target-bound confirmation grant is required for deletion.",
      );
    }
    if (command.kind === "retention") {
      requirePrivacy(
        validTimestamp(command.dataThrough) &&
          Date.parse(command.dataThrough) <= Date.parse(this.dependencies.clock.now()),
        "privacy.invalid_input",
        "Retention data-through must be a valid non-future timestamp.",
      );
    }

    const authorization = await this.#authorize(
      context,
      operation,
      command.kind === "retention" ? undefined : command.subjectId,
      command.kind === "delete" ? command.confirmationGrantId : undefined,
    );
    const now = this.dependencies.clock.now();
    const jobId = this.dependencies.ids.next("privacy_job");
    const blockedReasons: PrivacyBlockReason[] = [];
    let identity:
      | Awaited<ReturnType<SubjectIdentityRepository["get"]>>
      | undefined;
    let records: readonly PersonalDataRecord[] = [];
    let policyRef:
      | { readonly policyId: string; readonly version: string }
      | undefined;
    let deletionPolicy: DeletionPolicy | undefined;
    let retentionPolicy: RetentionPolicy | undefined;
    const dispositions: Record<string, DataDisposition> = {};
    const dataThrough =
      command.kind === "retention" ? command.dataThrough : now;

    if (command.kind !== "retention") {
      identity = await this.dependencies.identities.get(
        command.tenantId,
        command.subjectId,
      );
      if (identity === undefined) {
        blockedReasons.push("subject_not_found");
      } else if (identity.status === "tombstoned") {
        blockedReasons.push("identity_tombstoned");
      } else if (identity.tier === "anonymous") {
        blockedReasons.push("anonymous_identity");
      } else {
        records = await this.dependencies.data.listForSubject(
          command.tenantId,
          command.subjectId,
        );
      }
    }

    if (command.kind === "delete") {
      policyRef = command.policyRef;
      deletionPolicy = await this.dependencies.policies.getDeletionPolicy(
        command.tenantId,
        command.policyRef.policyId,
        command.policyRef.version,
      );
      if (deletionPolicy === undefined) {
        blockedReasons.push("policy_not_found");
      } else if (
        validateDeletionPolicy(deletionPolicy, command.tenantId).length > 0
      ) {
        blockedReasons.push("policy_invalid");
      } else {
        for (const record of records) {
          const disposition = deletionPolicy.dispositions[record.dataClass];
          if (disposition === undefined) {
            blockedReasons.push("policy_missing_data_class_rule");
          } else {
            dispositions[record.id] = disposition;
          }
        }
      }
    } else if (command.kind === "retention") {
      policyRef = command.policyRef;
      retentionPolicy = await this.dependencies.policies.getRetentionPolicy(
        command.tenantId,
        command.policyRef.policyId,
        command.policyRef.version,
      );
      if (retentionPolicy === undefined) {
        blockedReasons.push("policy_not_found");
      } else if (
        validateRetentionPolicy(
          retentionPolicy,
          command.tenantId,
          command.dataThrough,
        ).length > 0
      ) {
        blockedReasons.push("policy_invalid");
      } else {
        const planned = new Map<string, PersonalDataRecord>();
        for (const rule of retentionPolicy.rules) {
          const cutoff = new Date(
            Date.parse(command.dataThrough) - rule.retentionDays * DAY_MS,
          ).toISOString();
          const ruleRecords = await this.dependencies.data.listForRetention(
            command.tenantId,
            rule.dataClass,
            cutoff,
          );
          for (const record of ruleRecords) {
            planned.set(record.id, record);
            dispositions[record.id] = rule.disposition;
          }
        }
        records = [...planned.values()];
      }
    }

    const uniqueBlockedReasons = [...new Set(blockedReasons)];
    const target = auditTarget(command);
    const job: PrivacyJob = {
      jobId,
      tenantId: command.tenantId,
      kind: command.kind,
      status: uniqueBlockedReasons.length === 0 ? "queued" : "blocked",
      stage: uniqueBlockedReasons.length === 0 ? "processing" : "planning",
      version: 1,
      ...(command.kind === "retention" ? {} : { subjectId: command.subjectId }),
      ...(identity === undefined ? {} : { identityTier: identity.tier }),
      requestedBy: {
        actorId: context.actorId,
        role: context.role,
        purpose: context.purpose,
      },
      requestedAt: now,
      updatedAt: now,
      dataThrough,
      idempotencyKey: command.idempotencyKey,
      ...(policyRef === undefined ? {} : { policyRef }),
      ...(command.kind === "delete"
        ? { confirmationGrantId: command.confirmationGrantId }
        : {}),
      targetRecordIds: records.map((record) => record.id).sort(),
      dispositions,
      completedRecordIds: [],
      heldRecordIds: [],
      heldBy: {},
      attempts: {},
      failures: [],
      accessCounts: {},
      exportItems: [],
      dispositionCounts: {
        deleted: 0,
        deidentified: 0,
        retainedMinimal: 0,
      },
      blockedReasons: uniqueBlockedReasons,
      retryable: false,
    };
    const creationAudit = this.#auditEntry(
      context,
      operation,
      uniqueBlockedReasons.length === 0 ? "job_created" : "job_blocked",
      target.targetType,
      target.targetRef,
      uniqueBlockedReasons.length === 0
        ? "created"
        : uniqueBlockedReasons.join(","),
      authorization,
      jobId,
    );
    const outcome = await this.dependencies.jobs.create(
      job,
      {
        tenantId: command.tenantId,
        idempotencyKey: command.idempotencyKey,
        fingerprint: fingerprint(context, command),
        jobId,
      },
      creationAudit,
    );
    if (outcome.outcome === "duplicate") {
      await this.dependencies.audit.append(
        this.#auditEntry(
          context,
          operation,
          "job_replayed",
          "job",
          outcome.job.jobId,
          "idempotent_replay",
          authorization,
          outcome.job.jobId,
        ),
      );
      return outcome.job;
    }
    if (outcome.outcome === "conflict") {
      await this.dependencies.audit.append(
        this.#auditEntry(
          context,
          operation,
          "idempotency_conflict",
          "job",
          outcome.existingJobId,
          "idempotency_key_reused",
          authorization,
          outcome.existingJobId,
        ),
      );
      throw new PrivacyLifecycleError(
        "privacy.idempotency_conflict",
        "The idempotency key was already used for a different privacy request.",
      );
    }
    return outcome.job;
  }

  async getJob(
    context: PrivacyActorContext,
    tenantId: string,
    jobId: string,
  ): Promise<PrivacyJob> {
    await this.#validateContextAndTarget(
      context,
      tenantId,
      "privacy.job.read",
    );
    await this.#authorize(context, "privacy.job.read");
    const job = await this.dependencies.jobs.get(tenantId, jobId);
    requirePrivacy(
      job !== undefined,
      "privacy.job_not_found",
      "Privacy job was not found in this tenant.",
    );
    return job;
  }

  async resumeJob(
    context: PrivacyActorContext,
    tenantId: string,
    jobId: string,
    maxItems: number,
  ): Promise<PrivacyJob> {
    await this.#validateContextAndTarget(
      context,
      tenantId,
      "privacy.job.execute",
    );
    requirePrivacy(
      Number.isInteger(maxItems) && maxItems > 0,
      "privacy.invalid_input",
      "maxItems must be a positive integer.",
    );
    const authorization = await this.#authorize(
      context,
      "privacy.job.execute",
    );
    const current = await this.dependencies.jobs.get(tenantId, jobId);
    requirePrivacy(
      current !== undefined,
      "privacy.job_not_found",
      "Privacy job was not found in this tenant.",
    );
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      (current.status === "blocked" && !current.retryable)
    ) {
      return current;
    }

    const next = await this.#processBatch(current, maxItems);
    const action: PrivacyAuditAction =
      next.status === "completed"
        ? "job_completed"
        : next.status === "blocked"
          ? "job_blocked"
          : next.status === "partial"
            ? "job_partial"
            : "job_resumed";
    const audit = this.#auditEntry(
      context,
      "privacy.job.execute",
      action,
      "job",
      jobId,
      next.status,
      authorization,
      jobId,
    );
    const committed = await this.dependencies.jobs.commit(
      tenantId,
      current.version,
      next,
      audit,
    );
    requirePrivacy(
      committed,
      "privacy.version_conflict",
      "Privacy job changed while it was being resumed.",
    );
    return next;
  }

  async verifyExport(
    context: PrivacyActorContext,
    tenantId: string,
    manifestId: string,
  ): Promise<ManifestVerification> {
    await this.#validateContextAndTarget(
      context,
      tenantId,
      "privacy.export.verify",
    );
    const authorization = await this.#authorize(
      context,
      "privacy.export.verify",
    );
    const manifest = await this.dependencies.artifacts.getManifest(
      tenantId,
      manifestId,
    );
    requirePrivacy(
      manifest !== undefined,
      "privacy.manifest_not_found",
      "Export manifest was not found in this tenant.",
    );
    const issues: string[] = [];
    const root = this.dependencies.integrity.sha256(
      exportManifestRootInput(manifest),
    );
    if (root !== manifest.rootSha256) issues.push("manifest_root_mismatch");
    for (const item of manifest.items) {
      const artifact = await this.dependencies.artifacts.read(
        tenantId,
        item.artifactRef,
      );
      if (artifact === undefined) {
        issues.push(`artifact_missing:${item.recordId}`);
      } else {
        if (new TextEncoder().encode(artifact).byteLength !== item.byteLength) {
          issues.push(`artifact_length_mismatch:${item.recordId}`);
        }
        if (this.dependencies.integrity.sha256(artifact) !== item.sha256) {
          issues.push(`artifact_hash_mismatch:${item.recordId}`);
        }
      }
    }
    const valid = issues.length === 0;
    await this.dependencies.audit.append(
      this.#auditEntry(
        context,
        "privacy.export.verify",
        valid ? "manifest_verified" : "manifest_invalid",
        "manifest",
        manifestId,
        valid ? "valid" : "invalid",
        authorization,
        manifest.jobId,
      ),
    );
    return {
      valid,
      manifestId,
      checkedItems: manifest.items.length,
      issues,
    };
  }

  async #processBatch(job: PrivacyJob, maxItems: number): Promise<PrivacyJob> {
    let targetRecordIds = [...job.targetRecordIds];
    let dispositions = { ...job.dispositions };
    const completed = new Set(job.completedRecordIds);
    const held = new Set(job.heldRecordIds);
    const heldBy: Record<string, readonly string[]> = { ...job.heldBy };
    const attempts: Record<string, number> = { ...job.attempts };
    const failures = new Map(job.failures.map((failure) => [failure.recordId, failure]));
    const accessCounts = { ...job.accessCounts };
    const exportItems = new Map(
      job.exportItems.map((item) => [item.recordId, item]),
    );
    const dispositionCounts = { ...job.dispositionCounts };

    const unresolved = targetRecordIds
      .filter((recordId) => !completed.has(recordId))
      .sort((left, right) => {
        const attemptDifference = (attempts[left] ?? 0) - (attempts[right] ?? 0);
        return attemptDifference === 0
          ? targetRecordIds.indexOf(left) - targetRecordIds.indexOf(right)
          : attemptDifference;
      });
    const batch = unresolved.slice(0, maxItems);
    for (const recordId of batch) {
      attempts[recordId] = (attempts[recordId] ?? 0) + 1;
      const record = await this.dependencies.data.get(job.tenantId, recordId);
      try {
        if (job.kind === "access" || job.kind === "export") {
          if (record === undefined) {
            failures.set(recordId, {
              recordId,
              code: "record_unavailable",
              retryable: true,
              safeMessage: "Record was unavailable while creating the privacy response.",
              attempt: attempts[recordId]!,
            });
            continue;
          }
          if (record.tenantId !== job.tenantId) {
            failures.set(recordId, {
              recordId,
              code: "record_unavailable",
              retryable: false,
              safeMessage: "Record scope did not match the privacy job.",
              attempt: attempts[recordId]!,
            });
            continue;
          }
          if (job.kind === "access") {
            accessCounts[record.dataClass] =
              (accessCounts[record.dataClass] ?? 0) + 1;
          } else {
            const serialized = canonicalJson({
              schemaVersion: 1,
              tenantId: record.tenantId,
              subjectId: record.subjectId,
              recordId: record.id,
              dataClass: record.dataClass,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              data: record.payload,
            });
            const item = await this.dependencies.artifacts.put(
              job.tenantId,
              job.jobId,
              record.id,
              serialized,
              this.dependencies.integrity.sha256(serialized),
            );
            exportItems.set(record.id, item);
          }
          completed.add(recordId);
          held.delete(recordId);
          delete heldBy[recordId];
          failures.delete(recordId);
          continue;
        }

        const disposition = dispositions[recordId];
        if (disposition === undefined) {
          failures.set(recordId, {
            recordId,
            code: "adapter_failure",
            retryable: false,
            safeMessage: "No approved disposition was planned for this record.",
            attempt: attempts[recordId]!,
          });
          continue;
        }
        if (record !== undefined) {
          const activeHolds = await this.dependencies.legalHolds.activeForRecord(
            job.tenantId,
            record,
            this.dependencies.clock.now(),
          );
          if (activeHolds.length > 0) {
            held.add(recordId);
            heldBy[recordId] = activeHolds.map((hold) => hold.holdId).sort();
            failures.delete(recordId);
            continue;
          }
        }
        const mutation = await this.dependencies.data.applyDisposition(
          job.tenantId,
          recordId,
          disposition,
          job.jobId,
        );
        if (mutation.outcome === "failed") {
          failures.set(recordId, {
            recordId,
            code: "adapter_failure",
            retryable: mutation.retryable,
            safeMessage: mutation.safeMessage,
            attempt: attempts[recordId]!,
          });
          continue;
        }
        // A missing record is already absent and therefore satisfies a delete
        // disposition, but not a deidentify/minimize disposition.
        if (mutation.outcome === "not_found" && disposition !== "delete") {
          failures.set(recordId, {
            recordId,
            code: "record_unavailable",
            retryable: true,
            safeMessage: "Record disappeared before its approved disposition was applied.",
            attempt: attempts[recordId]!,
          });
          continue;
        }
        completed.add(recordId);
        held.delete(recordId);
        delete heldBy[recordId];
        failures.delete(recordId);
        const counter = dispositionCounterKey(disposition);
        dispositionCounts[counter] += 1;
      } catch {
        failures.set(recordId, {
          recordId,
          code: "adapter_failure",
          retryable: true,
          safeMessage: "A privacy storage adapter failed.",
          attempt: attempts[recordId]!,
        });
      }
    }

    const remaining = targetRecordIds.filter((recordId) => !completed.has(recordId));
    const neverAttempted = remaining.some((recordId) => (attempts[recordId] ?? 0) === 0);
    let status: PrivacyJob["status"] = "running";
    let stage: PrivacyJob["stage"] = "processing";
    let retryable = true;
    let blockedReasons: PrivacyBlockReason[] = [];
    if (remaining.length > 0 && !neverAttempted) {
      const allHeld = remaining.every((recordId) => held.has(recordId));
      status = completed.size === 0 && allHeld ? "blocked" : "partial";
      blockedReasons = [
        ...(held.size > 0 ? (["legal_hold"] as const) : []),
        ...(failures.size > 0
          ? ([
              [...failures.values()].some(
                (failure) => failure.code === "record_unavailable",
              )
                ? "record_unavailable"
                : "adapter_failure",
            ] as const)
          : []),
      ];
      retryable =
        held.size > 0 ||
        [...failures.values()].some((failure) => failure.retryable);
    }

    let result = job.result;
    if (remaining.length === 0) {
      stage = "finalizing";
      try {
        if (job.kind === "access") {
          result = {
            kind: "access",
            recordCount: targetRecordIds.length,
            dataThrough: job.dataThrough,
            countsByClass: accessCounts,
          };
        } else if (job.kind === "export") {
          requirePrivacy(
            job.subjectId !== undefined &&
              (job.identityTier === "verified" ||
                job.identityTier === "self_reported"),
            "privacy.invalid_input",
            "Export subject identity is unavailable.",
          );
          const items = [...exportItems.values()].sort((left, right) =>
            left.recordId.localeCompare(right.recordId),
          );
          const manifestId = this.dependencies.ids.next("export_manifest");
          const createdAt = this.dependencies.clock.now();
          const body = {
            schemaVersion: 1 as const,
            manifestId,
            jobId: job.jobId,
            tenantId: job.tenantId,
            subjectId: job.subjectId,
            identityTier: job.identityTier,
            createdAt,
            dataThrough: job.dataThrough,
            items,
            itemCount: items.length,
            totalBytes: items.reduce((sum, item) => sum + item.byteLength, 0),
          };
          const manifest: ExportManifest = {
            ...body,
            rootSha256: this.dependencies.integrity.sha256(
              manifestRootInput(body),
            ),
          };
          await this.dependencies.artifacts.saveManifest(manifest);
          result = {
            kind: "export",
            manifestId,
            itemCount: manifest.itemCount,
            totalBytes: manifest.totalBytes,
            rootSha256: manifest.rootSha256,
          };
        } else if (job.kind === "delete") {
          requirePrivacy(
            job.subjectId !== undefined &&
              job.identityTier !== undefined &&
              job.policyRef !== undefined,
            "privacy.invalid_input",
            "Deletion identity or policy is unavailable.",
          );
          // Reconcile records created while the job was running before
          // tombstoning the identity.
          const currentRecords = await this.dependencies.data.listForSubject(
            job.tenantId,
            job.subjectId,
          );
          const newRecords = currentRecords.filter(
            (record) => !targetRecordIds.includes(record.id),
          );
          if (newRecords.length > 0) {
            const policy = await this.dependencies.policies.getDeletionPolicy(
              job.tenantId,
              job.policyRef.policyId,
              job.policyRef.version,
            );
            if (policy === undefined) {
              status = "partial";
              retryable = false;
              blockedReasons = ["policy_not_found"];
            } else {
              const missingRule = newRecords.some(
                (record) => policy.dispositions[record.dataClass] === undefined,
              );
              if (missingRule) {
                status = "partial";
                retryable = false;
                blockedReasons = ["policy_missing_data_class_rule"];
              } else {
                for (const record of newRecords) {
                  targetRecordIds.push(record.id);
                  dispositions[record.id] = policy.dispositions[
                    record.dataClass
                  ]!;
                }
                targetRecordIds = [...new Set(targetRecordIds)].sort();
                status = "running";
                stage = "processing";
                retryable = true;
              }
            }
          } else {
            const tombstone = await this.dependencies.identities.tombstone({
              tenantId: job.tenantId,
              subjectId: job.subjectId,
              identityTier: job.identityTier,
              subjectDigest: this.dependencies.integrity.sha256(
                `${job.tenantId}\u0000${job.subjectId}`,
              ),
              deletedAt: this.dependencies.clock.now(),
              jobId: job.jobId,
              policyVersion: job.policyRef.version,
              retainedLegalHoldIds: [],
            });
            result = {
              kind: "delete",
              tombstone,
              ...dispositionCounts,
            };
          }
        } else {
          requirePrivacy(
            job.policyRef !== undefined,
            "privacy.invalid_input",
            "Retention policy is unavailable.",
          );
          result = {
            kind: "retention",
            policyId: job.policyRef.policyId,
            policyVersion: job.policyRef.version,
            dataThrough: job.dataThrough,
            ...dispositionCounts,
          };
        }
        if (
          status !== "running" &&
          blockedReasons.length === 0
        ) {
          status = "completed";
          stage = "done";
          retryable = false;
        } else if (
          remaining.length === 0 &&
          status === "running" &&
          stage === "finalizing"
        ) {
          status = "completed";
          stage = "done";
          retryable = false;
        }
      } catch (error) {
        if (error instanceof PrivacyLifecycleError) throw error;
        status = "partial";
        stage = "finalizing";
        retryable = true;
        blockedReasons = ["adapter_failure"];
      }
    }

    return {
      ...job,
      status,
      stage,
      version: job.version + 1,
      updatedAt: this.dependencies.clock.now(),
      targetRecordIds,
      dispositions,
      completedRecordIds: [...completed].sort(),
      heldRecordIds: [...held].filter((recordId) => !completed.has(recordId)).sort(),
      heldBy,
      attempts,
      failures: [...failures.values()].sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      ),
      accessCounts,
      exportItems: [...exportItems.values()].sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      ),
      dispositionCounts,
      blockedReasons: [...new Set(blockedReasons)],
      retryable,
      ...(result === undefined ? {} : { result }),
    };
  }

  async #validateContextAndTarget(
    context: PrivacyActorContext,
    targetTenantId: string,
    operation: PrivacyOperation,
  ): Promise<void> {
    requirePrivacy(
      nonEmpty(context.tenantId) &&
        nonEmpty(context.actorId) &&
        nonEmpty(context.requestId) &&
        nonEmpty(context.traceId),
      "privacy.invalid_input",
      "Authenticated privacy context is incomplete.",
    );
    if (context.tenantId !== targetTenantId) {
      await this.dependencies.audit.append(
        this.#auditEntry(
          context,
          operation,
          "authorization_denied",
          "tenant",
          targetTenantId,
          "cross_tenant",
          {
            allowed: false,
            policyVersion: "boundary",
            reasonCode: "tenant_mismatch",
          },
        ),
      );
      throw new PrivacyLifecycleError(
        "privacy.cross_tenant",
        "Privacy operations cannot cross tenant boundaries.",
      );
    }
  }

  async #authorize(
    context: PrivacyActorContext,
    operation: PrivacyOperation,
    subjectId?: string,
    confirmationGrantId?: string,
  ): Promise<AuthorizationDecision> {
    const request: AuthorizationRequest = {
      tenantId: context.tenantId,
      actorId: context.actorId,
      role: context.role,
      purpose: context.purpose,
      operation,
      ...(subjectId === undefined ? {} : { subjectId }),
      ...(confirmationGrantId === undefined ? {} : { confirmationGrantId }),
    };
    const decision = await this.dependencies.authorizer.authorize(request);
    if (!decision.allowed) {
      await this.dependencies.audit.append(
        this.#auditEntry(
          context,
          operation,
          "authorization_denied",
          subjectId === undefined ? "tenant" : "subject",
          subjectId ?? context.tenantId,
          decision.reasonCode,
          decision,
        ),
      );
      throw new PrivacyLifecycleError(
        "privacy.unauthorized",
        "The actor is not authorized for this privacy purpose and target.",
      );
    }
    return decision;
  }

  #auditEntry(
    context: PrivacyActorContext,
    operation: PrivacyOperation,
    action: PrivacyAuditAction,
    targetType: PrivacyAuditEntry["targetType"],
    targetRef: string,
    resultCode: string,
    authorization: AuthorizationDecision,
    jobId?: string,
  ): PrivacyAuditEntry {
    return {
      auditId: this.dependencies.ids.next("privacy_audit"),
      tenantId: context.tenantId,
      actorId: context.actorId,
      role: context.role,
      purpose: context.purpose,
      action,
      operation,
      targetType,
      targetRef,
      occurredAt: this.dependencies.clock.now(),
      requestId: context.requestId,
      traceId: context.traceId,
      authorizationPolicyVersion: authorization.policyVersion,
      resultCode,
      ...(jobId === undefined ? {} : { jobId }),
    };
  }
}
