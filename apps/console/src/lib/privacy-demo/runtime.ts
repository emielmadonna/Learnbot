import "server-only";

import {
  DeterministicPrivacyRuntime,
  ExplicitGrantPrivacyAuthorizer,
  InMemoryExportArtifactRepository,
  InMemoryLegalHoldRepository,
  InMemoryPersonalDataRepository,
  InMemoryPolicyRepository,
  InMemoryPrivacyStore,
  InMemorySubjectIdentityRepository,
  PrivacyLifecycleService,
  Sha256IntegrityProvider,
  type CreatePrivacyJobCommand,
  type DeletionPolicy,
  type ExplicitPrivacyGrant,
  type LegalHold,
  type ManifestVerification,
  type PersonalDataClass,
  type PersonalDataRecord,
  type PrivacyActorContext,
  type PrivacyJob,
  type PrivacyPurpose,
  type RetentionPolicy,
  type SubjectIdentity,
} from "@course-ai/privacy-lifecycle";

import {
  PRIVACY_DEMO_SUBJECTS,
  type PrivacyDemoOperation,
  type PrivacyDemoSnapshot,
  type PrivacyFixturePolicySummary,
  type PrivacyPreview,
} from "./types";

const FIXTURE_NOW = "2026-07-23T20:00:00.000Z";
const FIXTURE_REGION = "demo-us-west-fixture";
const AUTHORIZATION_POLICY_VERSION = "demo-privacy-exact-grants-v1";
const DELETION_POLICY_ID = "demo-subject-deletion-policy";
const DELETION_POLICY_VERSION = "demo-delete-fixture-v3";
const RETENTION_POLICY_ID = "demo-tenant-retention-policy";
const RETENTION_POLICY_VERSION = "demo-retention-fixture-v2";
const PREVIEW_TTL_MS = 10 * 60 * 1_000;

export const PRIVACY_DEMO_POLICY_REFS = {
  deletion: {
    policyId: DELETION_POLICY_ID,
    version: DELETION_POLICY_VERSION,
  },
  retention: {
    policyId: RETENTION_POLICY_ID,
    version: RETENTION_POLICY_VERSION,
  },
} as const;

export const PRIVACY_DEMO_DELETION_POLICY: DeletionPolicy = {
  policyId: DELETION_POLICY_ID,
  tenantId: "__bound_at_runtime__",
  version: DELETION_POLICY_VERSION,
  approvedBy: "demo-fixture-platform-owner",
  approvedAt: "2026-07-20T12:00:00.000Z",
  legalHoldMode: "suppress",
  dispositions: {
    profile: "delete",
    events: "deidentify",
    messages: "delete",
    derived_insights: "deidentify",
    evidence: "delete",
    vectors: "delete",
    assets: "delete",
    attachments: "delete",
    transcripts: "delete",
    voice_recordings: "delete",
    audit_legal: "retain_minimal",
  },
};

export const PRIVACY_DEMO_RETENTION_POLICY: RetentionPolicy = {
  policyId: RETENTION_POLICY_ID,
  tenantId: "__bound_at_runtime__",
  version: RETENTION_POLICY_VERSION,
  approvedBy: "demo-fixture-platform-owner",
  approvedAt: "2026-07-20T12:00:00.000Z",
  effectiveAt: "2026-07-21T00:00:00.000Z",
  legalHoldMode: "suppress",
  region: FIXTURE_REGION,
  rules: [
    { dataClass: "attachments", retentionDays: 14, disposition: "delete" },
    { dataClass: "transcripts", retentionDays: 30, disposition: "delete" },
    { dataClass: "messages", retentionDays: 45, disposition: "delete" },
    { dataClass: "derived_insights", retentionDays: 60, disposition: "deidentify" },
    { dataClass: "events", retentionDays: 90, disposition: "deidentify" },
    { dataClass: "audit_legal", retentionDays: 365, disposition: "retain_minimal" },
  ],
};

function policySummary(tenantId: string): PrivacyFixturePolicySummary {
  return {
    fixtureStatus: "demo_fixture_not_approved",
    policyDecisionBoundary: {
      o07VoiceRecording: "blocked_pending_O07",
      o13Retention: "fixture_only_pending_O13",
    },
    region: FIXTURE_REGION,
    rawAudioRetentionDays: null,
    deletion: { ...PRIVACY_DEMO_DELETION_POLICY, tenantId },
    retention: { ...PRIVACY_DEMO_RETENTION_POLICY, tenantId },
  };
}

