import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicIntelligenceRuntime,
  EventIngestionService,
  InMemoryEventQuarantineRepository,
  InMemoryEventRepository,
  InMemoryEvidenceRepository,
  InMemoryOpportunityRepository,
  IntelligenceError,
  OpportunityEvaluationService,
  OpportunityReviewService,
  buildDataHealthSnapshot,
  computeConfusion,
  computeContentGap,
  computeModuleVelocity,
  computeStall,
  validateEvent,
} from "../src/index.js";
import type {
  AnyDomainEvent,
  DataHealthSnapshot,
  EvidenceRepository,
  OpportunityCandidate,
  OpportunityEligibility,
  OpportunityEvidenceRecord,
  SourceCoverage,
} from "../src/index.js";

const NOW = "2026-07-23T12:00:00.000Z";

function source(
  name: SourceCoverage["source"],
  state: SourceCoverage["state"] = "complete",
): SourceCoverage {
  return {
    source: name,
    state,
    dataThrough: NOW,
    observedRecords: state === "missing" ? 0 : 10,
  };
}

function health(
  sources: readonly SourceCoverage[],
  tenantId = "tenant_alpha",
): DataHealthSnapshot {
  return buildDataHealthSnapshot({
    tenantId,
    computedAt: NOW,
    sources,
    identifiedSubjects: 8,
    observedSubjects: 10,
  });
}

function event(
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    eventId: "event_1",
    schemaVersion: 1,
    type: "message_sent",
    tenantId: "tenant_alpha",
    subjectUserId: "student_1",
    actorType: "student",
    conversationId: "conversation_1",
    sessionId: "session_1",
    occurredAt: "2026-07-23T11:59:00.000Z",
    ingestedAt: NOW,
    source: "edge_api",
    identityTier: "verified",
    consent: { analytics: true },
    payload: {
      messageId: "message_1",
      modality: "text",
      attachmentCount: 0,
    },
    idempotencyKey: "source_delivery_1",
    traceId: "trace_1",
    ...overrides,
  };
}

test("INT-01: the event taxonomy rejects unknown types, versions, and discriminated payload violations", () => {
  assert.equal(validateEvent(event()).valid, true);

  const unknown = validateEvent(event({ type: "widget_magic" }));
  assert.deepEqual(
    unknown.valid ? undefined : unknown.reasonCode,
    "unknown_event_type",
  );

  const future = validateEvent(event({ schemaVersion: 2 }));
  assert.deepEqual(
    future.valid ? undefined : future.reasonCode,
    "unsupported_schema_version",
  );

  const mismatchedPayload = validateEvent(
    event({
      type: "widget_resized",
      payload: { width: 100, height: "large" },
    }),
  );
  assert.deepEqual(
    mismatchedPayload.valid ? undefined : mismatchedPayload.reasonCode,
    "invalid_payload",
  );

  const extraPayloadField = validateEvent(
    event({
      payload: {
        messageId: "message_1",
        modality: "text",
        attachmentCount: 0,
        silentlyAccepted: true,
      },
    }),
  );
  assert.deepEqual(
    extraPayloadField.valid ? undefined : extraPayloadField.reasonCode,
    "invalid_payload",
  );
});

test("INT-01: non-cloneable hostile input is still quarantined without stopping the batch", async () => {
  const events = new InMemoryEventRepository();
  const quarantine = new InMemoryEventQuarantineRepository();
  const runtime = new DeterministicIntelligenceRuntime(NOW);
  const service = new EventIngestionService(events, quarantine, runtime, runtime);
  const hostile = event({
    payload: {
      messageId: "message_1",
      modality: "text",
      attachmentCount: 0,
      callback: () => "not cloneable",
    },
  });
  const result = await service.ingest([hostile, event()]);
  assert.equal(result.quarantined.length, 1);
  assert.deepEqual(result.acceptedEventIds, ["event_1"]);
});

