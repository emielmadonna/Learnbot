import type { RequestContext, TenantContext } from "@course-ai/contracts";
import { ApplicationError } from "./errors.js";
import type {
  AuthorizedTenantContext,
  PlatformPermission,
  PlatformRole,
} from "./types.js";

const ROLE_PERMISSIONS: Readonly<
  Record<PlatformRole, readonly PlatformPermission[]>
> = {
  platform_admin: [
    "tenant.read",
    "tenant.write",
    "branding.read",
    "branding.write",
    "context.read",
    "context.write",
    "course.read",
    "course.write",
    "source.read",
    "source.write",
    "job.read",
    "job.write",
    "conversation.read",
    "conversation.write",
    "attachment.read",
    "attachment.write",
    "audit.read",
    "cost.read",
    "cost.write",
  ],
  tenant_owner: [
    "tenant.read",
    "tenant.write",
    "branding.read",
    "branding.write",
    "context.read",
    "context.write",
    "course.read",
    "course.write",
    "source.read",
    "source.write",
    "job.read",
    "job.write",
    "conversation.read",
    "conversation.write",
    "attachment.read",
    "attachment.write",
    "audit.read",
    "cost.read",
    "cost.write",
  ],
  tenant_admin: [
    "tenant.read",
    "tenant.write",
    "branding.read",
    "branding.write",
    "context.read",
    "context.write",
    "course.read",
    "course.write",
    "source.read",
    "source.write",
    "job.read",
    "job.write",
    "conversation.read",
    "conversation.write",
    "attachment.read",
    "attachment.write",
    "audit.read",
    "cost.read",
    "cost.write",
  ],
  creator: [
    "tenant.read",
    "branding.read",
    "context.read",
    "context.write",
    "course.read",
    "course.write",
    "source.read",
    "source.write",
    "job.read",
    "job.write",
    "conversation.read",
    "attachment.read",
  ],
  teacher: [
    "tenant.read",
    "branding.read",
    "context.read",
    "context.write",
    "course.read",
    "course.write",
    "source.read",
    "job.read",
    "conversation.read",
    "attachment.read",
  ],
  student: [
    "tenant.read",
    "branding.read",
    "context.read",
    "course.read",
    "conversation.read",
    "conversation.write",
    "attachment.read",
    "attachment.write",
  ],
  service: [
    "tenant.read",
    "branding.read",
    "context.read",
    "course.read",
    "source.read",
    "job.read",
    "job.write",
    "conversation.read",
    "conversation.write",
    "attachment.read",
    "attachment.write",
    "cost.write",
  ],
};

export function authorizeTenantContext(
  request: RequestContext,
  tenant: TenantContext,
  role: PlatformRole,
  nowMs: number = Date.now(),
): AuthorizedTenantContext {
  if (
    request.tenantId.trim().length === 0 ||
    tenant.tenantId.trim().length === 0 ||
    request.tenantId !== tenant.tenantId
  ) {
    throw new ApplicationError(
      "INVALID_CONTEXT",
      "Trusted request and tenant scopes must match.",
    );
  }
  if (request.deadlineMs <= nowMs) {
    throw new ApplicationError("INVALID_CONTEXT", "The request has expired.");
  }
  if (tenant.status !== "active") {
    throw new ApplicationError(
      "TENANT_INACTIVE",
      "The tenant is not active.",
      { status: tenant.status },
    );
  }
  if (
    request.actor.type !== "system" &&
    (request.actor.id === undefined || request.actor.id.trim().length === 0)
  ) {
    throw new ApplicationError(
      "INVALID_CONTEXT",
      "An authenticated actor is required.",
    );
  }
  if (request.actor.role !== undefined && request.actor.role !== role) {
    throw new ApplicationError(
      "INVALID_CONTEXT",
      "The actor role does not match the authorized role.",
    );
  }
  return {
    ...request,
    tenant,
    role,
    permissions: new Set(ROLE_PERMISSIONS[role]),
  };
}

export function assertPermission(
  context: AuthorizedTenantContext,
  permission: PlatformPermission,
): void {
  if (!context.permissions.has(permission)) {
    throw new ApplicationError(
      "PERMISSION_DENIED",
      "The actor is not allowed to perform this operation.",
      { permission },
    );
  }
}