function identity(
  tenantId: string,
  subjectId: string,
  tier: SubjectIdentity["tier"],
): SubjectIdentity {
  return {
    tenantId,
    subjectId,
    tier,
    status: "active",
    createdAt: "2026-01-10T00:00:00.000Z",
  };
}

function record(
  tenantId: string,
  subjectId: string,
  id: string,
  dataClass: PersonalDataClass,
  createdAt: string,
): PersonalDataRecord {
  return {
    id,
    tenantId,
    subjectId,
    dataClass,
    createdAt,
    updatedAt: createdAt,
    payload: {
      fixture: true,
      safeLabel: `${subjectId}:${dataClass}:${id}`,
    },
  };
}

function records(tenantId: string): readonly PersonalDataRecord[] {
  return [
    record(tenantId, "student_maya_demo", "maya_profile", "profile", "2026-01-10T00:00:00.000Z"),
    record(tenantId, "student_maya_demo", "maya_message", "messages", "2026-03-10T00:00:00.000Z"),
    record(tenantId, "student_maya_demo", "maya_event", "events", "2026-02-10T00:00:00.000Z"),
    record(tenantId, "student_maya_demo", "maya_transcript", "transcripts", "2026-06-01T00:00:00.000Z"),
    record(tenantId, "student_delete_demo", "delete_profile", "profile", "2026-01-05T00:00:00.000Z"),
    record(tenantId, "student_delete_demo", "delete_message", "messages", "2026-02-05T00:00:00.000Z"),
    record(tenantId, "student_held_demo", "held_profile", "profile", "2026-01-02T00:00:00.000Z"),
    record(tenantId, "student_held_demo", "held_message", "messages", "2026-01-03T00:00:00.000Z"),
    record(tenantId, "student_held_demo", "held_audit", "audit_legal", "2025-01-03T00:00:00.000Z"),
    record(tenantId, "student_anonymous_demo", "anonymous_event", "events", "2026-02-01T00:00:00.000Z"),
  ];
}

function confirmationGrantId(tenantId: string, subjectId: string): string {
  return `demo-confirm-delete:${tenantId}:${subjectId}:${DELETION_POLICY_VERSION}`;
}

function operationName(kind: PrivacyDemoOperation) {
  if (kind === "access") return "privacy.access.create" as const;
  if (kind === "export") return "privacy.export.create" as const;
  if (kind === "delete") return "privacy.delete.create" as const;
  return "privacy.retention.create" as const;
}

function purposeFor(kind: PrivacyDemoOperation): PrivacyPurpose {
  return kind === "retention"
    ? "retention_enforcement"
    : "tenant_privacy_administration";
}

function grants(
  tenantId: string,
  actorId: string,
): readonly ExplicitPrivacyGrant[] {
  const subjectGrants = PRIVACY_DEMO_SUBJECTS.flatMap((subject) => {
    const common = {
      tenantId,
      actorId,
      role: "owner" as const,
      purpose: "tenant_privacy_administration" as const,
      subjectId: subject.subjectId,
      policyVersion: AUTHORIZATION_POLICY_VERSION,
    };
    return [
      { ...common, operation: "privacy.access.create" as const },
      { ...common, operation: "privacy.export.create" as const },
      {
        ...common,
        operation: "privacy.delete.create" as const,
        confirmationGrantId: confirmationGrantId(tenantId, subject.subjectId),
      },
    ];
  });
  const operationalPurposes = [
    "tenant_privacy_administration",
    "retention_enforcement",
  ] as const;
  return [
    ...subjectGrants,
    {
      tenantId,
      actorId,
      role: "owner",
      purpose: "retention_enforcement",
      operation: "privacy.retention.create",
      policyVersion: AUTHORIZATION_POLICY_VERSION,
    },
    ...operationalPurposes.flatMap((purpose) => [
      {
        tenantId,
        actorId,
        role: "owner" as const,
        purpose,
        operation: "privacy.job.execute" as const,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      },
      {
        tenantId,
        actorId,
        role: "owner" as const,
        purpose,
        operation: "privacy.job.read" as const,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      },
      {
        tenantId,
        actorId,
        role: "owner" as const,
        purpose,
        operation: "privacy.export.verify" as const,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      },
    ]),
  ];
}

