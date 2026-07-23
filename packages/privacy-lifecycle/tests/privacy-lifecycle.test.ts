import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicPrivacyRuntime,
  ExplicitGrantPrivacyAuthorizer,
  InMemoryExportArtifactRepository,
  InMemoryLegalHoldRepository,
  InMemoryPersonalDataRepository,
  InMemoryPolicyRepository,
  InMemoryPrivacyStore,
  InMemorySubjectIdentityRepository,
  PrivacyLifecycleError,
  PrivacyLifecycleService,
  Sha256IntegrityProvider,
  validateDeletionPolicy,
  validateRetentionPolicy,
} from "../src/index.js";
import type {
  DeletionPolicy,
  ExplicitPrivacyGrant,
  IdentityTier,
  LegalHold,
  PersonalDataClass,
  PersonalDataRecord,
  PrivacyActorContext,
  PrivacyJob,
  RetentionPolicy,
  SubjectIdentity,
} from "../src/index.js";

const NOW = "2026-07-23T12:00:00.000Z";
const TENANT_ALPHA = "tenant_alpha";
const TENANT_BETA = "tenant_beta";
const SUBJECT = "student_1";

function identity(
  tenantId = TENANT_ALPHA,
  subjectId = SUBJECT,
  tier: IdentityTier = "verified",
): SubjectIdentity {
  return {
    tenantId,
    subjectId,
    tier,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function record(
  id: string,
  dataClass: PersonalDataClass,
  input: {
    readonly tenantId?: string;
    readonly subjectId?: string;
    readonly createdAt?: string;
    readonly payload?: unknown;
  } = {},
): PersonalDataRecord {
  const tenantId = input.tenantId ?? TENANT_ALPHA;
  const subjectId = input.subjectId ?? SUBJECT;
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00.000Z";
  return {
    id,
    tenantId,
    subjectId,
    dataClass,
    createdAt,
    updatedAt: createdAt,
    payload: input.payload ?? { value: `${tenantId}:${subjectId}:${id}` },
  };
}

function deletionPolicy(
  tenantId = TENANT_ALPHA,
  overrides: Partial<DeletionPolicy> = {},
): DeletionPolicy {
  return {
    policyId: "delete-policy",
    tenantId,
    version: "delete-v1",
    approvedBy: "privacy_owner",
    approvedAt: "2026-07-01T00:00:00.000Z",
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
    ...overrides,
  };
}

function retentionPolicy(
  tenantId = TENANT_ALPHA,
  overrides: Partial<RetentionPolicy> = {},
): RetentionPolicy {
  return {
    policyId: "retention-policy",
    tenantId,
    version: "retention-v1",
    approvedBy: "privacy_owner",
    approvedAt: "2026-06-01T00:00:00.000Z",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    legalHoldMode: "suppress",
    rules: [
      { dataClass: "messages", retentionDays: 30, disposition: "delete" },
      { dataClass: "events", retentionDays: 60, disposition: "deidentify" },
    ],
    ...overrides,
  };
}

function context(
  tenantId = TENANT_ALPHA,
  purpose: PrivacyActorContext["purpose"] = "tenant_privacy_administration",
): PrivacyActorContext {
  return {
    tenantId,
    actorId: "admin_1",
    role: "client_admin",
    purpose,
    requestId: `request_${tenantId}`,
    traceId: `trace_${tenantId}`,
  };
}

function grants(
  tenantId = TENANT_ALPHA,
  subjectId = SUBJECT,
): ExplicitPrivacyGrant[] {
  const common = {
    tenantId,
    actorId: "admin_1",
    role: "client_admin" as const,
    purpose: "tenant_privacy_administration" as const,
    policyVersion: "privacy-authz-v1",
  };
  return [
    { ...common, operation: "privacy.access.create", subjectId },
    { ...common, operation: "privacy.export.create", subjectId },
    {
      ...common,
      operation: "privacy.delete.create",
      subjectId,
      confirmationGrantId: "confirm-delete-student-1",
    },
    { ...common, operation: "privacy.retention.create" },
    { ...common, operation: "privacy.job.execute" },
    { ...common, operation: "privacy.job.read" },
    { ...common, operation: "privacy.export.verify" },
  ];
}

interface Harness {
  readonly service: PrivacyLifecycleService;
  readonly identities: InMemorySubjectIdentityRepository;
  readonly data: InMemoryPersonalDataRepository;
  readonly policies: InMemoryPolicyRepository;
  readonly holds: InMemoryLegalHoldRepository;
  readonly jobs: InMemoryPrivacyStore;
  readonly artifacts: InMemoryExportArtifactRepository;
  readonly runtime: DeterministicPrivacyRuntime;
  readonly authorizer: ExplicitGrantPrivacyAuthorizer;
}

function harness(input: {
  readonly identities?: readonly SubjectIdentity[];
  readonly records?: readonly PersonalDataRecord[];
  readonly deletionPolicies?: readonly DeletionPolicy[];
  readonly retentionPolicies?: readonly RetentionPolicy[];
  readonly legalHolds?: readonly LegalHold[];
  readonly grants?: readonly ExplicitPrivacyGrant[];
} = {}): Harness {
  const identities = new InMemorySubjectIdentityRepository(
    input.identities ?? [identity()],
  );
  const data = new InMemoryPersonalDataRepository(
    input.records ?? [
      record("profile_1", "profile"),
      record("message_1", "messages", {
        payload: { text: "Personal learning question" },
      }),
    ],
  );
  const policies = new InMemoryPolicyRepository({
    deletion: input.deletionPolicies ?? [deletionPolicy()],
    retention: input.retentionPolicies ?? [retentionPolicy()],
  });
  const holds = new InMemoryLegalHoldRepository([...(input.legalHolds ?? [])]);
  const jobs = new InMemoryPrivacyStore();
  const artifacts = new InMemoryExportArtifactRepository();
  const runtime = new DeterministicPrivacyRuntime(NOW);
  const authorizer = new ExplicitGrantPrivacyAuthorizer(
    input.grants ?? grants(),
  );
  const service = new PrivacyLifecycleService({
    authorizer,
    identities,
    data,
    policies,
    legalHolds: holds,
    jobs,
    audit: jobs,
    artifacts,
    integrity: new Sha256IntegrityProvider(),
    clock: runtime,
    ids: runtime,
  });
  return {
    service,
    identities,
    data,
    policies,
    holds,
    jobs,
    artifacts,
    runtime,
    authorizer,
  };
}

async function runToTerminal(
  setup: Harness,
  job: PrivacyJob,
  maxItems = 100,
): Promise<PrivacyJob> {
  let current = job;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      (current.status === "blocked" && !current.retryable) ||
      (current.status === "partial" && !current.retryable)
    ) {
      return current;
    }
    current = await setup.service.resumeJob(
      context(current.tenantId),
      current.tenantId,
      current.jobId,
      maxItems,
    );
  }
  throw new Error("job did not reach a terminal state");
}

