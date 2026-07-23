import type {
  PlatformPermission,
  PlatformRole,
} from "@course-ai/application-services";
import type { ActorContext, RequestContext, TenantId } from "@course-ai/contracts";
import { IdentityAccessError } from "./errors.js";
import {
  assertCanAssignRole,
  permissionsForRole,
  permissionsForServiceScopes,
} from "./permissions.js";
import type {
  IdentityAuditSink,
  IdentityClock,
  IdentityIdGenerator,
  InvitationRepository,
  MembershipRepository,
  ScimStateRepository,
  ServicePrincipalRepository,
  TenantIdentityRepository,
} from "./repositories.js";
import type {
  AcceptInvitationCommand,
  AuthorizedIdentityContext,
  Invitation,
  InvitationAcceptanceResult,
  NormalizedPrincipal,
  ResolveSessionInput,
  ScimDeprovisionUserCommand,
  ScimProvisionResult,
  ScimProvisionUserCommand,
  TenantMembership,
  VerifiedAuthenticationAssertion,
} from "./types.js";

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new IdentityAccessError("AUTHENTICATION_FAILED", { field });
  }
  return normalized;
}

export interface IdentityAccessDependencies {
  readonly memberships: MembershipRepository;
  readonly tenants: TenantIdentityRepository;
  readonly servicePrincipals: ServicePrincipalRepository;
  readonly invitations: InvitationRepository;
  readonly scim: ScimStateRepository;
  readonly audit: IdentityAuditSink;
  readonly clock: IdentityClock;
  readonly ids: IdentityIdGenerator;
}

export class IdentityAccessService {
  constructor(private readonly dependencies: IdentityAccessDependencies) {}

  normalize(
    assertion: VerifiedAuthenticationAssertion,
  ): NormalizedPrincipal {
    const issuer = required(assertion.issuer, "issuer");
    const subject = required(assertion.subject, "subject");
    if (
      assertion.method === "service_principal" &&
      assertion.servicePrincipalId === undefined
    ) {
      throw new IdentityAccessError("AUTHENTICATION_FAILED");
    }
    const principalId = this.dependencies.ids.deterministic(
      "principal",
      `${assertion.method}\u0000${issuer}\u0000${subject}`,
    );
    return {
      principalId,
      kind: assertion.method === "service_principal" ? "service" : "human",
      method: assertion.method,
      issuer,
      subject,
      authenticatedAt: assertion.authenticatedAt,
      grantedScopes: new Set(assertion.grantedScopes ?? []),
      ...(assertion.sessionId !== undefined ? { sessionId: assertion.sessionId } : {}),
      ...(assertion.email !== undefined ? { email: assertion.email } : {}),
      ...(assertion.displayName !== undefined
        ? { displayName: assertion.displayName }
        : {}),
      ...(assertion.tenantBinding !== undefined
        ? { tenantBinding: assertion.tenantBinding }
        : {}),
      ...(assertion.servicePrincipalId !== undefined
        ? { servicePrincipalId: assertion.servicePrincipalId }
        : {}),
    };
  }