interface StoredPreview {
  readonly preview: PrivacyPreview;
  readonly fingerprint: string;
}

interface PrivacyDemoRuntime {
  readonly tenantId: string;
  readonly actorId: string;
  readonly service: PrivacyLifecycleService;
  readonly data: InMemoryPersonalDataRepository;
  readonly policies: InMemoryPolicyRepository;
  readonly holds: InMemoryLegalHoldRepository;
  readonly jobs: InMemoryPrivacyStore;
  readonly identities: InMemorySubjectIdentityRepository;
  readonly artifacts: InMemoryExportArtifactRepository;
  readonly jobIds: string[];
  readonly verifications: Map<string, ManifestVerification>;
  readonly previews: Map<string, StoredPreview>;
}

function actorContext(
  runtime: PrivacyDemoRuntime,
  purpose: PrivacyPurpose,
  suffix = crypto.randomUUID(),
): PrivacyActorContext {
  return {
    tenantId: runtime.tenantId,
    actorId: runtime.actorId,
    role: "owner",
    purpose,
    requestId: `privacy-demo-request:${suffix}`,
    traceId: `privacy-demo-trace:${suffix}`,
  };
}

async function runUntilSettled(
  runtime: PrivacyDemoRuntime,
  job: PrivacyJob,
): Promise<PrivacyJob> {
  let current = job;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "partial" ||
      current.status === "blocked"
    ) {
      return current;
    }
    current = await runtime.service.resumeJob(
      actorContext(runtime, current.requestedBy.purpose, `seed-${current.jobId}-${attempt}`),
      runtime.tenantId,
      current.jobId,
      100,
    );
  }
  return current;
}

async function createSeedJob(
  runtime: PrivacyDemoRuntime,
  command: CreatePrivacyJobCommand,
): Promise<PrivacyJob> {
  const purpose = purposeFor(command.kind);
  const created = await runtime.service.createJob(actorContext(runtime, purpose), command);
  if (!runtime.jobIds.includes(created.jobId)) runtime.jobIds.push(created.jobId);
  return runUntilSettled(runtime, created);
}

async function createRuntime(
  tenantId: string,
  actorId: string,
): Promise<PrivacyDemoRuntime> {
  const fixturePolicies = policySummary(tenantId);
  const identities = new InMemorySubjectIdentityRepository([
    identity(tenantId, "student_maya_demo", "verified"),
    identity(tenantId, "student_delete_demo", "self_reported"),
    identity(tenantId, "student_held_demo", "verified"),
    identity(tenantId, "student_anonymous_demo", "anonymous"),
  ]);
  const data = new InMemoryPersonalDataRepository(records(tenantId));
  const policies = new InMemoryPolicyRepository({
    deletion: [fixturePolicies.deletion],
    retention: [fixturePolicies.retention],
  });
  const hold: LegalHold = {
    holdId: "demo-hold-held-message",
    tenantId,
    status: "active",
    reason: "DEMO FIXTURE — litigation preservation example",
    startsAt: "2026-07-01T00:00:00.000Z",
    subjectId: "student_held_demo",
    recordIds: ["held_message"],
  };
  const holds = new InMemoryLegalHoldRepository([hold]);
  const jobs = new InMemoryPrivacyStore();
  const artifacts = new InMemoryExportArtifactRepository();
  const deterministic = new DeterministicPrivacyRuntime(FIXTURE_NOW);
  const runtime: PrivacyDemoRuntime = {
    tenantId,
    actorId,
    service: new PrivacyLifecycleService({
      authorizer: new ExplicitGrantPrivacyAuthorizer(grants(tenantId, actorId)),
      identities,
      data,
      policies,
      legalHolds: holds,
      jobs,
      audit: jobs,
      artifacts,
      integrity: new Sha256IntegrityProvider(),
      clock: deterministic,
      ids: deterministic,
    }),
    data,
    policies,
    holds,
    jobs,
    identities,
    artifacts,
    jobIds: [],
    verifications: new Map(),
    previews: new Map(),
  };

  await createSeedJob(runtime, {
    kind: "access",
    tenantId,
    subjectId: "student_maya_demo",
    idempotencyKey: "seed-access-maya-v1",
  });
  const exportJob = await createSeedJob(runtime, {
    kind: "export",
    tenantId,
    subjectId: "student_maya_demo",
    idempotencyKey: "seed-export-maya-v1",
  });
  if (exportJob.result?.kind === "export") {
    runtime.verifications.set(
      exportJob.result.manifestId,
      await runtime.service.verifyExport(
        actorContext(runtime, "tenant_privacy_administration", "seed-verify"),
        tenantId,
        exportJob.result.manifestId,
      ),
    );
  }
  await createSeedJob(runtime, {
    kind: "delete",
    tenantId,
    subjectId: "student_delete_demo",
    policyRef: PRIVACY_DEMO_POLICY_REFS.deletion,
    confirmationGrantId: confirmationGrantId(tenantId, "student_delete_demo"),
    idempotencyKey: "seed-delete-complete-v1",
  });
  await createSeedJob(runtime, {
    kind: "delete",
    tenantId,
    subjectId: "student_held_demo",
    policyRef: PRIVACY_DEMO_POLICY_REFS.deletion,
    confirmationGrantId: confirmationGrantId(tenantId, "student_held_demo"),
    idempotencyKey: "seed-delete-held-v1",
  });
  await createSeedJob(runtime, {
    kind: "retention",
    tenantId,
    policyRef: PRIVACY_DEMO_POLICY_REFS.retention,
    dataThrough: FIXTURE_NOW,
    idempotencyKey: "seed-retention-held-v1",
  });
  return runtime;
}