test("authorization is deny-by-default and binds actor, role, purpose, operation, and subject", async () => {
  const setup = harness({ grants: [] });
  await assert.rejects(
    setup.service.createJob(context(), {
      kind: "export",
      tenantId: TENANT_ALPHA,
      subjectId: SUBJECT,
      idempotencyKey: "export-denied",
    }),
    (error: unknown) =>
      error instanceof PrivacyLifecycleError &&
      error.code === "privacy.unauthorized",
  );
  const audit = await setup.jobs.list(TENANT_ALPHA);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, "authorization_denied");
  assert.equal(audit[0]?.operation, "privacy.export.create");
  assert.equal(audit[0]?.purpose, "tenant_privacy_administration");

  const wrongPurpose = harness();
  await assert.rejects(
    wrongPurpose.service.createJob(
      context(TENANT_ALPHA, "subject_access_request"),
      {
        kind: "export",
        tenantId: TENANT_ALPHA,
        subjectId: SUBJECT,
        idempotencyKey: "wrong-purpose",
      },
    ),
    (error: unknown) =>
      error instanceof PrivacyLifecycleError &&
      error.code === "privacy.unauthorized",
  );
});

test("cross-tenant create/read/execute never addresses another tenant and is audited locally", async () => {
  const setup = harness({
    identities: [identity(TENANT_ALPHA), identity(TENANT_BETA)],
    records: [
      record("shared_id", "messages", { tenantId: TENANT_ALPHA }),
      record("shared_id", "messages", { tenantId: TENANT_BETA }),
    ],
    grants: [...grants(TENANT_ALPHA), ...grants(TENANT_BETA)],
  });
  await assert.rejects(
    setup.service.createJob(context(TENANT_ALPHA), {
      kind: "delete",
      tenantId: TENANT_BETA,
      subjectId: SUBJECT,
      idempotencyKey: "cross-delete",
      policyRef: { policyId: "delete-policy", version: "delete-v1" },
      confirmationGrantId: "confirm-delete-student-1",
    }),
    (error: unknown) =>
      error instanceof PrivacyLifecycleError &&
      error.code === "privacy.cross_tenant",
  );
  assert.ok(await setup.data.get(TENANT_BETA, "shared_id"));
  const audit = await setup.jobs.list(TENANT_ALPHA);
  assert.equal(audit.at(-1)?.action, "authorization_denied");
  assert.equal(audit.at(-1)?.resultCode, "cross_tenant");

  const alphaJob = await setup.service.createJob(context(TENANT_ALPHA), {
    kind: "access",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "alpha-access",
  });
  await assert.rejects(
    setup.service.getJob(context(TENANT_BETA), TENANT_ALPHA, alphaJob.jobId),
    (error: unknown) =>
      error instanceof PrivacyLifecycleError &&
      error.code === "privacy.cross_tenant",
  );
});