  async resolveSession(
    input: ResolveSessionInput,
  ): Promise<AuthorizedIdentityContext> {
    const principal = this.normalize(input.assertion);
    try {
      if (input.deadlineMs <= this.dependencies.clock.now().getTime()) {
        throw new IdentityAccessError("AUTHENTICATION_FAILED");
      }

      let tenantBinding = principal.tenantBinding;
      let effectivePrincipal = principal;
      if (principal.kind === "service") {
        const registered = await this.dependencies.servicePrincipals.findByClientId(
          principal.servicePrincipalId ?? "",
        );
        if (registered === undefined || registered.status !== "active") {
          throw new IdentityAccessError("ACCESS_DENIED");
        }
        tenantBinding = registered.tenantId;
        if (
          principal.tenantBinding !== undefined &&
          principal.tenantBinding !== registered.tenantId
        ) {
          throw new IdentityAccessError("ACCESS_DENIED");
        }
        const assertedScopes = principal.grantedScopes;
        if (
          [...assertedScopes].some((scope) => !registered.scopes.includes(scope))
        ) {
          throw new IdentityAccessError("ACCESS_DENIED", {
            reason: "service_scope_not_registered",
          });
        }
        effectivePrincipal = {
          ...principal,
          tenantBinding,
          grantedScopes: new Set(
            assertedScopes.size === 0 ? registered.scopes : assertedScopes,
          ),
        };
      }

      const memberships = await this.dependencies.memberships.listActiveForPrincipal(
        effectivePrincipal.principalId,
      );
      const tenantId = selectTenant(
        memberships,
        input.selectedTenantId,
        tenantBinding,
      );
      const membership = memberships.find(
        (candidate) => candidate.tenantId === tenantId,
      );
      if (membership === undefined || membership.status !== "active") {
        throw new IdentityAccessError("ACCESS_DENIED");
      }
      if (
        effectivePrincipal.kind === "service" &&
        membership.role !== "service"
      ) {
        throw new IdentityAccessError("ACCESS_DENIED");
      }
      const tenant = await this.dependencies.tenants.getActive(tenantId);
      if (tenant === undefined || tenant.status !== "active") {
        throw new IdentityAccessError("ACCESS_DENIED");
      }
      const role = membership.role;
      const rolePermissions = permissionsForRole(role);
      const permissions =
        effectivePrincipal.kind === "service"
          ? intersection(
              rolePermissions,
              permissionsForServiceScopes(effectivePrincipal.grantedScopes),
            )
          : rolePermissions;
      const actor: ActorContext = {
        type: actorTypeForRole(role),
        id: effectivePrincipal.principalId,
        role,
        identityTier: "verified",
      };
      const request: RequestContext = {
        requestId: input.requestId,
        traceId: input.traceId,
        tenantId,
        actor,
        fundingSource: input.fundingSource ?? "platform",
        deadlineMs: input.deadlineMs,
        ...(effectivePrincipal.sessionId !== undefined
          ? { sessionId: effectivePrincipal.sessionId }
          : {}),
        ...(input.environment !== undefined
          ? { environment: input.environment }
          : {}),
      };
      await this.emit("identity.session.resolve", "allowed", {
        requestId: input.requestId,
        tenantId,
        principalId: effectivePrincipal.principalId,
        safeMetadata: { method: effectivePrincipal.method, role },
      });
      return {
        principal: effectivePrincipal,
        membership,
        tenant,
        role,
        permissions,
        request,
      };
    } catch (error) {
      const safe =
        error instanceof IdentityAccessError
          ? error
          : new IdentityAccessError("ACCESS_DENIED");
      await this.emit("identity.session.resolve", "denied", {
        requestId: input.requestId,
        principalId: principal.principalId,
        safeMetadata: { code: safe.code },
      });
      throw safe;
    }
  }

  assertCanInvite(actor: AuthorizedIdentityContext, role: PlatformRole): void {
    assertCanAssignRole(actor.role, role);
  }

  async acceptInvitation(
    command: AcceptInvitationCommand,
  ): Promise<InvitationAcceptanceResult> {
    const prior = await this.dependencies.invitations.getAcceptance(
      command.invitationId,
      command.idempotencyKey,
    );
    if (prior !== undefined) {
      if (prior.principalId !== command.principal.principalId) {
        throw new IdentityAccessError("CONFLICT");
      }
      const invitation = await this.dependencies.invitations.get(
        command.invitationId,
      );
      if (invitation === undefined) {
        throw new IdentityAccessError("INVITATION_INVALID");
      }
      const membership = await this.dependencies.memberships.find(
        command.principal.principalId,
        invitation.tenantId,
      );
      if (membership === undefined || membership.membershipId !== prior.membershipId) {
        throw new IdentityAccessError("CONFLICT");
      }
      return { invitation, membership, replayed: true };
    }

    const invitation = await this.dependencies.invitations.get(command.invitationId);
    const now = this.dependencies.clock.now();
    if (
      invitation === undefined ||
      invitation.status !== "pending" ||
      Date.parse(invitation.expiresAt) <= now.getTime() ||
      command.principal.kind !== "human" ||
      command.principal.email === undefined ||
      command.principal.email.trim().toLowerCase() !==
        invitation.email.trim().toLowerCase()
    ) {
      throw new IdentityAccessError("INVITATION_INVALID");
    }
    const membership = await this.dependencies.memberships.upsert({
      tenantId: invitation.tenantId,
      principalId: command.principal.principalId,
      role: invitation.role,
      provisionedBy: "invitation",
      now: now.toISOString(),
    });
    const accepted: Invitation = {
      ...invitation,
      status: "accepted",
      acceptedByPrincipalId: command.principal.principalId,
      acceptedAt: now.toISOString(),
    };
    await this.dependencies.invitations.save(accepted);
    await this.dependencies.invitations.saveAcceptance({
      invitationId: command.invitationId,
      idempotencyKey: command.idempotencyKey,
      principalId: command.principal.principalId,
      membershipId: membership.membershipId,
    });
    await this.emit("identity.invitation.accept", "allowed", {
      tenantId: invitation.tenantId,
      principalId: command.principal.principalId,
      safeMetadata: { invitationId: invitation.invitationId, role: invitation.role },
    });
    return { invitation: accepted, membership, replayed: false };
  }