const privacyGlobal = globalThis as typeof globalThis & {
  __courseAiPrivacyDemoRuntimes?: Map<string, Promise<PrivacyDemoRuntime>>;
};

export async function getPrivacyDemoRuntime(
  tenantId: string,
  actorId: string,
): Promise<PrivacyDemoRuntime> {
  privacyGlobal.__courseAiPrivacyDemoRuntimes ??= new Map();
  const key = `${tenantId}\u0000${actorId}`;
  let runtime = privacyGlobal.__courseAiPrivacyDemoRuntimes.get(key);
  if (!runtime) {
    runtime = createRuntime(tenantId, actorId);
    privacyGlobal.__courseAiPrivacyDemoRuntimes.set(key, runtime);
  }
  return runtime;
}

function previewFingerprint(input: {
  operation: PrivacyDemoOperation;
  purpose: PrivacyPurpose;
  subjectId?: string;
  dataThrough?: string;
  policyId?: string;
  policyVersion?: string;
}) {
  return JSON.stringify(input);
}

export async function createPrivacyPreview(
  runtime: PrivacyDemoRuntime,
  input: {
    operation: PrivacyDemoOperation;
    purpose: PrivacyPurpose;
    subjectId?: string;
    dataThrough?: string;
  },
): Promise<PrivacyPreview> {
  for (const [token, stored] of runtime.previews) {
    if (Date.parse(stored.preview.expiresAt) < Date.now()) {
      runtime.previews.delete(token);
    }
  }
  while (runtime.previews.size >= 100) {
    const oldest = runtime.previews.keys().next().value as string | undefined;
    if (!oldest) break;
    runtime.previews.delete(oldest);
  }
  const expectedPurpose = purposeFor(input.operation);
  if (input.purpose !== expectedPurpose) {
    throw new Error(`Purpose must be ${expectedPurpose} for ${input.operation}.`);
  }
  const deletionPolicy =
    input.operation === "delete"
      ? policySummary(runtime.tenantId).deletion
      : undefined;
  const retentionPolicy =
    input.operation === "retention"
      ? policySummary(runtime.tenantId).retention
      : undefined;
  const policy = deletionPolicy ?? retentionPolicy;
  if (input.operation !== "retention" && !input.subjectId) {
    throw new Error("A subject is required for this privacy operation.");
  }
  if (
    input.subjectId &&
    !PRIVACY_DEMO_SUBJECTS.some((subject) => subject.subjectId === input.subjectId)
  ) {
    throw new Error("The subject is not part of this tenant fixture.");
  }
  const targetRecords =
    input.operation === "retention"
      ? (
          await Promise.all(
            retentionPolicy!.rules.map(async (rule) => {
              const dataThrough = input.dataThrough ?? FIXTURE_NOW;
              const cutoff = new Date(
                Date.parse(dataThrough) - rule.retentionDays * 86_400_000,
              ).toISOString();
              return runtime.data.listForRetention(runtime.tenantId, rule.dataClass, cutoff);
            }),
          )
        ).flat()
      : await runtime.data.listForSubject(runtime.tenantId, input.subjectId!);
  const heldRecordIds: string[] = [];
  for (const targetRecord of targetRecords) {
    const active = await runtime.holds.activeForRecord(
      runtime.tenantId,
      targetRecord,
      FIXTURE_NOW,
    );
    if (active.length > 0) heldRecordIds.push(targetRecord.id);
  }
  const previewToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const target = input.operation === "retention" ? runtime.tenantId : input.subjectId!;
  const requiredConfirmationPhrase =
    input.operation === "delete"
      ? `DELETE ${input.subjectId} UNDER ${DELETION_POLICY_VERSION}`
      : input.operation === "retention"
        ? `APPLY ${RETENTION_POLICY_VERSION} THROUGH ${input.dataThrough ?? FIXTURE_NOW}`
        : undefined;
  const preview: PrivacyPreview = {
    previewToken,
    expiresAt,
    operation: input.operation,
    purpose: input.purpose,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    impactedRecordCount: new Set(targetRecords.map((record) => record.id)).size,
    heldRecordIds: [...new Set(heldRecordIds)].sort(),
    ...(policy ? { policyId: policy.policyId, policyVersion: policy.version } : {}),
    ...(input.operation === "retention"
      ? { dataThrough: input.dataThrough ?? FIXTURE_NOW }
      : {}),
    ...(requiredConfirmationPhrase ? { requiredConfirmationPhrase } : {}),
    ...(input.operation === "delete"
      ? { confirmationGrantId: confirmationGrantId(runtime.tenantId, input.subjectId!) }
      : {}),
    exactGrant: {
      actorId: runtime.actorId,
      role: "owner",
      purpose: input.purpose,
      operation: operationName(input.operation),
      target,
      policyVersion: AUTHORIZATION_POLICY_VERSION,
    },
    warning:
      input.operation === "delete" || input.operation === "retention"
        ? "Dangerous development fixture: preview and exact confirmation are required. Legal holds suppress mutation."
        : "Development fixture only. The returned result is not compliance evidence.",
  };
  runtime.previews.set(previewToken, {
    preview,
    fingerprint: previewFingerprint({
      operation: input.operation,
      purpose: input.purpose,
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      ...(preview.dataThrough ? { dataThrough: preview.dataThrough } : {}),
      ...(preview.policyId ? { policyId: preview.policyId } : {}),
      ...(preview.policyVersion ? { policyVersion: preview.policyVersion } : {}),
    }),
  });
  return preview;
}