test("job creation is idempotent and changed command reuse is a conflict without duplicate work", async () => {
  const setup = harness();
  const command = {
    kind: "export" as const,
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "export-once",
  };
  const first = await setup.service.createJob(context(), command);
  const replay = await setup.service.createJob(context(), command);
  assert.equal(replay.jobId, first.jobId);
  const audits = await setup.jobs.list(TENANT_ALPHA);
  assert.deepEqual(
    audits.map((entry) => entry.action),
    ["job_created", "job_replayed"],
  );

  await assert.rejects(
    setup.service.createJob(context(), {
      ...command,
      kind: "access",
    }),
    (error: unknown) =>
      error instanceof PrivacyLifecycleError &&
      error.code === "privacy.idempotency_conflict",
  );
  assert.equal((await setup.jobs.list(TENANT_ALPHA)).at(-1)?.action, "idempotency_conflict");
});

test("anonymous identities are honestly blocked while self-reported exports preserve their tier", async () => {
  const anonymousSetup = harness({
    identities: [identity(TENANT_ALPHA, SUBJECT, "anonymous")],
  });
  const blocked = await anonymousSetup.service.createJob(context(), {
    kind: "export",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "anonymous-export",
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.retryable, false);
  assert.ok(blocked.blockedReasons.includes("anonymous_identity"));

  const selfReportedSetup = harness({
    identities: [identity(TENANT_ALPHA, SUBJECT, "self_reported")],
  });
  const created = await selfReportedSetup.service.createJob(context(), {
    kind: "export",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "self-reported-export",
  });
  const completed = await runToTerminal(selfReportedSetup, created);
  assert.equal(completed.status, "completed");
  assert.equal(completed.identityTier, "self_reported");
  assert.equal(completed.result?.kind, "export");
  if (completed.result?.kind !== "export") return;
  const manifest = await selfReportedSetup.artifacts.getManifest(
    TENANT_ALPHA,
    completed.result.manifestId,
  );
  assert.equal(manifest?.identityTier, "self_reported");
});

test("access inventory is bounded/resumable and reports snapshot coverage without leaking payloads", async () => {
  const setup = harness({
    records: [
      record("profile_1", "profile"),
      record("message_1", "messages"),
      record("event_1", "events"),
    ],
  });
  const created = await setup.service.createJob(context(), {
    kind: "access",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "access-resume",
  });
  const first = await setup.service.resumeJob(
    context(),
    TENANT_ALPHA,
    created.jobId,
    1,
  );
  assert.equal(first.status, "running");
  assert.equal(first.completedRecordIds.length, 1);
  const completed = await runToTerminal(setup, first, 1);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, {
    kind: "access",
    recordCount: 3,
    dataThrough: NOW,
    countsByClass: {
      events: 1,
      messages: 1,
      profile: 1,
    },
  });
  assert.equal(JSON.stringify(completed.result).includes("Personal"), false);
});

