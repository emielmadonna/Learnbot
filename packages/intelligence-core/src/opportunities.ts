import { requireIntelligence } from "./errors.js";
import type {
  EvidenceRepository,
  IntelligenceClock,
  IntelligenceIdFactory,
  OpportunityRepository,
} from "./repositories.js";
import type {
  HumanReviewActor,
  OpportunityCandidate,
  OpportunityEligibility,
  OpportunityEvaluation,
  OpportunityFeedback,
  OpportunityFeedbackKind,
  OpportunityStatus,
  OpportunitySuppressionReason,
  StudentOpportunity,
  TenantId,
} from "./types.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

const OPPORTUNITY_KINDS = [
  "support_needed",
  "offer_fit",
  "high_intent",
  "win",
  "stall",
] as const;
const OPPORTUNITY_LABELS = ["watch", "warm", "hot", "unknown"] as const;
const IDENTITY_TIERS = ["verified", "self_reported", "anonymous"] as const;
const EVIDENCE_KINDS = ["message", "event", "metric"] as const;

function candidateValid(candidate: OpportunityCandidate): boolean {
  const computedAt = Date.parse(candidate.computedAt);
  const evidenceThrough = Date.parse(candidate.evidenceThrough);
  const expiresAt = Date.parse(candidate.expiresAt);
  return (
    nonEmpty(candidate.id) &&
    nonEmpty(candidate.tenantId) &&
    nonEmpty(candidate.endUserId) &&
    nonEmpty(candidate.policyVersion) &&
    (candidate.offerId === undefined || nonEmpty(candidate.offerId)) &&
    (OPPORTUNITY_KINDS as readonly string[]).includes(candidate.kind) &&
    (OPPORTUNITY_LABELS as readonly string[]).includes(candidate.label) &&
    (IDENTITY_TIERS as readonly string[]).includes(candidate.identityTier) &&
    Array.isArray(candidate.evidenceRefs) &&
    candidate.evidenceRefs.every(
      (reference) =>
        (EVIDENCE_KINDS as readonly string[]).includes(reference.kind) &&
        nonEmpty(reference.refId),
    ) &&
    Array.isArray(candidate.limitations) &&
    candidate.limitations.every((limitation) => typeof limitation === "string") &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    (candidate.score === undefined ||
      (Number.isFinite(candidate.score) &&
        candidate.score >= 0 &&
        candidate.score <= 100)) &&
    validTimestamp(candidate.computedAt) &&
    validTimestamp(candidate.evidenceThrough) &&
    validTimestamp(candidate.expiresAt) &&
    evidenceThrough <= computedAt &&
    expiresAt > computedAt
  );
}

function eligibilityValid(eligibility: OpportunityEligibility): boolean {
  return (
    (eligibility.analyticsConsent === "granted" ||
      eligibility.analyticsConsent === "revoked") &&
    (eligibility.freshness === "fresh" || eligibility.freshness === "stale") &&
    (eligibility.coverage === "sufficient" ||
      eligibility.coverage === "insufficient") &&
    (eligibility.tenantHealth === "healthy" ||
      eligibility.tenantHealth === "partial" ||
      eligibility.tenantHealth === "missing" ||
      eligibility.tenantHealth === "degraded")
  );
}

export class OpportunityEvaluationService {
  constructor(
    private readonly evidence: EvidenceRepository,
    private readonly opportunities: OpportunityRepository,
  ) {}

  async evaluate(
    candidate: OpportunityCandidate,
    eligibility: OpportunityEligibility,
  ): Promise<OpportunityEvaluation> {
    const reasons: OpportunitySuppressionReason[] = [];
    if (candidate.identityTier === "anonymous") reasons.push("anonymous_identity");
    if (eligibility.analyticsConsent === "revoked") {
      reasons.push("analytics_consent_revoked");
    }
    if (eligibility.freshness === "stale") reasons.push("stale_evidence");
    if (
      eligibility.coverage === "insufficient" ||
      eligibility.tenantHealth === "missing"
    ) {
      reasons.push("insufficient_coverage");
    }
    if (eligibility.tenantHealth === "degraded") reasons.push("tenant_degraded");
    if (!candidateValid(candidate) || !eligibilityValid(eligibility)) {
      reasons.push("invalid_candidate");
    }
    if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length === 0) {
      reasons.push("missing_evidence");
    }

    // Eligibility is checked before loading evidence. Suppressed identities
    // cannot use this service as an evidence-existence oracle.
    if (reasons.length > 0) {
      return {
        outcome: "suppressed",
        candidateId: candidate.id,
        reasons: [...new Set(reasons)],
      };
    }

    const resolved = [];
    for (const reference of candidate.evidenceRefs) {
      const evidence = await this.evidence.get(
        candidate.tenantId,
        reference.kind,
        reference.refId,
      );
      if (evidence === undefined) {
        reasons.push("missing_evidence");
        continue;
      }
      if (evidence.tenantId !== candidate.tenantId) {
        reasons.push("cross_tenant_evidence");
        continue;
      }
      if (
        evidence.kind !== reference.kind ||
        evidence.refId !== reference.refId ||
        !nonEmpty(evidence.fact) ||
        !validTimestamp(evidence.capturedAt) ||
        Date.parse(evidence.capturedAt) > Date.parse(candidate.evidenceThrough)
      ) {
        reasons.push("invalid_candidate");
        continue;
      }
      resolved.push(evidence);
    }
    if (reasons.length > 0 || resolved.length !== candidate.evidenceRefs.length) {
      const suppressionReasons: OpportunitySuppressionReason[] =
        reasons.length === 0 ? ["missing_evidence"] : reasons;
      return {
        outcome: "suppressed",
        candidateId: candidate.id,
        reasons: [...new Set(suppressionReasons)],
      };
    }