export function consumeDangerousPreview(
  runtime: PrivacyDemoRuntime,
  input: {
    previewToken: string;
    confirmationPhrase: string;
    operation: Extract<PrivacyDemoOperation, "delete" | "retention">;
    purpose: PrivacyPurpose;
    subjectId?: string;
    dataThrough?: string;
  },
): PrivacyPreview {
  const stored = runtime.previews.get(input.previewToken);
  if (!stored || Date.parse(stored.preview.expiresAt) < Date.now()) {
    throw new Error("Preview token is missing or expired.");
  }
  const expectedFingerprint = previewFingerprint({
    operation: input.operation,
    purpose: input.purpose,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(stored.preview.dataThrough
      ? { dataThrough: input.dataThrough ?? stored.preview.dataThrough }
      : {}),
    ...(stored.preview.policyId ? { policyId: stored.preview.policyId } : {}),
    ...(stored.preview.policyVersion
      ? { policyVersion: stored.preview.policyVersion }
      : {}),
  });
  if (
    stored.fingerprint !== expectedFingerprint ||
    input.confirmationPhrase !== stored.preview.requiredConfirmationPhrase
  ) {
    throw new Error("Preview target or exact confirmation phrase did not match.");
  }
  runtime.previews.delete(input.previewToken);
  return stored.preview;
}

