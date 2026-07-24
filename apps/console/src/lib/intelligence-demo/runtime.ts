import {
  DeterministicIntelligenceRuntime,
  InMemoryEvidenceRepository,
  InMemoryOpportunityRepository,
  OpportunityEvaluationService,
  OpportunityReviewService,
  buildDataHealthSnapshot,
  computeConfusion,
  computeContentGap,
  computeModuleVelocity,
  computeStall,
  type OpportunityCandidate,
  type OpportunityEligibility,
  type OpportunityEvaluation,
} from "@course-ai/intelligence-core";

import type {
  IntelligenceDemoSnapshot,
  IntelligenceMetricSnapshot,
  SuppressionPreview,
} from "./types";

const GENERATED_AT = "2026-07-23T20:00:00.000Z";
const DATA_THROUGH = "2026-07-23T19:45:00.000Z";
const LEARNER_ID = "student_maya";
const OPPORTUNITY_ID = "opportunity_minimum_day_support";
const DEVELOPMENT_POLICY_VERSION = "development-fixture-o09-unapproved-v1";

interface TenantIntelligenceRuntime {
  readonly tenantId: string;
  readonly clock: DeterministicIntelligenceRuntime;
  readonly repository: InMemoryOpportunityRepository;
  readonly review: OpportunityReviewService;
  readonly health: ReturnType<typeof buildDataHealthSnapshot>;
  readonly metrics: IntelligenceMetricSnapshot;
  readonly suppressed: readonly SuppressionPreview[];
  readonly mutationReceipts: Map<
    string,
    {
      readonly fingerprint: string;
      readonly snapshot: IntelligenceDemoSnapshot;
    }
  >;
  readonly mutationsInFlight: Map<
    string,
    {
      readonly fingerprint: string;
      readonly promise: Promise<IntelligenceDemoSnapshot>;
    }
  >;
}

export class IntelligenceDemoIdempotencyError extends Error {
  readonly code = "intelligence.idempotency_conflict";

  constructor() {
    super("The idempotency key was already used for a different intelligence action.");
    this.name = "IntelligenceDemoIdempotencyError";
  }
}

