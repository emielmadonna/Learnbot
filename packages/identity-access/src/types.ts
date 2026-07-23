import type {
  PlatformPermission,
  PlatformRole,
} from "@course-ai/application-services";
import type {
  ActorId,
  IsoTimestamp,
  RequestContext,
  TenantContext,
  TenantId,
} from "@course-ai/contracts";

export type AuthenticationMethod =
  | "oidc"
  | "saml"
  | "host_signed"
  | "service_principal";

/**
 * An assertion is accepted only after the protocol-specific verifier has
 * authenticated it. Raw OIDC/SAML bearer tokens deliberately do not fit this
 * interface.
 */
export interface VerifiedAuthenticationAssertion {
  readonly method: AuthenticationMethod;
  readonly issuer: string;
  readonly subject: string;
  readonly authenticatedAt: IsoTimestamp;
  readonly sessionId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly tenantBinding?: TenantId;
  readonly servicePrincipalId?: string;
  readonly grantedScopes?: readonly string[];
}

export interface NormalizedPrincipal {
  readonly principalId: ActorId;
  readonly kind: "human" | "service";
  readonly method: AuthenticationMethod;
  readonly issuer: string;
  readonly subject: string;
  readonly authenticatedAt: IsoTimestamp;
  readonly sessionId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly tenantBinding?: TenantId;
  readonly servicePrincipalId?: string;
  readonly grantedScopes: ReadonlySet<string>;
}

export interface TenantMembership {
  readonly membershipId: string;
  readonly tenantId: TenantId;
  readonly principalId: ActorId;
  readonly role: PlatformRole;
  readonly status: "active" | "suspended" | "revoked";
  readonly provisionedBy: "invitation" | "scim" | "manual" | "host";
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ServicePrincipal {
  readonly servicePrincipalId: string;
  readonly tenantId: TenantId;
  readonly clientId: string;
  readonly status: "active" | "revoked";
  readonly scopes: readonly string[];
  readonly createdAt: IsoTimestamp;
}

export interface AuthorizedIdentityContext {
  readonly principal: NormalizedPrincipal;
  readonly membership: TenantMembership;
  readonly tenant: TenantContext;
  readonly role: PlatformRole;
  readonly permissions: ReadonlySet<PlatformPermission>;
  readonly request: RequestContext;
}

export interface ResolveSessionInput {
  readonly assertion: VerifiedAuthenticationAssertion;
  /** A selector only. Authorization always comes from membership storage. */
  readonly selectedTenantId?: TenantId;
  readonly requestId: string;
  readonly traceId: string;
  readonly deadlineMs: number;
  readonly fundingSource?: "platform" | "tenant_byok";
  readonly environment?: "local" | "test" | "staging" | "production";
}

export interface HostContextClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly tenantId: TenantId;
  readonly nonce: string;
  readonly iat: number;
  readonly exp: number;
  readonly sessionId?: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface HostTokenHeader {
  readonly alg: string;
  readonly kid: string;
  readonly typ?: string;
}

export interface HostVerificationPolicy {
  readonly trustedIssuer: string;
  readonly audience: string;
  readonly allowedAlgorithms: readonly string[];
  readonly maximumLifetimeSeconds: number;
  readonly clockSkewSeconds?: number;
}

export interface HostVerificationKey {
  readonly keyId: string;
  readonly algorithm: string;
  readonly material: unknown;
  readonly activeFromMs?: number;
  readonly retiredAfterMs?: number;
}

export interface Invitation {
  readonly invitationId: string;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly role: PlatformRole;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly expiresAt: IsoTimestamp;
  readonly acceptedByPrincipalId?: ActorId;
  readonly acceptedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

export interface AcceptInvitationCommand {
  readonly invitationId: string;
  readonly principal: NormalizedPrincipal;
  readonly idempotencyKey: string;
}

export interface ScimProvisionUserCommand {
  readonly tenantId: TenantId;
  readonly externalId: string;
  readonly principalId: ActorId;
  readonly role: PlatformRole;
  readonly active: boolean;
  readonly idempotencyKey: string;
}

export interface ScimDeprovisionUserCommand {
  readonly tenantId: TenantId;
  readonly externalId: string;
  readonly idempotencyKey: string;
}

export interface IdentityAuditEvent {
  readonly eventId: string;
  readonly action: string;
  readonly outcome: "allowed" | "denied";
  readonly occurredAt: IsoTimestamp;
  readonly requestId?: string;
  readonly tenantId?: TenantId;
  readonly principalId?: ActorId;
  readonly safeMetadata: Readonly<Record<string, string | number | boolean>>;
}

export interface InvitationAcceptanceResult {
  readonly invitation: Invitation;
  readonly membership: TenantMembership;
  readonly replayed: boolean;
}

export interface ScimProvisionResult {
  readonly membership: TenantMembership;
  readonly replayed: boolean;
}