  async provisionScimUser(
    actor: AuthorizedIdentityContext,
    command: ScimProvisionUserCommand,
  ): Promise<ScimProvisionResult> {
    assertSameTenant(actor.tenant.tenantId, command.tenantId);
    if (actor.principal.kind !== "service" || actor.role !== "service") {
      throw new IdentityAccessError("ACCESS_DENIED");
    }
    requireScope(actor.principal.grantedScopes, "scim:write");
    const prior = await this.dependencies.scim.getIdempotentResult(
      command.tenantId,
      command.idempotencyKey,
    );
    if (prior !== undefined) {
      return { membership: prior, replayed: true };
    }
    const bound = await this.dependencies.scim.getPrincipalId(
      command.tenantId,
      command.externalId,
    );
    if (bound !== undefined && bound !== command.principalId) {
      throw new IdentityAccessError("CONFLICT");
    }
    const membership = await this.dependencies.memberships.upsert({
      tenantId: command.tenantId,
      principalId: command.principalId,
      role: command.role,
      provisionedBy: "scim",
      now: this.dependencies.clock.now().toISOString(),
    });
    let effectiveMembership = membership;
    if (!command.active) {
      const revokedAt = this.dependencies.clock.now().toISOString();
      await this.dependencies.memberships.revoke(
        command.principalId,
        command.tenantId,
        revokedAt,
      );
      effectiveMembership = {
        ...membership,
        status: "revoked",
        updatedAt: revokedAt,
      };
    }
    await this.dependencies.scim.bind(
      command.tenantId,
      command.externalId,
      command.principalId,
    );
    await this.dependencies.scim.saveIdempotentResult(
      command.tenantId,
      command.idempotencyKey,
      effectiveMembership,
    );
    return { membership: effectiveMembership, replayed: false };
  }

  async deprovisionScimUser(
    actor: AuthorizedIdentityContext,
    command: ScimDeprovisionUserCommand,
  ): Promise<void> {
    assertSameTenant(actor.tenant.tenantId, command.tenantId);
    if (actor.principal.kind !== "service") {
      throw new IdentityAccessError("ACCESS_DENIED");
    }
    requireScope(actor.principal.grantedScopes, "scim:write");
    const principalId = await this.dependencies.scim.getPrincipalId(
      command.tenantId,
      command.externalId,
    );
    if (principalId !== undefined) {
      await this.dependencies.memberships.revoke(
        principalId,
        command.tenantId,
        this.dependencies.clock.now().toISOString(),
      );
    }
  }

  private async emit(
    action: string,
    outcome: "allowed" | "denied",
    context: {
      readonly requestId?: string;
      readonly tenantId?: TenantId;
      readonly principalId?: string;
      readonly safeMetadata: Readonly<Record<string, string | number | boolean>>;
    },
  ): Promise<void> {
    await this.dependencies.audit.emit({
      eventId: this.dependencies.ids.deterministic(
        "audit",
        `${action}:${context.requestId ?? ""}:${context.principalId ?? ""}`,
      ),
      action,
      outcome,
      occurredAt: this.dependencies.clock.now().toISOString(),
      ...context,
    });
  }
}

function selectTenant(
  memberships: readonly TenantMembership[],
  selectedTenantId: TenantId | undefined,
  binding: TenantId | undefined,
): TenantId {
  if (memberships.length === 0) {
    throw new IdentityAccessError("ACCESS_DENIED");
  }
  if (binding !== undefined) {
    if (selectedTenantId !== undefined && selectedTenantId !== binding) {
      throw new IdentityAccessError("ACCESS_DENIED");
    }
    if (!memberships.some((membership) => membership.tenantId === binding)) {
      throw new IdentityAccessError("ACCESS_DENIED");
    }
    return binding;
  }
  if (selectedTenantId !== undefined) {
    if (!memberships.some((membership) => membership.tenantId === selectedTenantId)) {
      throw new IdentityAccessError("ACCESS_DENIED");
    }
    return selectedTenantId;
  }
  if (memberships.length !== 1) {
    throw new IdentityAccessError("TENANT_SELECTION_REQUIRED");
  }
  return memberships[0]!.tenantId;
}

function intersection(
  left: ReadonlySet<PlatformPermission>,
  right: ReadonlySet<PlatformPermission>,
): ReadonlySet<PlatformPermission> {
  return new Set([...left].filter((permission) => right.has(permission)));
}

function requireScope(scopes: ReadonlySet<string>, scope: string): void {
  if (!scopes.has(scope)) {
    throw new IdentityAccessError("ACCESS_DENIED", { scope });
  }
}

function assertSameTenant(expected: TenantId, actual: TenantId): void {
  if (expected.length === 0 || expected !== actual) {
    throw new IdentityAccessError("ACCESS_DENIED");
  }
}

function actorTypeForRole(role: PlatformRole): ActorContext["type"] {
  if (role === "student") return "student";
  if (role === "creator" || role === "teacher") return "creator";
  if (role === "tenant_owner") return "owner";
  return "system";
}