test("INT-01: append is idempotent across event and delivery keys, but conflicting reuse is quarantined", async () => {
  const events = new InMemoryEventRepository();
  const quarantine = new InMemoryEventQuarantineRepository();
  const runtime = new DeterministicIntelligenceRuntime(NOW);
  const service = new EventIngestionService(events, quarantine, runtime, runtime);
  const original = event();
  const replay = event({
    eventId: "event_retry",
    ingestedAt: "2026-07-23T12:01:00.000Z",
    traceId: "trace_retry",
  });
  const conflict = event({
    eventId: "event_conflict",
    payload: {
      messageId: "message_different",
      modality: "text",
      attachmentCount: 0,
    },
  });
  const malformed = event({ type: "not_real" });

  const result = await service.ingest([original, original, replay, conflict, malformed]);
  assert.deepEqual(result.acceptedEventIds, ["event_1"]);
  assert.deepEqual(result.duplicateEventIds, ["event_1", "event_retry"]);
  assert.deepEqual(
    result.quarantined.map((record) => record.reasonCode),
    ["idempotency_conflict", "unknown_event_type"],
  );
  assert.equal((await events.list("tenant_alpha")).length, 1);
  assert.equal((await quarantine.list("tenant_alpha")).length, 2);

  const sameIdentifiersOtherTenant = event({
    tenantId: "tenant_beta",
    subjectUserId: "student_beta",
  });
  const isolated = await service.ingest([sameIdentifiersOtherTenant]);
  assert.deepEqual(isolated.acceptedEventIds, ["event_1"]);
  assert.equal((await events.list("tenant_beta")).length, 1);
});

test("data health exposes source degradation, earliest data-through, and identity coverage", () => {
  const snapshot = buildDataHealthSnapshot({
    tenantId: "tenant_alpha",
    computedAt: NOW,
    sources: [
      { ...source("events"), dataThrough: "2026-07-23T11:00:00.000Z" },
      { ...source("progress", "degraded"), reason: "webhook delayed" },
      source("identity", "partial"),
    ],
    identifiedSubjects: 3,
    observedSubjects: 5,
  });
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.dataThrough, "2026-07-23T11:00:00.000Z");
  assert.deepEqual(snapshot.identityCoverage, {
    state: "partial",
    identifiedSubjects: 3,
    observedSubjects: 5,
    ratio: 0.6,
  });
  assert.ok(snapshot.limitations.includes("degraded_source:progress"));
  assert.ok(snapshot.limitations.includes("partial_source:identity"));
});

test("INT-02: confusion is questions attributed divided by distinct active students", () => {
  const result = computeConfusion({
    tenantId: "tenant_alpha",
    lessonId: "lesson_1",
    windowStart: "2026-07-16T12:00:00.000Z",
    windowEnd: NOW,
    attributedQuestionEventIds: ["q1", "q2", "q3", "q4", "q5", "q6", "q6"],
    activeStudentIds: ["a", "b", "c", "c"],
    health: health([source("events"), source("identity")]),
  });
  assert.equal(result.state, "known");
  assert.equal(result.state === "known" ? result.value.questionsAttributed : -1, 6);
  assert.equal(result.state === "known" ? result.value.activeStudents : -1, 3);
  assert.equal(
    result.state === "known" ? result.value.questionsPerActiveStudent : -1,
    2,
  );
});

test("INT-02: content gap uses the trailing 30 days and strict average confidence < 0.55", () => {
  const completeHealth = health([source("messages"), source("retrieval")]);
  const observations = [
    {
      id: "q_old",
      tenantId: "tenant_alpha",
      clusterId: "cluster_1",
      occurredAt: "2026-06-22T11:59:59.000Z",
      retrievalConfidence: 0,
    },
    {
      id: "q_1",
      tenantId: "tenant_alpha",
      clusterId: "cluster_1",
      occurredAt: "2026-06-23T12:00:00.000Z",
      retrievalConfidence: 0.5,
    },
    {
      id: "q_2",
      tenantId: "tenant_alpha",
      clusterId: "cluster_1",
      occurredAt: NOW,
      retrievalConfidence: 0.6,
    },
  ] as const;
  const boundary = computeContentGap({
    tenantId: "tenant_alpha",
    clusterId: "cluster_1",
    asOf: NOW,
    questions: observations,
    health: completeHealth,
  });
  assert.equal(boundary.state, "known");
  assert.equal(boundary.state === "known" ? boundary.value.questionCount : -1, 2);
  assert.equal(
    boundary.state === "known"
      ? boundary.value.averageRetrievalConfidence
      : undefined,
    0.55,
  );
  assert.equal(
    boundary.state === "known" ? boundary.value.isContentGap : undefined,
    false,
  );

  const gap = computeContentGap({
    tenantId: "tenant_alpha",
    clusterId: "cluster_1",
    asOf: NOW,
    questions: observations.map((item, index) =>
      index === 2 ? { ...item, retrievalConfidence: 0.58 } : item,
    ),
    health: completeHealth,
  });
  assert.equal(gap.state, "known");
  assert.equal(gap.state === "known" ? gap.value.isContentGap : undefined, true);
});

