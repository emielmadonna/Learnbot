import "server-only";

import {
  IdentityAccessError,
  assertIdentityPermission,
  type AuthorizedIdentityContext,
} from "@course-ai/identity-access";
import {
  authorizeTenantContext,
  type AuthorizedTenantContext,
  type PlatformPermission,
} from "@course-ai/application-services";

import { DEVELOPMENT_STUDENT_ID } from "./dev-runtime";
import {
  getDemoVerifiedAssertion,
  getDevelopmentIdentityService,
  type DevelopmentPrincipalProfile,
} from "./dev-identity";

export const DEVELOPMENT_TENANT_SELECTOR_HEADER =
  "x-course-ai-tenant-id";

export interface DevelopmentSession {
  readonly identity: AuthorizedIdentityContext;
  readonly context: AuthorizedTenantContext;
}

export async function requireDevSession(
  request: Request,
  options: {
    readonly principal: DevelopmentPrincipalProfile;
    readonly permission?: PlatformPermission;
  },
): Promise<DevelopmentSession> {
  const url = new URL(request.url);
  const headerTenant = request.headers.get(
    DEVELOPMENT_TENANT_SELECTOR_HEADER,
  );
  const queryTenant = url.searchParams.get("tenantId");
  if (
    headerTenant !== null &&
    queryTenant !== null &&
    headerTenant !== queryTenant
  ) {
    throw new IdentityAccessError("ACCESS_DENIED", {
      reason: "tenant_selector_mismatch",
    });
  }
  const selectedTenantId = headerTenant ?? queryTenant ?? undefined;
  const identity = await getDevelopmentIdentityService().resolveSession({
    assertion: getDemoVerifiedAssertion(options.principal),
    ...(selectedTenantId === undefined ? {} : { selectedTenantId }),
    requestId: `req_${crypto.randomUUID()}`,
    traceId: `trace_${crypto.randomUUID()}`,
    deadlineMs: Date.now() + 30_000,
    fundingSource: "platform",
    environment: "local",
  });
  if (options.permission !== undefined) {
    assertIdentityPermission(identity.permissions, options.permission);
  }
  const requestContext =
    options.principal === "student"
      ? {
          ...identity.request,
          actor: {
            ...identity.request.actor,
            // Development fixtures explicitly map the verified identity subject
            // to the seeded domain student. The browser never supplies this ID.
            id: DEVELOPMENT_STUDENT_ID,
          },
        }
      : identity.request;
  return {
    identity,
    context: authorizeTenantContext(
      requestContext,
      identity.tenant,
      identity.role,
    ),
  };
}

export function assertDevTenantMatch(
  session: DevelopmentSession,
  claimedTenantId: unknown,
): void {
  if (
    claimedTenantId !== undefined &&
    claimedTenantId !== null &&
    (typeof claimedTenantId !== "string" ||
      claimedTenantId.length === 0 ||
      claimedTenantId !== session.context.tenantId)
  ) {
    throw new IdentityAccessError("ACCESS_DENIED", {
      reason: "tenant_scope_mismatch",
    });
  }
}

export function tenantClaimFromBody(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Reflect.get(value, "tenantId");
}

export function requireDevActorId(session: DevelopmentSession): string {
  const actorId = session.context.actor.id;
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new IdentityAccessError("ACCESS_DENIED", {
      reason: "actor_identity_required",
    });
  }
  return actorId;
}

export function developmentApiErrorStatus(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : undefined;
  if (error instanceof IdentityAccessError || typeof code === "string") {
    const identityCode =
      error instanceof IdentityAccessError ? error.code : code;
    if (
      identityCode === "ACCESS_DENIED" ||
      identityCode === "AUTHENTICATION_FAILED" ||
      identityCode === "TOKEN_INVALID" ||
      identityCode === "TOKEN_EXPIRED" ||
      identityCode === "TOKEN_REPLAYED"
    ) {
      return 403;
    }
    if (identityCode === "TENANT_SELECTION_REQUIRED") return 409;
  }
  if (code === "PERMISSION_DENIED") {
    return 403;
  }
  return 400;
}

export function safeDevelopmentSessionMetadata(
  session: DevelopmentSession,
) {
  return {
    mode: "development_verified_fixture",
    productionIdpConfigured: false,
    tenantId: session.context.tenantId,
    tenantSlug: session.identity.tenant.slug,
    principal: {
      kind: session.identity.principal.kind,
      authenticationMethod: session.identity.principal.method,
      displayName: session.identity.principal.displayName,
    },
    role: session.identity.role,
    permissions: [...session.identity.permissions].sort(),
    expiresAt: new Date(session.context.deadlineMs).toISOString(),
  };
}
