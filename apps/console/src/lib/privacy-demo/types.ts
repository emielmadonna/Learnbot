import type {
  DeletionPolicy,
  LegalHold,
  ManifestVerification,
  PrivacyAuditEntry,
  PrivacyJob,
  PrivacyPurpose,
  RetentionPolicy,
} from "@course-ai/privacy-lifecycle";

export const PRIVACY_DEMO_SUBJECTS = [
  {
    subjectId: "student_maya_demo",
    displayName: "Maya Chen",
    identityTier: "verified",
    scenario: "Active learner with completed access and export fixtures",
  },
  {
    subjectId: "student_delete_demo",
    displayName: "Deletion fixture",
    identityTier: "self_reported",
    scenario: "Completed deletion and tombstone evidence",
  },
  {
    subjectId: "student_held_demo",
    displayName: "Legal-hold fixture",
    identityTier: "verified",
    scenario: "Deletion and retention remain partial while one record is held",
  },
  {
    subjectId: "student_anonymous_demo",
    displayName: "Anonymous fixture",
    identityTier: "anonymous",
    scenario: "Individual privacy export is honestly blocked",
  },
] as const;

export type PrivacyDemoOperation = "access" | "export" | "delete" | "retention";

export interface PrivacyFixturePolicySummary {
  fixtureStatus: "demo_fixture_not_approved";
  policyDecisionBoundary: {
    o07VoiceRecording: "blocked_pending_O07";
    o13Retention: "fixture_only_pending_O13";
  };
  region: string;
  rawAudioRetentionDays: null;
  deletion: DeletionPolicy;
  retention: RetentionPolicy;
}

export interface PrivacyPreview {
  previewToken: string;
  expiresAt: string;
  operation: PrivacyDemoOperation;
  purpose: PrivacyPurpose;
  subjectId?: string;
  impactedRecordCount: number;
  heldRecordIds: readonly string[];
  policyId?: string;
  policyVersion?: string;
  dataThrough?: string;
  requiredConfirmationPhrase?: string;
  confirmationGrantId?: string;
  exactGrant: {
    actorId: string;
    role: "owner";
    purpose: PrivacyPurpose;
    operation: string;
    target: string;
    policyVersion: string;
  };
  warning: string;
}

export interface PrivacyDemoSnapshot {
  fixture: {
    label: "DEVELOPMENT FIXTURE — NOT PRODUCTION POLICY OR COMPLIANCE EVIDENCE";
    durable: false;
    productionIdpConfigured: false;
  };
  tenant: {
    tenantId: string;
    tenantSlug: string;
    actorDisplayName?: string;
    actorId: string;
    membershipRole: string;
  };
  policies: PrivacyFixturePolicySummary;
  subjects: typeof PRIVACY_DEMO_SUBJECTS;
  holds: readonly LegalHold[];
  jobs: readonly PrivacyJob[];
  manifests: readonly {
    manifestId: string;
    jobId: string;
    itemCount: number;
    totalBytes: number;
    rootSha256: string;
    verification?: ManifestVerification;
  }[];
  tombstones: readonly {
    tenantId: string;
    subjectId: string;
    identityTier: string;
    subjectDigest: string;
    deletedAt: string;
    jobId: string;
    policyVersion: string;
    retainedLegalHoldIds: readonly string[];
  }[];
  audit: readonly PrivacyAuditEntry[];
  exactGrantPolicyVersion: string;
}