function mutationFingerprint(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function candidate(
  tenantId: string,
  candidateId: string,
  identityTier: OpportunityCandidate["identityTier"] = "verified",
): OpportunityCandidate {
  return {
    id: candidateId,
    tenantId,
    endUserId: LEARNER_ID,
    kind: "support_needed",
    label: "unknown",
    confidence: 0.82,
    computedAt: GENERATED_AT,
    evidenceThrough: "2026-07-23T19:40:00.000Z",
    // Required by the core contract and intentionally identified as an
    // unapproved development fixture. Production expiry remains blocked by O-09.
    expiresAt: "2026-08-06T20:00:00.000Z",
    policyVersion: DEVELOPMENT_POLICY_VERSION,
    identityTier,
    evidenceRefs: [
      { kind: "message", refId: "message_restart_question" },
      { kind: "metric", refId: "metric_confusion_minimum_day" },
      { kind: "event", refId: "event_progress_minimum_day" },
    ],
    limitations: [
      "Development fixture only: O-09 scoring, expiry, and offer matching are not approved.",
      "Progress coverage is partial, so this is human review guidance only.",
    ],
  };
}

function suppressionLabel(
  candidateId: string,
): string {
  const labels: Readonly<Record<string, string>> = {
    suppression_anonymous: "Anonymous learner",
    suppression_revoked: "Analytics consent revoked",
    suppression_stale: "Evidence is stale",
    suppression_insufficient: "Coverage is insufficient",
    suppression_degraded: "Tenant source is degraded",
  };
  return labels[candidateId] ?? candidateId;
}

function suppressionPreview(
  evaluation: OpportunityEvaluation,
): SuppressionPreview {
  if (evaluation.outcome !== "suppressed") {
    throw new Error("Development suppression fixture unexpectedly surfaced.");
  }
  return {
    candidateId: evaluation.candidateId,
    label: suppressionLabel(evaluation.candidateId),
    reasons: evaluation.reasons,
  };
}

async function createRuntime(
  tenantId: string,
): Promise<TenantIntelligenceRuntime> {
  const health = buildDataHealthSnapshot({
    tenantId,
    computedAt: GENERATED_AT,
    sources: [
      {
        source: "events",
        state: "complete",
        dataThrough: GENERATED_AT,
        observedRecords: 34,
        expectedRecords: 34,
      },
      {
        source: "messages",
        state: "complete",
        dataThrough: "2026-07-23T19:58:00.000Z",
        observedRecords: 18,
        expectedRecords: 18,
      },
      {
        source: "retrieval",
        state: "partial",
        dataThrough: "2026-07-23T19:54:00.000Z",
        observedRecords: 16,
        expectedRecords: 18,
        reason: "Two question events have no retrieval-confidence observation.",
      },
      {
        source: "progress",
        state: "partial",
        dataThrough: DATA_THROUGH,
        observedRecords: 7,
        expectedRecords: 8,
        reason: "The latest host progress webhook has not arrived.",
      },
      {
        source: "identity",
        state: "complete",
        dataThrough: GENERATED_AT,
        observedRecords: 4,
        expectedRecords: 4,
      },
    ],
    identifiedSubjects: 3,
    observedSubjects: 4,
  });

  const metrics: IntelligenceMetricSnapshot = {
    confusion: computeConfusion({
      tenantId,
      lessonId: "lesson_minimum_day",
      windowStart: "2026-07-16T20:00:00.000Z",
      windowEnd: GENERATED_AT,
      attributedQuestionEventIds: [
        "question_1",
        "question_2",
        "question_3",
        "question_4",
        "question_5",
      ],
      activeStudentIds: [LEARNER_ID, "student_leo", "student_jae"],
      health,
    }),
    contentGap: computeContentGap({
      tenantId,
      clusterId: "cluster_restart_after_disruption",
      asOf: GENERATED_AT,
      questions: [
        {
          id: "question_cluster_1",
          tenantId,
          clusterId: "cluster_restart_after_disruption",
          occurredAt: "2026-07-18T17:20:00.000Z",
          retrievalConfidence: 0.42,
        },
        {
          id: "question_cluster_2",
          tenantId,
          clusterId: "cluster_restart_after_disruption",
          occurredAt: "2026-07-21T18:05:00.000Z",
          retrievalConfidence: 0.52,
        },
        {
          id: "question_cluster_3",
          tenantId,
          clusterId: "cluster_restart_after_disruption",
          occurredAt: "2026-07-23T19:30:00.000Z",
        },
      ],
      health,
    }),
    stall: computeStall({
      tenantId,
      subjectUserId: LEARNER_ID,
      asOf: GENERATED_AT,
      activity: [
        {
          id: "activity_1",
          tenantId,
          subjectUserId: LEARNER_ID,
          occurredAt: "2026-07-08T17:00:00.000Z",
        },
        {
          id: "activity_2",
          tenantId,
          subjectUserId: LEARNER_ID,
          occurredAt: "2026-07-10T17:00:00.000Z",
        },
        {
          id: "activity_3",
          tenantId,
          subjectUserId: LEARNER_ID,
          occurredAt: "2026-07-12T17:00:00.000Z",
        },
      ],
      // Completion is deliberately absent while the progress source is
      // incomplete. The core must return unknown rather than false.
      health,
    }),
    velocity: computeModuleVelocity({
      tenantId,
      subjectUserId: LEARNER_ID,
      cohortSubjectUserIds: ["student_leo", "student_jae"],
      windowStart: "2026-07-09T20:00:00.000Z",
      windowEnd: GENERATED_AT,
      completions: [
        ...["m1", "m2", "m3", "m4"].map((lessonId, index) => ({
          id: `maya_completion_${index + 1}`,
          tenantId,
          subjectUserId: LEARNER_ID,
          lessonId,
          completedAt: `2026-07-${String(10 + index).padStart(2, "0")}T18:00:00.000Z`,
        })),
        ...["l1", "l2"].map((lessonId, index) => ({
          id: `leo_completion_${index + 1}`,
          tenantId,
          subjectUserId: "student_leo",
          lessonId,
          completedAt: `2026-07-${String(11 + index).padStart(2, "0")}T18:00:00.000Z`,
        })),
        ...["j1", "j2", "j3", "j4"].map((lessonId, index) => ({
          id: `jae_completion_${index + 1}`,
          tenantId,
          subjectUserId: "student_jae",
          lessonId,
          completedAt: `2026-07-${String(12 + index).padStart(2, "0")}T18:00:00.000Z`,
        })),
      ],
      health,
    }),
  };

  const evidence = new InMemoryEvidenceRepository([
    {
      tenantId,
      kind: "message",
      refId: "message_restart_question",
      fact: "Maya asked for a concrete way to restart after a disrupted week.",
      excerpt: "What does a minimum day look like after I miss the rhythm?",
      capturedAt: "2026-07-23T19:30:00.000Z",
    },
    {
      tenantId,
      kind: "metric",
      refId: "metric_confusion_minimum_day",
      fact: "Minimum Day received 5 attributed questions across 3 active learners.",
      capturedAt: "2026-07-23T19:35:00.000Z",
    },
    {
      tenantId,
      kind: "event",
      refId: "event_progress_minimum_day",
      fact: "Verified progress places Maya on Minimum Day at 58% course completion.",
      capturedAt: "2026-07-23T19:40:00.000Z",
    },
  ]);
  const repository = new InMemoryOpportunityRepository();
  const evaluator = new OpportunityEvaluationService(evidence, repository);
  const baseEligibility: OpportunityEligibility = {
    analyticsConsent: "granted",
    freshness: "fresh",
    coverage: "sufficient",
    tenantHealth: health.state,
  };
  const surfaced = await evaluator.evaluate(
    candidate(tenantId, OPPORTUNITY_ID),
    baseEligibility,
  );
  if (surfaced.outcome !== "surfaced") {
    throw new Error("Development opportunity fixture failed eligibility.");
  }

  const suppressed = await Promise.all([
    evaluator.evaluate(
      candidate(tenantId, "suppression_anonymous", "anonymous"),
      baseEligibility,
    ),
    evaluator.evaluate(candidate(tenantId, "suppression_revoked"), {
      ...baseEligibility,
      analyticsConsent: "revoked",
    }),
    evaluator.evaluate(candidate(tenantId, "suppression_stale"), {
      ...baseEligibility,
      freshness: "stale",
    }),
    evaluator.evaluate(candidate(tenantId, "suppression_insufficient"), {
      ...baseEligibility,
      coverage: "insufficient",
    }),
    evaluator.evaluate(candidate(tenantId, "suppression_degraded"), {
      ...baseEligibility,
      tenantHealth: "degraded",
    }),
  ]);

  const clock = new DeterministicIntelligenceRuntime(GENERATED_AT);
  return {
    tenantId,
    clock,
    repository,
    review: new OpportunityReviewService(repository, clock, clock),
    health,
    metrics,
    suppressed: suppressed.map(suppressionPreview),
    mutationReceipts: new Map(),
    mutationsInFlight: new Map(),
  };
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __learningBotIntelligenceDemoRuntimes?: Map<
    string,
    Promise<TenantIntelligenceRuntime>
  >;
};

function runtimeForTenant(
  tenantId: string,
): Promise<TenantIntelligenceRuntime> {
  runtimeGlobal.__learningBotIntelligenceDemoRuntimes ??= new Map();
  const existing =
    runtimeGlobal.__learningBotIntelligenceDemoRuntimes.get(tenantId);
  if (existing !== undefined) return existing;
  const created = createRuntime(tenantId);
  runtimeGlobal.__learningBotIntelligenceDemoRuntimes.set(tenantId, created);
  return created;
}

export async function intelligenceSnapshot(
  tenantId: string,
): Promise<IntelligenceDemoSnapshot> {
  const runtime = await runtimeForTenant(tenantId);
  const opportunity = await runtime.repository.get(tenantId, OPPORTUNITY_ID);
  if (opportunity === undefined) {
    throw new Error("Tenant intelligence opportunity was not found.");
  }
  const [feedback, audit] = await Promise.all([
    runtime.repository.listFeedback(tenantId, OPPORTUNITY_ID),
    runtime.repository.listAudit(tenantId, OPPORTUNITY_ID),
  ]);
  return {
    generatedAt: runtime.clock.now(),
    tenantId,
    tenantName: "Northstar Academy",
    course: {
      title: "Momentum Method",
      module: "Build Your Rhythm",
      lesson: "Minimum Day",
    },
    learner: {
      id: LEARNER_ID,
      displayName: "Maya Chen",
      identityTier: "verified",
    },
    health: runtime.health,
    metrics: runtime.metrics,
    opportunity,
    suppressed: runtime.suppressed,
    feedback,
    audit,
    policyBoundary: {
      opportunityPolicyVersion: DEVELOPMENT_POLICY_VERSION,
      policyStatus: "development_fixture_only",
      scoreComputed: false,
      offerMatched: false,
      autonomousOutreach: false,
      unresolvedDecision: "O-09",
      note:
        "No score, component weights, production expiry, or offer matching are implemented. This fixture exercises evidence and human review only.",
    },
    productionGaps: [
      "Durable tenant-scoped event, evidence, opportunity, feedback, and audit repositories with RLS.",
      "Approved O-09 policy, calibration fixtures, thresholds, expiry, and offer matching.",
      "Connector health checkpoints and durable metric materialization.",
      "Role-specific privacy redaction for minimum-necessary excerpts.",
    ],
  };
}

export async function changeOpportunityStatus(input: {
  readonly tenantId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly opportunityId: string;
  readonly expectedStatus:
    | "new"
    | "seen"
    | "actioned"
    | "dismissed"
    | "converted"
    | "expired";
  readonly nextStatus:
    | "new"
    | "seen"
    | "actioned"
    | "dismissed"
    | "converted"
    | "expired";
  readonly reason?: string;
}): Promise<IntelligenceDemoSnapshot> {
  const runtime = await runtimeForTenant(input.tenantId);
  return executeIdempotentMutation(
    runtime,
    input.idempotencyKey,
    mutationFingerprint({
      action: "status",
      actorId: input.actorId,
      opportunityId: input.opportunityId,
      expectedStatus: input.expectedStatus,
      nextStatus: input.nextStatus,
      reason: input.reason,
    }),
    async () => {
      await runtime.review.changeStatus(
        { actorId: input.actorId, role: "creator" },
        {
          tenantId: input.tenantId,
          opportunityId: input.opportunityId,
          expectedStatus: input.expectedStatus,
          nextStatus: input.nextStatus,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      );
      return intelligenceSnapshot(input.tenantId);
    },
  );
}

export async function recordOpportunityFeedback(input: {
  readonly tenantId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly opportunityId: string;
  readonly kind: "dismissed_false_positive" | "wrong_offer" | "helpful";
  readonly note?: string;
}): Promise<IntelligenceDemoSnapshot> {
  const runtime = await runtimeForTenant(input.tenantId);
  return executeIdempotentMutation(
    runtime,
    input.idempotencyKey,
    mutationFingerprint({
      action: "feedback",
      actorId: input.actorId,
      opportunityId: input.opportunityId,
      kind: input.kind,
      note: input.note,
    }),
    async () => {
      await runtime.review.recordFeedback(
        { actorId: input.actorId, role: "creator" },
        {
          tenantId: input.tenantId,
          opportunityId: input.opportunityId,
          kind: input.kind,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      );
      return intelligenceSnapshot(input.tenantId);
    },
  );
}

async function executeIdempotentMutation(
  runtime: TenantIntelligenceRuntime,
  idempotencyKey: string,
  fingerprint: string,
  execute: () => Promise<IntelligenceDemoSnapshot>,
): Promise<IntelligenceDemoSnapshot> {
  const receipt = runtime.mutationReceipts.get(idempotencyKey);
  if (receipt !== undefined) {
    if (receipt.fingerprint !== fingerprint) {
      throw new IntelligenceDemoIdempotencyError();
    }
    return structuredClone(receipt.snapshot);
  }
  const inFlight = runtime.mutationsInFlight.get(idempotencyKey);
  if (inFlight !== undefined) {
    if (inFlight.fingerprint !== fingerprint) {
      throw new IntelligenceDemoIdempotencyError();
    }
    return structuredClone(await inFlight.promise);
  }
  const promise = execute();
  runtime.mutationsInFlight.set(idempotencyKey, { fingerprint, promise });
  try {
    const snapshot = await promise;
    runtime.mutationReceipts.set(idempotencyKey, {
      fingerprint,
      snapshot: structuredClone(snapshot),
    });
    return snapshot;
  } finally {
    runtime.mutationsInFlight.delete(idempotencyKey);
  }
}

export async function resetIntelligenceDemoForTest(
  tenantId?: string,
): Promise<void> {
  if (tenantId === undefined) {
    runtimeGlobal.__learningBotIntelligenceDemoRuntimes?.clear();
  } else {
    runtimeGlobal.__learningBotIntelligenceDemoRuntimes?.delete(tenantId);
  }
}
