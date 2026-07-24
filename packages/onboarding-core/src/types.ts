export const ONBOARDING_STEP_KEYS = [
  "tenant_profile",
  "identity_mode",
  "provider_funding",
  "source_ingestion",
  "assistant_voice_guide",
  "diagram_review",
  "context_mapping",
  "widget_branding",
  "privacy_consent",
  "recording_policy",
  "retention_policy",
  "playground_qa",
  "install_verification",
  "client_handoff",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

export type OnboardingStepStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "blocked"
  | "not_applicable";

export type OnboardingStatus =
  | "draft"
  | "in_progress"
  | "blocked"
  | "ready_for_review"
  | "ready_for_launch"
  | "live";

export type CirclePlan =
  | "unconfirmed"
  | "professional"
  | "business_plus"
  | "not_circle";

export type ExpectedIdentityMode =
  | "unconfirmed"
  | "self_reported"
  | "verified";

export type OnboardingActorRole =
  | "platform_admin"
  | "tenant_owner"
  | "tenant_admin";

export interface OnboardingCommandContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorRole: OnboardingActorRole;
  readonly requestId: string;
  readonly traceId: string;
}

export interface OnboardingBrandingSeed {
  readonly assistantName: string;
  readonly primaryColor: string;
  readonly accentColor: string;
}

export interface OnboardingIdentityConfiguration {
  readonly circlePlan: CirclePlan;
  readonly expectedMode: ExpectedIdentityMode;
}

export interface OnboardingStep {
  readonly key: OnboardingStepKey;
  readonly title: string;
  readonly description: string;
  readonly status: OnboardingStepStatus;
  readonly required: boolean;
  readonly updatedAt: string;
  readonly evidenceNote?: string;
}

export interface OnboardingWorkspace {
  readonly onboardingId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly planId: string;
  readonly status: OnboardingStatus;
  readonly version: number;
  readonly branding: OnboardingBrandingSeed;
  readonly identity: OnboardingIdentityConfiguration;
  readonly steps: readonly OnboardingStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly launchedAt?: string;
}

export type OnboardingInvitationRole =
  | "tenant_owner"
  | "tenant_admin"
  | "creator"
  | "teacher";
export type OnboardingInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

/** Raw email remains repository-private and is never returned by the service. */
export interface StoredOnboardingInvitation {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly emailNormalized: string;
  readonly role: OnboardingInvitationRole;
  readonly status: OnboardingInvitationStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly acceptedByActorId?: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
}

export interface OnboardingInvitationView {
  readonly invitationId: string;
  readonly emailHint: string;
  readonly role: OnboardingInvitationRole;
  readonly status: OnboardingInvitationStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface OnboardingAuditEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly outcome: "allowed" | "denied";
  readonly occurredAt: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly safeMetadata: Readonly<
    Record<string, string | number | boolean>
  >;
}

export interface OnboardingLaunchReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export interface OnboardingSnapshot
  extends Omit<OnboardingWorkspace, "createdAt" | "launchedAt"> {
  readonly invitations: readonly OnboardingInvitationView[];
  readonly launch: OnboardingLaunchReadiness;
  readonly audit: readonly OnboardingAuditEvent[];
  readonly createdAt: string;
  readonly launchedAt?: string;
}

export interface UpdateTenantProfileCommand {
  readonly displayName: string;
  readonly slug: string;
  readonly planId: string;
  readonly assistantName: string;
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly circlePlan: CirclePlan;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
}

export interface SetOnboardingStepCommand {
  readonly stepKey: OnboardingStepKey;
  readonly status: OnboardingStepStatus;
  readonly evidenceNote?: string;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
}

export interface InviteClientAdminCommand {
  readonly email: string;
  readonly role: OnboardingInvitationRole;
  readonly expiresInHours: number;
  readonly idempotencyKey: string;
}

export interface RevokeOnboardingInvitationCommand {
  readonly invitationId: string;
  readonly idempotencyKey: string;
}

export interface ReviewOrActivateCommand {
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
}

export interface AcceptOnboardingInvitationContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly authenticatedEmail: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface AcceptOnboardingInvitationCommand {
  readonly invitationId: string;
  readonly idempotencyKey: string;
}
