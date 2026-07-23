import "server-only";

import {
  DeterministicIdentityIds,
  IdentityAccessError,
  IdentityAccessService,
  MemoryAuditSink,
  MemoryInvitationRepository,
  MemoryMembershipRepository,
  MemoryScimStateRepository,
  MemoryServicePrincipalRepository,
  MemoryTenantIdentityRepository,
  type AuthorizedIdentityContext,
  type VerifiedAuthenticationAssertion,
} from "@course-ai/identity-access";

import { DEVELOPMENT_TENANT_ID } from "./dev-runtime";

export type DevelopmentPrincipalProfile =
  | "owner"
  | "creator"
  | "student"
  | "service";

const DEMO_ISSUER = "urn:learningbot:development:verified-assertion";
const DEMO_AUTHENTICATED_AT = "2026-07-23T20:00:00.000Z";

const PROFILE_ASSERTIONS: Readonly<
  Record<DevelopmentPrincipalProfile, VerifiedAuthenticationAssertion>
> = {
  owner: {
    method: "oidc",
    issuer: DEMO_ISSUER,
    subject: "owner-emiel-demo",
    email: "owner@northstar.example",
    displayName: "Northstar owner",
    authenticatedAt: DEMO_AUTHENTICATED_AT,
    sessionId: "demo-session-owner",
  },
  creator: {
    method: "saml",
    issuer: DEMO_ISSUER,
    subject: "creator-emiel-demo",
    email: "creator@northstar.example",
    displayName: "Northstar creator",
    authenticatedAt: DEMO_AUTHENTICATED_AT,
    sessionId: "demo-session-creator",
  },
  student: {
    method: "host_signed",
    issuer: DEMO_ISSUER,
    subject: "student-maya-demo",
    displayName: "Maya",
    authenticatedAt: DEMO_AUTHENTICATED_AT,
    sessionId: "demo-session-student",
    tenantBinding: DEVELOPMENT_TENANT_ID,
  },
  service: {
    method: "service_principal",
    issuer: DEMO_ISSUER,
    subject: "development-provider-router",
    authenticatedAt: DEMO_AUTHENTICATED_AT,
    servicePrincipalId: "development-provider-router",
    tenantBinding: DEVELOPMENT_TENANT_ID,
    grantedScopes: ["course:read", "conversation:write", "cost:write"],
  },
};

/**
 * Development-only stand-in for an upstream OIDC/SAML/host verifier.
 *
 * It accepts a server-selected fixture profile, never a bearer token or
 * client-supplied subject. Production protocol verification remains external.
 */
export class DemoVerifiedAssertionAdapter {
  verify(profile: DevelopmentPrincipalProfile): VerifiedAuthenticationAssertion {
    if (process.env.NODE_ENV === "production") {
      throw new IdentityAccessError("ACCESS_DENIED", {
        reason: "development_identity_disabled",
      });
    }
    return PROFILE_ASSERTIONS[profile];
  }
}

const ids = new DeterministicIdentityIds();

function principalId(profile: DevelopmentPrincipalProfile): string {
  const assertion = PROFILE_ASSERTIONS[profile];
  return ids.deterministic(
    "principal",
    `${assertion.method}\u0000${assertion.issuer}\u0000${assertion.subject}`,
  );
}

function membership(
  profile: DevelopmentPrincipalProfile,
  role: "tenant_owner" | "creator" | "student" | "service",
) {
  return {
    membershipId: `membership_northstar_${profile}`,
    tenantId: DEVELOPMENT_TENANT_ID,
    principalId: principalId(profile),
    role,
    status: "active" as const,
    provisionedBy: "manual" as const,
    createdAt: DEMO_AUTHENTICATED_AT,
    updatedAt: DEMO_AUTHENTICATED_AT,
  };
}

function createDevelopmentIdentityService() {
  return new IdentityAccessService({
    memberships: new MemoryMembershipRepository([
      membership("owner", "tenant_owner"),
      membership("creator", "creator"),
      membership("student", "student"),
      membership("service", "service"),
    ]),
    tenants: new MemoryTenantIdentityRepository([
      {
        tenantId: DEVELOPMENT_TENANT_ID,
        slug: "northstar-academy",
        status: "active",
        planId: "enterprise",
        region: "us-west",
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        featureFlags: {
          realtimeVoice: true,
          fileAttachments: true,
          managementMcp: true,
        },
        limits: {
          monthlyBudgetUsd: 2500,
          attachmentBytes: 26214400,
        },
        policyVersion: "policy-v18",
        resolvedAt: DEMO_AUTHENTICATED_AT,
      },
    ]),
    servicePrincipals: new MemoryServicePrincipalRepository([
      {
        servicePrincipalId: "service_principal_development_router",
        tenantId: DEVELOPMENT_TENANT_ID,
        clientId: "development-provider-router",
        status: "active",
        scopes: ["course:read", "conversation:write", "cost:write"],
        createdAt: DEMO_AUTHENTICATED_AT,
      },
    ]),
    invitations: new MemoryInvitationRepository(),
    scim: new MemoryScimStateRepository(),
    audit: new MemoryAuditSink(),
    clock: {
      now: () => new Date(),
    },
    ids,
  });
}

const identityGlobal = globalThis as typeof globalThis & {
  __learningBotDevelopmentIdentityService?: IdentityAccessService;
};

export function getDevelopmentIdentityService(): IdentityAccessService {
  identityGlobal.__learningBotDevelopmentIdentityService ??=
    createDevelopmentIdentityService();
  return identityGlobal.__learningBotDevelopmentIdentityService;
}

export function getDemoVerifiedAssertion(
  profile: DevelopmentPrincipalProfile,
): VerifiedAuthenticationAssertion {
  return new DemoVerifiedAssertionAdapter().verify(profile);
}

export type DevelopmentIdentitySession = AuthorizedIdentityContext;