test("export manifest binds every artifact hash, byte length, tenant, subject, tier, and root hash", async () => {
  const setup = harness({
    records: [
      record("profile_1", "profile", { payload: { displayName: "Maya 🌱" } }),
      record("message_1", "messages", { payload: { text: "Help me learn." } }),
      record("insight_1", "derived_insights", { payload: { state: "partial" } }),
    ],
  });
  const created = await setup.service.createJob(context(), {
    kind: "export",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "integrity-export",
  });
  const completed = await runToTerminal(setup, created, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.kind, "export");
  if (completed.result?.kind !== "export") return;
  const manifest = await setup.artifacts.getManifest(
    TENANT_ALPHA,
    completed.result.manifestId,
  );
  assert.ok(manifest);
  assert.equal(manifest.tenantId, TENANT_ALPHA);
  assert.equal(manifest.subjectId, SUBJECT);
  assert.equal(manifest.identityTier, "verified");
  assert.equal(manifest.itemCount, 3);
  assert.equal(manifest.items.length, 3);
  assert.ok(manifest.items.every((item) => item.sha256.length === 64));
  assert.equal(manifest.rootSha256.length, 64);

  const verification = await setup.service.verifyExport(
    context(),
    TENANT_ALPHA,
    manifest.manifestId,
  );
  assert.deepEqual(verification, {
    valid: true,
    manifestId: manifest.manifestId,
    checkedItems: 3,
    issues: [],
  });

  setup.artifacts.tamperManifest(
    TENANT_ALPHA,
    manifest.manifestId,
    (value) => ({ ...value, itemCount: value.itemCount + 1 }),
  );
  const rootTampered = await setup.service.verifyExport(
    context(),
    TENANT_ALPHA,
    manifest.manifestId,
  );
  assert.equal(rootTampered.valid, false);
  assert.ok(rootTampered.issues.includes("manifest_root_mismatch"));
  setup.artifacts.tamperManifest(
    TENANT_ALPHA,
    manifest.manifestId,
    () => manifest,
  );

  setup.artifacts.tamperArtifact(
    TENANT_ALPHA,
    manifest.items[0]!.artifactRef,
    '{"tampered":true}',
  );
  const tampered = await setup.service.verifyExport(
    context(),
    TENANT_ALPHA,
    manifest.manifestId,
  );
  assert.equal(tampered.valid, false);
  assert.ok(
    tampered.issues.some(
      (issue) =>
        issue.startsWith("artifact_hash_mismatch:") ||
        issue.startsWith("artifact_length_mismatch:"),
    ),
  );
});

test("manifest lookup and artifact storage are tenant-scoped even when IDs are guessed", async () => {
  const setup = harness();
  const completed = await runToTerminal(
    setup,
    await setup.service.createJob(context(), {
      kind: "export",
      tenantId: TENANT_ALPHA,
      subjectId: SUBJECT,
      idempotencyKey: "tenant-export",
    }),
  );
  assert.equal(completed.result?.kind, "export");
  if (completed.result?.kind !== "export") return;
  assert.equal(
    await setup.artifacts.getManifest(TENANT_BETA, completed.result.manifestId),
    undefined,
  );
  await assert.rejects(
    setup.service.verifyExport(
      context(TENANT_BETA),
      TENANT_ALPHA,
      completed.result.manifestId,
    ),
    (error: unknown) =>
      error instanceof PrivacyLifecycleError &&
      error.code === "privacy.cross_tenant",
  );
});

test("a record disappearing during export produces an honest resumable partial state", async () => {
  const setup = harness({
    records: [record("message_1", "messages"), record("message_2", "messages")],
  });
  const created = await setup.service.createJob(context(), {
    kind: "export",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "partial-export",
  });
  setup.data.removeForTest(TENANT_ALPHA, "message_2");
  const partial = await setup.service.resumeJob(
    context(),
    TENANT_ALPHA,
    created.jobId,
    10,
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.retryable, true);
  assert.ok(partial.blockedReasons.includes("record_unavailable"));
  assert.equal(partial.result, undefined);
  assert.equal(partial.failures[0]?.recordId, "message_2");
});