test("INT-02: stall boundaries require three active days, fourteen inactive days, and <80% completion", () => {
  const completeHealth = health([source("events"), source("progress")]);
  const activity = ["2026-04-01", "2026-04-05", "2026-04-10"].map(
    (day, index) => ({
      id: `activity_${index}`,
      tenantId: "tenant_alpha",
      subjectUserId: "student_1",
      occurredAt: `${day}T12:00:00.000Z`,
    }),
  );
  const stalled = computeStall({
    tenantId: "tenant_alpha",
    subjectUserId: "student_1",
    asOf: "2026-04-24T12:00:00.000Z",
    completionRatio: 0.79,
    activity,
    health: completeHealth,
  });
  assert.equal(stalled.state, "known");
  assert.equal(stalled.state === "known" ? stalled.value.stalled : false, true);
  assert.equal(
    stalled.state === "known"
      ? stalled.value.activeDaysInFourteenDayWindow
      : -1,
    3,
  );
  assert.equal(stalled.state === "known" ? stalled.value.inactiveDays : -1, 14);

  const atEighty = computeStall({
    tenantId: "tenant_alpha",
    subjectUserId: "student_1",
    asOf: "2026-04-24T12:00:00.000Z",
    completionRatio: 0.8,
    activity,
    health: completeHealth,
  });
  assert.equal(atEighty.state === "known" ? atEighty.value.stalled : true, false);
});

test("INT-02: velocity compares lessons/week with a same-tenant cohort median", () => {
  const completion = (
    subjectUserId: string,
    count: number,
  ): Array<{
    id: string;
    tenantId: string;
    subjectUserId: string;
    lessonId: string;
    completedAt: string;
  }> =>
    Array.from({ length: count }, (_, index) => ({
      id: `${subjectUserId}_${index}`,
      tenantId: "tenant_alpha",
      subjectUserId,
      lessonId: `lesson_${index}`,
      completedAt: `2026-07-${String(index + 2).padStart(2, "0")}T12:00:00.000Z`,
    }));
  const result = computeModuleVelocity({
    tenantId: "tenant_alpha",
    subjectUserId: "student_1",
    cohortSubjectUserIds: ["student_2", "student_3"],
    windowStart: "2026-07-01T12:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
    completions: [
      ...completion("student_1", 5),
      ...completion("student_2", 2),
      ...completion("student_3", 6),
    ],
    health: health([source("progress"), source("identity")]),
  });
  assert.equal(result.state, "known");
  assert.deepEqual(
    result.state === "known"
      ? {
          lessonsPerWeek: result.value.lessonsPerWeek,
          median: result.value.sameTenantCohortMedian,
          difference: result.value.differenceFromMedian,
          comparison: result.value.comparison,
        }
      : undefined,
    {
      lessonsPerWeek: 2.5,
      median: 2,
      difference: 0.5,
      comparison: "faster",
    },
  );
});

test("INT-02: repeated completion delivery for one lesson is not double-counted", () => {
  const result = computeModuleVelocity({
    tenantId: "tenant_alpha",
    subjectUserId: "student_1",
    cohortSubjectUserIds: ["student_2"],
    windowStart: "2026-07-01T12:00:00.000Z",
    windowEnd: "2026-07-08T12:00:00.000Z",
    completions: [
      {
        id: "completion_1",
        tenantId: "tenant_alpha",
        subjectUserId: "student_1",
        lessonId: "lesson_1",
        completedAt: "2026-07-02T12:00:00.000Z",
      },
      {
        id: "completion_retry",
        tenantId: "tenant_alpha",
        subjectUserId: "student_1",
        lessonId: "lesson_1",
        completedAt: "2026-07-02T12:01:00.000Z",
      },
    ],
    health: health([source("progress"), source("identity")]),
  });
  assert.equal(result.state, "known");
  assert.equal(result.state === "known" ? result.value.lessonsPerWeek : -1, 1);
});

