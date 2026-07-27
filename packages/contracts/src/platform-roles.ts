/**
 * Platform role and permission vocabulary.
 *
 * Salvaged from `packages/application-services/src/types.ts` when that package
 * was deleted (2026-07-26). The package itself was eleven in-memory `Map`
 * repositories with zero importers; every invariant it claimed is enforced
 * durably in SQL. These two unions were the only part worth keeping.
 *
 * **These names are a vocabulary, not an authorization decision.** The running
 * authorization boundary is Postgres: `app_private.authoring_rpc_context`
 * (`20260725122000`), the `SECURITY DEFINER` RPCs and forced RLS. Roles are
 * read from `public.identity_memberships`, never from a JWT — the access-token
 * hook deliberately strips top-level `tenant_id`/`app_role` (`0011:917-921`).
 * Do not re-derive a permission set in TypeScript and treat it as a gate.
 *
 * Note also that the SQL role vocabulary is narrower: `0011:74-78` maps both
 * `creator` and `teacher` onto the `client_viewer` RLS role. Anything matching
 * on these strings must confirm which vocabulary it is in.
 */

export const PLATFORM_ROLES = [
  "platform_admin",
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
  "service",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
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
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function isPlatformPermission(
  value: string,
): value is PlatformPermission {
  return (PLATFORM_PERMISSIONS as readonly string[]).includes(value);
}