export async function createPrivacyJob(
  runtime: PrivacyDemoRuntime,
  input: {
    operation: PrivacyDemoOperation;
    purpose: PrivacyPurpose;
    subjectId?: string;
    dataThrough?: string;
    idempotencyKey: string;
    confirmationGrantId?: string;
  },
): Promise<PrivacyJob> {
  let command: CreatePrivacyJobCommand;
  if (input.operation === "access" || input.operation === "export") {
    if (!input.subjectId) throw new Error("A subject is required.");
    command = {
      kind: input.operation,
      tenantId: runtime.tenantId,
      subjectId: input.subjectId,
      idempotencyKey: input.idempotencyKey,
    };
  } else if (input.operation === "delete") {
    if (!input.subjectId || !input.confirmationGrantId) {
      throw new Error("Deletion requires an exact subject and confirmation grant.");
    }
    command = {
      kind: "delete",
      tenantId: runtime.tenantId,
      subjectId: input.subjectId,
      idempotencyKey: input.idempotencyKey,
      policyRef: PRIVACY_DEMO_POLICY_REFS.deletion,
      confirmationGrantId: input.confirmationGrantId,
    };
  } else {
    command = {
      kind: "retention",
      tenantId: runtime.tenantId,
      idempotencyKey: input.idempotencyKey,
      policyRef: PRIVACY_DEMO_POLICY_REFS.retention,
      dataThrough: input.dataThrough ?? FIXTURE_NOW,
    };
  }
  const job = await runtime.service.createJob(
    actorContext(runtime, input.purpose),
    command,
  );
  if (!runtime.jobIds.includes(job.jobId)) runtime.jobIds.push(job.jobId);
  return job;
}

export async function executePrivacyJob(
  runtime: PrivacyDemoRuntime,
  jobId: string,
): Promise<PrivacyJob> {
  const current = await runtime.jobs.get(runtime.tenantId, jobId);
  if (!current) throw new Error("Privacy job was not found in this tenant.");
  return runtime.service.resumeJob(
    actorContext(runtime, current.requestedBy.purpose),
    runtime.tenantId,
    jobId,
    100,
  );
}

export async function verifyPrivacyManifest(
  runtime: PrivacyDemoRuntime,
  manifestId: string,
): Promise<ManifestVerification> {
  const verification = await runtime.service.verifyExport(
    actorContext(runtime, "tenant_privacy_administration"),
    runtime.tenantId,
    manifestId,
  );
  runtime.verifications.set(manifestId, verification);
  return verification;
}

export async function privacyDemoSnapshot(
  runtime: PrivacyDemoRuntime,
  tenant: {
    tenantSlug: string;
    actorDisplayName?: string;
    membershipRole: string;
  },
): Promise<PrivacyDemoSnapshot> {
  const jobs = (
    await Promise.all(
      runtime.jobIds.map((jobId) => runtime.jobs.get(runtime.tenantId, jobId)),
    )
  )
    .filter((job): job is PrivacyJob => job !== undefined)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  const manifests = [];
  for (const job of jobs) {
    if (job.result?.kind !== "export") continue;
    const manifest = await runtime.artifacts.getManifest(
      runtime.tenantId,
      job.result.manifestId,
    );
    if (!manifest) continue;
    manifests.push({
      manifestId: manifest.manifestId,
      jobId: manifest.jobId,
      itemCount: manifest.itemCount,
      totalBytes: manifest.totalBytes,
      rootSha256: manifest.rootSha256,
      ...(runtime.verifications.get(manifest.manifestId)
        ? { verification: runtime.verifications.get(manifest.manifestId)! }
        : {}),
    });
  }
  const tombstones = (
    await Promise.all(
      PRIVACY_DEMO_SUBJECTS.map((subject) =>
        runtime.identities.getTombstone(runtime.tenantId, subject.subjectId),
      ),
    )
  ).filter((value): value is NonNullable<typeof value> => value !== undefined);
  const audit = [...(await runtime.jobs.list(runtime.tenantId))].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt),
  );
  return {
    fixture: {
      label: "DEVELOPMENT FIXTURE — NOT PRODUCTION POLICY OR COMPLIANCE EVIDENCE",
      durable: false,
      productionIdpConfigured: false,
    },
    tenant: {
      tenantId: runtime.tenantId,
      tenantSlug: tenant.tenantSlug,
      ...(tenant.actorDisplayName ? { actorDisplayName: tenant.actorDisplayName } : {}),
      actorId: runtime.actorId,
      membershipRole: tenant.membershipRole,
    },
    policies: policySummary(runtime.tenantId),
    subjects: PRIVACY_DEMO_SUBJECTS,
    holds: runtime.holds.holds,
    jobs,
    manifests,
    tombstones,
    audit,
    exactGrantPolicyVersion: AUTHORIZATION_POLICY_VERSION,
  };
}

export function requiredPurpose(operation: PrivacyDemoOperation): PrivacyPurpose {
  return purposeFor(operation);
}
