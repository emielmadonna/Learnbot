import type {
  PlatformPermission,
  PlatformRole,
} from "@course-ai/application-services";
import { IdentityAccessError } from "./errors.js";

export const ROLE_PERMISSIONS: Readonly<
  Record<PlatformRole, readonly PlatformPermission[]>
> = {
  platform_admin: [
    "tenant.read", "tenant.write", "branding.read", "branding.write",
    "context.read", "context.write", "course.read", "course.write",
    "source.read", "source.write", "job.read", "job.write",
    "conversation.read", "conversation.write", "attachment.read",
    "attachment.write", "audit.read", "cost.read", "cost.write",
  ],
  tenant_owner: [
    "tenant.read", "tenant.write", "branding.read", "branding.write",
    "context.read", "context.write", "course.read", "course.write",
    "source.read", "source.write", "job.read", "job.write",
    "conversation.read", "conversation.write", "attachment.read",
    "attachment.write", "audit.read", "cost.read", "cost.write",
  ],
  tenant_admin: [
    "tenant.read", "tenant.write", "branding.read", "branding.write",
    "context.read", "context.write", "course.read", "course.write",
    "source.read", "source.write", "job.read", "job.write",
    "conversation.read", "conversation.write", "attachment.read",
    "attachment.write", "audit.read", "cost.read", "cost.write",
  ],
  creator: [
    "tenant.read", "branding.read", "context.read", "context.write",
    "course.read", "course.write", "source.read", "source.write",
    "job.read", "job.write", "conversation.read", "attachment.read",
  ],
  teacher: [
    "tenant.read", "branding.read", "context.read", "context.write",
    "course.read", "course.write", "source.read", "job.read",
    "conversation.read", "attachment.read",
  ],
  student: [
    "tenant.read", "branding.read", "context.read", "course.read",
    "conversation.read", "conversation.write", "attachment.read",
    "attachment.write",
  ],
  service: [
    "tenant.read", "branding.read", "context.read", "course.read",
    "source.read", "job.read", "job.write", "conversation.read",
    "conversation.write", "attachment.read", "attachment.write", "cost.write",
  ],
};

export const SERVICE_SCOPE_PERMISSIONS: Readonly<
  Record<string, readonly PlatformPermission[]>
> = {
  "tenant:read": ["tenant.read"],
  "branding:read": ["branding.read"],
  "context:read": ["context.read"],
  "course:read": ["course.read"],
  "source:read": ["source.read"],
  "job:read": ["job.read"],
  "job:write": ["job.write"],
  "conversation:read": ["conversation.read"],
  "conversation:write": ["conversation.write"],
  "attachment:read": ["attachment.read"],
  "attachment:write": ["attachment.write"],
  "cost:write": ["cost.write"],
};

export function permissionsForRole(
  role: PlatformRole,
): ReadonlySet<PlatformPermission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function permissionsForServiceScopes(
  scopes: ReadonlySet<string>,
): ReadonlySet<PlatformPermission> {
  const permissions = new Set<PlatformPermission>();
  for (const scope of scopes) {
    for (const permission of SERVICE_SCOPE_PERMISSIONS[scope] ?? []) {
      permissions.add(permission);
    }
  }
  return permissions;
}

export function assertIdentityPermission(
  permissions: ReadonlySet<PlatformPermission>,
  permission: PlatformPermission,
): void {
  if (!permissions.has(permission)) {
    throw new IdentityAccessError("ACCESS_DENIED", { permission });
  }
}

const DELEGABLE_ROLES: Readonly<Record<PlatformRole, readonly PlatformRole[]>> = {
  platform_admin: ["tenant_owner", "tenant_admin", "creator", "teacher", "student", "service"],
  tenant_owner: ["tenant_admin", "creator", "teacher", "student"],
  tenant_admin: ["creator", "teacher", "student"],
  creator: [],
  teacher: [],
  student: [],
  service: [],
};

export function assertCanAssignRole(
  actorRole: PlatformRole,
  targetRole: PlatformRole,
): void {
  if (!DELEGABLE_ROLES[actorRole].includes(targetRole)) {
    throw new IdentityAccessError("ACCESS_DENIED", { reason: "role_assignment_denied" });
  }
}