    // Anonymous identity was returned above before any evidence read.
    if (candidate.identityTier === "anonymous") {
      return {
        outcome: "suppressed",
        candidateId: candidate.id,
        reasons: ["anonymous_identity"],
      };
    }
    const limitations = [...candidate.limitations];
    if (candidate.identityTier === "self_reported") {
      limitations.push("identity_tier:self_reported");
    }
    const opportunity: StudentOpportunity = {
      id: candidate.id,
      tenantId: candidate.tenantId,
      endUserId: candidate.endUserId,
      ...(candidate.offerId === undefined ? {} : { offerId: candidate.offerId }),
      kind: candidate.kind,
      ...(candidate.score === undefined ? {} : { score: candidate.score }),
      label: candidate.label,
      confidence: candidate.confidence,
      computedAt: candidate.computedAt,
      evidenceThrough: candidate.evidenceThrough,
      expiresAt: candidate.expiresAt,
      policyVersion: candidate.policyVersion,
      identityTier: candidate.identityTier,
      evidence: resolved.map((item) => ({ ...item })),
      limitations: [...new Set(limitations)],
      status: "new",
      reviewMode: "human_only",
    };
    await this.opportunities.create(opportunity);
    return { outcome: "surfaced", opportunity };
  }
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<OpportunityStatus, readonly OpportunityStatus[]>
> = {
  new: ["seen", "actioned", "dismissed", "converted", "expired"],
  seen: ["actioned", "dismissed", "converted", "expired"],
  actioned: ["dismissed", "converted", "expired"],
  dismissed: [],
  converted: [],
  expired: [],
};

export interface ChangeOpportunityStatusCommand {
  readonly tenantId: TenantId;
  readonly opportunityId: string;
  readonly expectedStatus: OpportunityStatus;
  readonly nextStatus: OpportunityStatus;
  readonly reason?: string;
}

export interface RecordOpportunityFeedbackCommand {
  readonly tenantId: TenantId;
  readonly opportunityId: string;
  readonly kind: OpportunityFeedbackKind;
  readonly note?: string;
}

export class OpportunityReviewService {
  constructor(
    private readonly repository: OpportunityRepository,
    private readonly clock: IntelligenceClock,
    private readonly ids: IntelligenceIdFactory,
  ) {}

  async changeStatus(
    actor: HumanReviewActor,
    command: ChangeOpportunityStatusCommand,
  ): Promise<StudentOpportunity> {
    requireIntelligence(
      nonEmpty(actor.actorId) &&
        (actor.role === "creator" || actor.role === "owner"),
      "opportunity.invalid_input",
      "A human reviewer is required.",
    );
    const current = await this.repository.get(
      command.tenantId,
      command.opportunityId,
    );
    requireIntelligence(
      current !== undefined,
      "opportunity.not_found",
      "Opportunity was not found in this tenant.",
    );
    requireIntelligence(
      current.status === command.expectedStatus,
      "opportunity.version_conflict",
      "Opportunity status changed before this review was committed.",
    );
    requireIntelligence(
      ALLOWED_TRANSITIONS[current.status].includes(command.nextStatus),
      "opportunity.invalid_transition",
      "The requested lifecycle transition is not allowed.",
    );
    const audit = {
      id: this.ids.next("audit"),
      tenantId: command.tenantId,
      opportunityId: command.opportunityId,
      action: "status_changed" as const,
      actor: { ...actor },
      occurredAt: this.clock.now(),
      fromStatus: current.status,
      toStatus: command.nextStatus,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    };
    const updated = await this.repository.compareAndSetStatus(
      command.tenantId,
      command.opportunityId,
      command.expectedStatus,
      command.nextStatus,
      audit,
    );
    requireIntelligence(
      updated !== undefined,
      "opportunity.version_conflict",
      "Opportunity status changed before this review was committed.",
    );
    return updated;
  }

  async recordFeedback(
    actor: HumanReviewActor,
    command: RecordOpportunityFeedbackCommand,
  ): Promise<OpportunityFeedback> {
    requireIntelligence(
      nonEmpty(actor.actorId) &&
        (actor.role === "creator" || actor.role === "owner"),
      "opportunity.invalid_input",
      "A human reviewer is required.",
    );
    requireIntelligence(
      command.kind === "dismissed_false_positive" ||
        command.kind === "wrong_offer" ||
        command.kind === "helpful",
      "opportunity.invalid_input",
      "Feedback kind is invalid.",
    );
    const opportunity = await this.repository.get(
      command.tenantId,
      command.opportunityId,
    );
    requireIntelligence(
      opportunity !== undefined,
      "opportunity.not_found",
      "Opportunity was not found in this tenant.",
    );
    const createdAt = this.clock.now();
    const feedback: OpportunityFeedback = {
      id: this.ids.next("feedback"),
      tenantId: command.tenantId,
      opportunityId: command.opportunityId,
      kind: command.kind,
      ...(command.note === undefined ? {} : { note: command.note }),
      actor: { ...actor },
      createdAt,
    };
    await this.repository.appendFeedback(feedback, {
      id: this.ids.next("audit"),
      tenantId: command.tenantId,
      opportunityId: command.opportunityId,
      action: "feedback_recorded",
      actor: { ...actor },
      occurredAt: createdAt,
      feedbackId: feedback.id,
    });
    return feedback;
  }
}