test("INT-03: degraded and incomplete sources never masquerade as a known zero", () => {
  const degraded = computeConfusion({
    tenantId: "tenant_alpha",
    lessonId: "lesson_1",
    windowStart: "2026-07-16T12:00:00.000Z",
    windowEnd: NOW,
    attributedQuestionEventIds: [],
    activeStudentIds: ["student_1"],
    health: health([source("events", "degraded"), source("identity")]),
  });
  assert.equal(degraded.state, "partial");
  assert.equal(degraded.state === "partial" ? degraded.value.questionsAttributed : -1, 0);
  assert.ok(
    degraded.state === "partial" &&
      degraded.limitations.includes("degraded_source:events"),
  );

  const missing = computeConfusion({
    tenantId: "tenant_alpha",
    lessonId: "lesson_1",
    windowStart: "2026-07-16T12:00:00.000Z",
    windowEnd: NOW,
    attributedQuestionEventIds: [],
    activeStudentIds: ["student_1"],
    health: health([source("events", "missing"), source("identity")]),
  });
  assert.equal(missing.state, "unknown");
  assert.equal("value" in missing, false);

  const missingConfidence = computeContentGap({
    tenantId: "tenant_alpha",
    clusterId: "cluster_1",
    asOf: NOW,
    questions: [
      {
        id: "q_1",
        tenantId: "tenant_alpha",
        clusterId: "cluster_1",
        occurredAt: NOW,
      },
    ],
    health: health([source("messages"), source("retrieval")]),
  });
  assert.equal(missingConfidence.state, "partial");
  assert.equal(
    missingConfidence.state === "partial"
      ? missingConfidence.value.isContentGap
      : "present",
    undefined,
  );
});

function evidence(
  tenantId = "tenant_alpha",
  refId = "message_1",
): OpportunityEvidenceRecord {
  return {
    tenantId,
    kind: "message",
    refId,
    fact: "Student asked how to apply the lesson.",
    excerpt: "How do I apply this?",
    capturedAt: "2026-07-22T12:00:00.000Z",
  };
}

function candidate(
  overrides: Partial<OpportunityCandidate> = {},
): OpportunityCandidate {
  return {
    id: "opportunity_1",
    tenantId: "tenant_alpha",
    endUserId: "student_1",
    kind: "support_needed",
    label: "watch",
    confidence: 0.82,
    computedAt: "2026-07-23T11:00:00.000Z",
    evidenceThrough: "2026-07-23T10:00:00.000Z",
    expiresAt: "2026-07-30T11:00:00.000Z",
    policyVersion: "owner-policy-v1",
    identityTier: "verified",
    evidenceRefs: [{ kind: "message", refId: "message_1" }],
    limitations: ["classifier_not_used"],
    ...overrides,
  };
}

const ELIGIBLE: OpportunityEligibility = {
  analyticsConsent: "granted",
  freshness: "fresh",
  coverage: "sufficient",
  tenantHealth: "healthy",
};

test("OPP-01: surfaced opportunities retain tenant evidence, policy, confidence, freshness, expiry, and identity tier", async () => {
  const repository = new InMemoryOpportunityRepository();
  const service = new OpportunityEvaluationService(
    new InMemoryEvidenceRepository([evidence()]),
    repository,
  );
  const result = await service.evaluate(
    candidate({ identityTier: "self_reported" }),
    ELIGIBLE,
  );
  assert.equal(result.outcome, "surfaced");
  if (result.outcome !== "surfaced") return;
  assert.equal(result.opportunity.evidence[0]?.tenantId, "tenant_alpha");
  assert.equal(result.opportunity.policyVersion, "owner-policy-v1");
  assert.equal(result.opportunity.confidence, 0.82);
  assert.equal(result.opportunity.evidenceThrough, "2026-07-23T10:00:00.000Z");
  assert.equal(result.opportunity.expiresAt, "2026-07-30T11:00:00.000Z");
  assert.equal(result.opportunity.identityTier, "self_reported");
  assert.ok(result.opportunity.limitations.includes("identity_tier:self_reported"));
  assert.equal(result.opportunity.reviewMode, "human_only");
});