test("deletion applies approved class dispositions, reconciles late records, and tombstones identity", async () => {
  const setup = harness({
    records: [
      record("profile_1", "profile"),
      record("message_1", "messages"),
      record("event_1", "events"),
      record("audit_1", "audit_legal"),
    ],
  });
  const created = await setup.service.createJob(context(), {
    kind: "delete",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "delete-subject",
    policyRef: { policyId: "delete-policy", version: "delete-v1" },
    confirmationGrantId: "confirm-delete-student-1",
  });
  setup.data.put(record("late_vector", "vectors"));
  const afterFirstPass = await setup.service.resumeJob(
    context(),
    TENANT_ALPHA,
    created.jobId,
    100,
  );
  assert.equal(afterFirstPass.status, "running");
  assert.ok(afterFirstPass.targetRecordIds.includes("late_vector"));
  const completed = await runToTerminal(setup, afterFirstPass);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.kind, "delete");
  if (completed.result?.kind !== "delete") return;
  assert.deepEqual(
    {
      deleted: completed.result.deleted,
      deidentified: completed.result.deidentified,
      retainedMinimal: completed.result.retainedMinimal,
    },
    { deleted: 3, deidentified: 1, retainedMinimal: 1 },
  );
  assert.equal(await setup.data.get(TENANT_ALPHA, "message_1"), undefined);
  assert.equal(await setup.data.get(TENANT_ALPHA, "late_vector"), undefined);
  assert.deepEqual(
    (await setup.data.get(TENANT_ALPHA, "event_1"))?.payload,
    { deidentified: true },
  );
  assert.deepEqual(
    (await setup.data.get(TENANT_ALPHA, "audit_1"))?.payload,
    { retainedMinimal: true },
  );
  assert.equal(
    (await setup.identities.get(TENANT_ALPHA, SUBJECT))?.status,
    "tombstoned",
  );
  const tombstone = await setup.identities.getTombstone(TENANT_ALPHA, SUBJECT);
  assert.equal(tombstone?.jobId, completed.jobId);
  assert.equal(tombstone?.subjectDigest.length, 64);
  assert.equal(JSON.stringify(tombstone).includes("Personal"), false);

  const repeatedWithNewKey = await setup.service.createJob(context(), {
    kind: "delete",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "delete-after-tombstone",
    policyRef: { policyId: "delete-policy", version: "delete-v1" },
    confirmationGrantId: "confirm-delete-student-1",
  });
  assert.equal(repeatedWithNewKey.status, "blocked");
  assert.ok(repeatedWithNewKey.blockedReasons.includes("identity_tombstoned"));
});

test("legal hold suppresses deletion with no mutation and the same job resumes after release", async () => {
  const hold: LegalHold = {
    holdId: "hold_1",
    tenantId: TENANT_ALPHA,
    status: "active",
    reason: "Active litigation hold",
    startsAt: "2026-07-01T00:00:00.000Z",
    subjectId: SUBJECT,
  };
  const setup = harness({
    records: [record("message_1", "messages")],
    legalHolds: [hold],
  });
  const created = await setup.service.createJob(context(), {
    kind: "delete",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "held-delete",
    policyRef: { policyId: "delete-policy", version: "delete-v1" },
    confirmationGrantId: "confirm-delete-student-1",
  });
  const blocked = await setup.service.resumeJob(
    context(),
    TENANT_ALPHA,
    created.jobId,
    10,
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.retryable, true);
  assert.ok(blocked.blockedReasons.includes("legal_hold"));
  assert.ok(await setup.data.get(TENANT_ALPHA, "message_1"));
  assert.equal(
    (await setup.identities.get(TENANT_ALPHA, SUBJECT))?.status,
    "active",
  );

  setup.holds.release("hold_1", NOW);
  const completed = await runToTerminal(setup, blocked);
  assert.equal(completed.status, "completed");
  assert.equal(await setup.data.get(TENANT_ALPHA, "message_1"), undefined);
  assert.equal(
    (await setup.identities.get(TENANT_ALPHA, SUBJECT))?.status,
    "tombstoned",
  );
});

