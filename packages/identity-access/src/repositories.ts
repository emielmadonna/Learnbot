import type { PlatformRole } from "@course-ai/application-services";
import type { ActorId, TenantContext, TenantId } from "@course-ai/contracts";
import type {
  HostVerificationKey,
  IdentityAuditEvent,
  Invitation,
  ServicePrincipal,
  TenantMembership,
  VerifiedAuthenticationAssertion,
} from "./types.js";

/**
 * Protocol adapters implement OIDC discovery/JWK, SAML signature/trust, or
 * client-credential verification and return only authenticated assertions.
 */
export interface AuthenticationAssertionVerifier<TRawAssertion> {
  readonly method: "oidc" | "saml" | "service_principal";
  verify(
    rawAssertion: TRawAssertion,
    context: {
      readonly audience: string;
      readonly requestId: string;
      readonly now: Date;
    },
  ): Promise<VerifiedAuthenticationAssertion>;
}

export interface MembershipRepository {
  listActiveForPrincipal(principalId: ActorId): Promise<readonly TenantMembership[]>;
  find(principalId: ActorId, tenantId: TenantId): Promise<TenantMembership | undefined>;
  upsert(input: {
    readonly tenantId: TenantId;
    readonly principalId: ActorId;
    readonly role: PlatformRole;
    readonly provisionedBy: TenantMembership["provisionedBy"];
    readonly now: string;
  }): Promise<TenantMembership>;
  revoke(principalId: ActorId, tenantId: TenantId, now: string): Promise<void>;
}

export interface TenantIdentityRepository {
  getActive(tenantId: TenantId): Promise<TenantContext | undefined>;
}

export interface ServicePrincipalRepository {
  findByClientId(clientId: string): Promise<ServicePrincipal | undefined>;
}

export interface HostVerificationKeyResolver {
  resolve(issuer: string, keyId: string): Promise<HostVerificationKey | undefined>;
}

export interface ReplayStore {
  consumeOnce(key: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

export interface InvitationRepository {
  get(invitationId: string): Promise<Invitation | undefined>;
  save(invitation: Invitation): Promise<void>;
  getAcceptance(
    invitationId: string,
    idempotencyKey: string,
  ): Promise<{ readonly principalId: ActorId; readonly membershipId: string } | undefined>;
  saveAcceptance(input: {
    readonly invitationId: string;
    readonly idempotencyKey: string;
    readonly principalId: ActorId;
    readonly membershipId: string;
  }): Promise<void>;
}

export interface ScimStateRepository {
  getPrincipalId(tenantId: TenantId, externalId: string): Promise<ActorId | undefined>;
  bind(tenantId: TenantId, externalId: string, principalId: ActorId): Promise<void>;
  getIdempotentResult(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<TenantMembership | undefined>;
  saveIdempotentResult(
    tenantId: TenantId,
    idempotencyKey: string,
    membership: TenantMembership,
  ): Promise<void>;
}

export interface HostSignatureVerifier {
  verify(input: {
    readonly algorithm: string;
    readonly key: HostVerificationKey;
    readonly signingInput: Uint8Array;
    readonly signature: Uint8Array;
  }): Promise<boolean>;
}

export interface IdentityAuditSink {
  emit(event: IdentityAuditEvent): Promise<void>;
}

export interface IdentityClock {
  now(): Date;
}

export interface IdentityIdGenerator {
  deterministic(prefix: string, scope: string): string;
}