test("OPP-01: missing, future, and cross-tenant evidence can never surface", async () => {
  class AdversarialEvidenceRepository implements EvidenceRepository {
    async get(): Promise<OpportunityEvidenceRecord> {
      return evidence("tenant_beta");
    }
  }
  const crossTenant = await new OpportunityEvaluationService(
    new AdversarialEvidenceRepository(),
    new InMemoryOpportunityRepository(),
  ).evaluate(candidate(), ELIGIBLE);
  assert.deepEqual(
    crossTenant.outcome === "suppressed" ? crossTenant.reasons : [],
    ["cross_tenant_evidence"],
  );

  const missing = await new OpportunityEvaluationService(
    new InMemoryEvidenceRepository(),
    new InMemoryOpportunityRepository(),
  ).evaluate(candidate(), ELIGIBLE);
  assert.deepEqual(
    missing.outcome === "suppressed" ? missing.reasons : [],
    ["missing_evidence"],
  );

  const futureEvidence = evidence();
  const future = await new OpportunityEvaluationService(
    new InMemoryEvidenceRepository([
      { ...futureEvidence, capturedAt: "2026-07-23T10:30:00.000Z" },
    ]),
    new InMemoryOpportunityRepository(),
  ).evaluate(candidate(), ELIGIBLE);
  assert.deepEqual(
    future.outcome === "suppressed" ? future.reasons : [],
    ["invalid_candidate"],
  );
});

test("OPP-02: anonymous, revoked, stale, insufficient, and degraded cases suppress before evidence reads", async () => {
  class CountingEvidenceRepository implements EvidenceRepository {
    reads = 0;
    async get(): Promise<OpportunityEvidenceRecord | undefined> {
      this.reads += 1;
      return evidence();
    }
  }
  const fixtures: Array<{
    candidate: OpportunityCandidate;
    eligibility: OpportunityEligibility;
    reason: string;
  }> = [
    {
      candidate: candidate({ identityTier: "anonymous" }),
      eligibility: ELIGIBLE,
      reason: "anonymous_identity",
    },
    {
      candidate: candidate(),
      eligibility: { ...ELIGIBLE, analyticsConsent: "revoked" },
      reason: "analytics_consent_revoked",
    },
    {
      candidate: candidate(),
      eligibility: { ...ELIGIBLE, freshness: "stale" },
      reason: "stale_evidence",
    },
    {
      candidate: candidate(),
      eligibility: { ...ELIGIBLE, coverage: "insufficient" },
      reason: "insufficient_coverage",
    },
    {
      candidate: candidate(),
      eligibility: { ...ELIGIBLE, tenantHealth: "degraded" },
      reason: "tenant_degraded",
    },
  ];
  for (const fixture of fixtures) {
    const evidenceRepository = new CountingEvidenceRepository();
    const service = new OpportunityEvaluationService(
      evidenceRepository,
      new InMemoryOpportunityRepository(),
    );
    const result = await service.evaluate(fixture.candidate, fixture.eligibility);
    assert.equal(result.outcome, "suppressed");
    assert.ok(
      result.outcome === "suppressed" && result.reasons.includes(fixture.reason as never),
    );
    assert.equal(evidenceRepository.reads, 0);
  }
});

test("O-09 boundary: expiry and policy are required inputs; the core invents neither", async () => {
  const service = new OpportunityEvaluationService(
    new InMemoryEvidenceRepository([evidence()]),
    new InMemoryOpportunityRepository(),
  );
  const invalid = await service.evaluate(
    candidate({
      policyVersion: "",
      expiresAt: "2026-07-23T11:00:00.000Z",
    }),
    ELIGIBLE,
  );
  assert.deepEqual(
    invalid.outcome === "suppressed" ? invalid.reasons : [],
    ["invalid_candidate"],
  );
});