test("retryable storage failure is partial, audited, and resumes without double disposition", async () => {
  const setup = harness({
    records: [record("message_1", "messages"), record("profile_1", "profile")],
  });
  setup.data.failNext(TENANT_ALPHA, "message_1", {
    outcome: "failed",
    retryable: true,
    safeMessage: "temporary storage outage",
  });
  const created = await setup.service.createJob(context(), {
    kind: "delete",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "retry-delete",
    policyRef: { policyId: "delete-policy", version: "delete-v1" },
    confirmationGrantId: "confirm-delete-student-1",
  });
  const partial = await setup.service.resumeJob(
    context(),
    TENANT_ALPHA,
    created.jobId,
    10,
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.dispositionCounts.deleted, 1);
  assert.equal(partial.failures[0]?.attempt, 1);
  const completed = await runToTerminal(setup, partial);
  assert.equal(completed.status, "completed");
  assert.equal(
    completed.result?.kind === "delete" ? completed.result.deleted : -1,
    2,
  );
  assert.deepEqual(
    (await setup.jobs.list(TENANT_ALPHA))
      .filter((entry) => entry.jobId === created.jobId)
      .map((entry) => entry.action),
    ["job_created", "job_partial", "job_completed"],
  );
});

test("retention uses only explicit policy durations and exact cutoff boundaries", async () => {
  const setup = harness({
    records: [
      record("message_old", "messages", {
        createdAt: "2026-06-23T12:00:00.000Z",
      }),
      record("message_new", "messages", {
        createdAt: "2026-06-23T12:00:01.000Z",
      }),
      record("event_old", "events", {
        createdAt: "2026-05-24T12:00:00.000Z",
      }),
      record("event_new", "events", {
        createdAt: "2026-05-24T12:00:01.000Z",
      }),
    ],
  });
  const created = await setup.service.createJob(context(), {
    kind: "retention",
    tenantId: TENANT_ALPHA,
    idempotencyKey: "retention-explicit",
    policyRef: { policyId: "retention-policy", version: "retention-v1" },
    dataThrough: NOW,
  });
  assert.deepEqual(created.targetRecordIds, ["event_old", "message_old"]);
  const completed = await runToTerminal(setup, created);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, {
    kind: "retention",
    policyId: "retention-policy",
    policyVersion: "retention-v1",
    dataThrough: NOW,
    deleted: 1,
    deidentified: 1,
    retainedMinimal: 0,
  });
  assert.equal(await setup.data.get(TENANT_ALPHA, "message_old"), undefined);
  assert.ok(await setup.data.get(TENANT_ALPHA, "message_new"));
  assert.deepEqual(
    (await setup.data.get(TENANT_ALPHA, "event_old"))?.payload,
    { deidentified: true },
  );
  assert.ok(await setup.data.get(TENANT_ALPHA, "event_new"));
});

test("missing or invalid policy produces a blocked job and no guessed retention behavior", async () => {
  const missing = harness({ retentionPolicies: [] });
  const missingJob = await missing.service.createJob(context(), {
    kind: "retention",
    tenantId: TENANT_ALPHA,
    idempotencyKey: "missing-retention",
    policyRef: { policyId: "not-found", version: "v1" },
    dataThrough: NOW,
  });
  assert.equal(missingJob.status, "blocked");
  assert.ok(missingJob.blockedReasons.includes("policy_not_found"));
  assert.equal(missingJob.targetRecordIds.length, 0);

  const invalidPolicy = retentionPolicy(TENANT_ALPHA, {
    version: "invalid",
    rules: [
      { dataClass: "messages", retentionDays: -1, disposition: "delete" },
    ],
  });
  const invalid = harness({ retentionPolicies: [invalidPolicy] });
  const invalidJob = await invalid.service.createJob(context(), {
    kind: "retention",
    tenantId: TENANT_ALPHA,
    idempotencyKey: "invalid-retention",
    policyRef: { policyId: "retention-policy", version: "invalid" },
    dataThrough: NOW,
  });
  assert.equal(invalidJob.status, "blocked");
  assert.ok(invalidJob.blockedReasons.includes("policy_invalid"));
  assert.ok(await invalid.data.get(TENANT_ALPHA, "message_1"));
});

