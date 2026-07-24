import type {
  ConfusionMetric,
  ContentGapMetric,
  DataHealthSnapshot,
  MetricResult,
  ModuleVelocityMetric,
  OpportunityAuditEntry,
  OpportunityFeedback,
  OpportunitySuppressionReason,
  StallMetric,
  StudentOpportunity,
} from "@course-ai/intelligence-core";

export interface IntelligenceMetricSnapshot {
  readonly confusion: MetricResult<ConfusionMetric>;
  readonly contentGap: MetricResult<ContentGapMetric>;
  readonly stall: MetricResult<StallMetric>;
  readonly velocity: MetricResult<ModuleVelocityMetric>;
}

export interface SuppressionPreview {
  readonly candidateId: string;
  readonly label: string;
  readonly reasons: readonly OpportunitySuppressionReason[];
}

export interface IntelligenceDemoSnapshot {
  readonly generatedAt: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly course: {
    readonly title: string;
    readonly module: string;
    readonly lesson: string;
  };
  readonly learner: {
    readonly id: string;
    readonly displayName: string;
    readonly identityTier: "verified";
  };
  readonly health: DataHealthSnapshot;
  readonly metrics: IntelligenceMetricSnapshot;
  readonly opportunity: StudentOpportunity;
  readonly suppressed: readonly SuppressionPreview[];
  readonly feedback: readonly OpportunityFeedback[];
  readonly audit: readonly OpportunityAuditEntry[];
  readonly policyBoundary: {
    readonly opportunityPolicyVersion: string;
    readonly policyStatus: "development_fixture_only";
    readonly scoreComputed: false;
    readonly offerMatched: false;
    readonly autonomousOutreach: false;
    readonly unresolvedDecision: "O-09";
    readonly note: string;
  };
  readonly productionGaps: readonly string[];
}

export interface IntelligenceApiResponse {
  readonly snapshot: IntelligenceDemoSnapshot;
  readonly session: {
    readonly mode: string;
    readonly productionIdpConfigured: boolean;
    readonly tenantId: string;
    readonly tenantSlug: string;
    readonly role: string;
  };
}

export type IntelligenceMutation =
  | {
      readonly action: "status";
      readonly tenantId?: string;
      readonly idempotencyKey: string;
      readonly opportunityId: string;
      readonly expectedStatus: StudentOpportunity["status"];
      readonly nextStatus: StudentOpportunity["status"];
      readonly reason?: string;
    }
  | {
      readonly action: "feedback";
      readonly tenantId?: string;
      readonly idempotencyKey: string;
      readonly opportunityId: string;
      readonly kind:
        | "dismissed_false_positive"
        | "wrong_offer"
        | "helpful";
      readonly note?: string;
    };