test("OPP-03: lifecycle and false-positive feedback are human-only, tenant-scoped, and atomically audited", async () => {
  const repository = new InMemoryOpportunityRepository();
  const evaluation = new OpportunityEvaluationService(
    new InMemoryEvidenceRepository([evidence()]),
    repository,
  );
  await evaluation.evaluate(candidate(), ELIGIBLE);
  const runtime = new DeterministicIntelligenceRuntime(NOW);
  const review = new OpportunityReviewService(repository, runtime, runtime);
  const actor = { actorId: "creator_1", role: "creator" as const };

  const seen = await review.changeStatus(actor, {
    tenantId: "tenant_alpha",
    opportunityId: "opportunity_1",
    expectedStatus: "new",
    nextStatus: "seen",
    reason: "Reviewed evidence in Creator console.",
  });
  assert.equal(seen.status, "seen");
  const feedback = await review.recordFeedback(actor, {
    tenantId: "tenant_alpha",
    opportunityId: "opportunity_1",
    kind: "dismissed_false_positive",
    note: "Question was already resolved.",
  });
  assert.equal(feedback.kind, "dismissed_false_positive");
  const unchanged = await repository.get("tenant_alpha", "opportunity_1");
  assert.equal(unchanged?.confidence, 0.82);
  assert.equal(unchanged?.status, "seen");

  const audit = await repository.listAudit("tenant_alpha", "opportunity_1");
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ["status_changed", "feedback_recorded"],
  );
  assert.ok(audit.every((entry) => entry.actor.actorId === "creator_1"));
  assert.equal((await repository.listFeedback("tenant_alpha", "opportunity_1")).length, 1);
  assert.equal((await repository.listFeedback("tenant_beta", "opportunity_1")).length, 0);

  await assert.rejects(
    review.changeStatus(actor, {
      tenantId: "tenant_beta",
      opportunityId: "opportunity_1",
      expectedStatus: "seen",
      nextStatus: "actioned",
    }),
    (error: unknown) =>
      error instanceof IntelligenceError && error.code === "opportunity.not_found",
  );
  await assert.rejects(
    review.changeStatus(actor, {
      tenantId: "tenant_alpha",
      opportunityId: "opportunity_1",
      expectedStatus: "seen",
      nextStatus: "new",
    }),
    (error: unknown) =>
      error instanceof IntelligenceError &&
      error.code === "opportunity.invalid_transition",
  );
  await assert.rejects(
    review.recordFeedback(
      { actorId: "student_1", role: "student" as never },
      {
        tenantId: "tenant_alpha",
        opportunityId: "opportunity_1",
        kind: "helpful",
      },
    ),
    (error: unknown) =>
      error instanceof IntelligenceError && error.code === "opportunity.invalid_input",
  );
});

test("same-tenant enforcement rejects foreign metric observations rather than blending cohorts", () => {
  const result = computeModuleVelocity({
    tenantId: "tenant_alpha",
    subjectUserId: "student_1",
    cohortSubjectUserIds: ["student_2"],
    windowStart: "2026-07-01T12:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
    completions: [
      {
        id: "foreign_completion",
        tenantId: "tenant_beta",
        subjectUserId: "student_2",
        lessonId: "lesson_1",
        completedAt: "2026-07-02T12:00:00.000Z",
      },
    ],
    health: health([source("progress"), source("identity")]),
  });
  assert.equal(result.state, "unknown");
  assert.ok(result.limitations.includes("cross_tenant_input"));
});

test("a typed event round-trips through the in-memory repository without mutation", async () => {
  const parsed = validateEvent(event());
  assert.equal(parsed.valid, true);
  if (!parsed.valid) return;
  const repository = new InMemoryEventRepository();
  const quarantine = new InMemoryEventQuarantineRepository();
  const runtime = new DeterministicIntelligenceRuntime(NOW);
  await new EventIngestionService(repository, quarantine, runtime, runtime).ingest([
    parsed.event,
  ]);
  const stored = await repository.list("tenant_alpha");
  assert.deepEqual(stored[0] as AnyDomainEvent, parsed.event);
});