test("deletion policy cannot retain raw personal content or omit an applicable class", async () => {
  const unsafe = deletionPolicy(TENANT_ALPHA, {
    version: "unsafe",
    dispositions: { messages: "retain_minimal" },
  });
  assert.ok(
    validateDeletionPolicy(unsafe, TENANT_ALPHA).includes(
      "personal_content_must_delete:messages",
    ),
  );

  const incomplete = deletionPolicy(TENANT_ALPHA, {
    version: "incomplete",
    dispositions: { messages: "delete" },
  });
  const setup = harness({
    records: [record("message_1", "messages"), record("vector_1", "vectors")],
    deletionPolicies: [incomplete],
  });
  const job = await setup.service.createJob(context(), {
    kind: "delete",
    tenantId: TENANT_ALPHA,
    subjectId: SUBJECT,
    idempotencyKey: "incomplete-delete",
    policyRef: { policyId: "delete-policy", version: "incomplete" },
    confirmationGrantId: "confirm-delete-student-1",
  });
  assert.equal(job.status, "blocked");
  assert.ok(job.blockedReasons.includes("policy_missing_data_class_rule"));
  assert.ok(await setup.data.get(TENANT_ALPHA, "message_1"));
  assert.ok(await setup.data.get(TENANT_ALPHA, "vector_1"));
});

test("retention legal hold yields partial, never false completion, until release", async () => {
  const setup = harness({
    records: [
      record("held_message", "messages", {
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      record("free_message", "messages", {
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
    legalHolds: [
      {
        holdId: "hold_message",
        tenantId: TENANT_ALPHA,
        status: "active",
        reason: "Preserve selected record",
        startsAt: "2026-01-01T00:00:00.000Z",
        recordIds: ["held_message"],
      },
    ],
  });
  const created = await setup.service.createJob(context(), {
    kind: "retention",
    tenantId: TENANT_ALPHA,
    idempotencyKey: "held-retention",
    policyRef: { policyId: "retention-policy", version: "retention-v1" },
    dataThrough: NOW,
  });
  const partial = await setup.service.resumeJob(
    context(),
    TENANT_ALPHA,
    created.jobId,
    10,
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.result, undefined);
  assert.ok(partial.blockedReasons.includes("legal_hold"));
  assert.ok(await setup.data.get(TENANT_ALPHA, "held_message"));
  assert.equal(await setup.data.get(TENANT_ALPHA, "free_message"), undefined);
  setup.holds.release("hold_message", NOW);
  const completed = await runToTerminal(setup, partial);
  assert.equal(completed.status, "completed");
  assert.equal(await setup.data.get(TENANT_ALPHA, "held_message"), undefined);
});

test("policy validators preserve O-13 as explicit input rather than silently defaulting duration", () => {
  const noRules = retentionPolicy(TENANT_ALPHA, { rules: [] });
  assert.ok(
    validateRetentionPolicy(noRules, TENANT_ALPHA, NOW).includes(
      "retention_rules_missing",
    ),
  );
  const zeroDayExplicit = retentionPolicy(TENANT_ALPHA, {
    rules: [
      { dataClass: "messages", retentionDays: 0, disposition: "delete" },
    ],
  });
  assert.deepEqual(
    validateRetentionPolicy(zeroDayExplicit, TENANT_ALPHA, NOW),
    [],
  );
});

test("a guessed foreign record ID cannot be mutated through a tenant-scoped retention plan", async () => {
  const setup = harness({
    records: [
      record("same_id", "messages", {
        tenantId: TENANT_ALPHA,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      record("same_id", "messages", {
        tenantId: TENANT_BETA,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
  });
  const completed = await runToTerminal(
    setup,
    await setup.service.createJob(context(), {
      kind: "retention",
      tenantId: TENANT_ALPHA,
      idempotencyKey: "isolation-retention",
      policyRef: { policyId: "retention-policy", version: "retention-v1" },
      dataThrough: NOW,
    }),
  );
  assert.equal(completed.status, "completed");
  assert.equal(await setup.data.get(TENANT_ALPHA, "same_id"), undefined);
  assert.ok(await setup.data.get(TENANT_BETA, "same_id"));
});
