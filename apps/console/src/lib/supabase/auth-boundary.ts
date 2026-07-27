import type { SupabaseClient, User } from "@supabase/supabase-js";

export type TenantMembership = {
  tenantId: string;
  tenantSlug: string;
  tenantDisplayName: string;
  membershipId: string;
  identityRole: string;
  selected: boolean;
};

export type TenantContext = {
  selected: boolean;
  tenantId: string | null;
  membershipId: string | null;
  principalId: string | null;
  identityRole: string | null;
  appRole: string | null;
  selectionVersion: number | null;
  claimsRefreshRequired: boolean;
};

export type TenantBootstrap = {
  tenantId: string;
  membershipId: string;
  principalId: string;
  selectionVersion: number;
  created: boolean;
};

export type TenantOwnerClaim = Omit<TenantBootstrap, "created"> & {
  claimed: boolean;
};

export type TenantSelection = {
  selected: boolean;
  tenantId: string | null;
  membershipId: string | null;
  identityRole: string | null;
  appRole: string | null;
  selectionVersion: number | null;
  reason: string;
};

export type ManagedAccessState = {
  managed: boolean;
  mustChangePassword: boolean;
  email: string | null;
  identityRole: string | null;
  credentialVersion: number | null;
};

export class AuthenticationBoundaryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthenticationBoundaryError";
  }
}

export type AuthBoundaryFailure = {
  status: number;
  code: string;
};

/**
 * Honest HTTP classification for an `AuthenticationBoundaryError`.
 *
 * This class is raised for two very different situations and they must not be
 * reported the same way. A genuine sign-in problem is the caller's to fix and
 * is a 401. Everything else in this class — a supporting RPC that errored, a
 * capability whose migration is not applied, a managed account that still
 * holds a temporary password — is not an authentication failure, and reporting
 * it as one sends an operator to the sign-in page for a fault they cannot
 * resolve there.
 */
const authBoundaryFailures = new Map<string, AuthBoundaryFailure>([
  // Genuinely unauthenticated.
  ["auth.authentication_required", { status: 401, code: "authentication_required" }],
  ["auth.claims_refresh_failed", { status: 401, code: "authentication_required" }],
  ["auth.claims_refresh_incomplete", { status: 401, code: "authentication_required" }],
  // Authenticated, but this request is refused.
  ["auth.invalid_origin", { status: 403, code: "invalid_origin" }],
  ["auth.password_change_required", { status: 403, code: "password_change_required" }],
  ["auth.membership_not_active", { status: 403, code: "membership_not_active" }],
  // A dependency could not be reached. Never a client error.
  ["auth.access_state_failed", { status: 503, code: "request_failed" }],
  ["auth.context_lookup_failed", { status: 503, code: "request_failed" }],
  ["auth.membership_lookup_failed", { status: 503, code: "request_failed" }],
  ["learning.workspace_failed", { status: 503, code: "request_failed" }],
  ["learning.uploads_failed", { status: 503, code: "request_failed" }],
  ["platform.authorization_failed", { status: 503, code: "request_failed" }],
  ["analytics.request_failed", { status: 503, code: "request_failed" }],
  ["agent.configuration_failed", { status: 503, code: "request_failed" }],
]);

export function classifyAuthBoundaryError(
  error: AuthenticationBoundaryError,
): AuthBoundaryFailure {
  return (
    authBoundaryFailures.get(error.code) ?? {
      status: 503,
      code: "request_failed",
    }
  );
}

function firstRow<T>(value: T[] | T | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
}

export function safeRelativePath(
  value: string | null | undefined,
  fallback = "/onboarding",
) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    return fallback;
  }
  return value;
}

export function validateTenantBootstrapInput(input: {
  slug: string;
  displayName: string;
  assistantName: string;
  primaryColor: string;
  accentColor: string;
  region?: string;
}) {
  const slug = input.slug.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const assistantName = input.assistantName.trim();
  const region = input.region?.trim() || null;

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(slug)) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_tenant_slug",
      "Use 2–63 lowercase letters, numbers, or hyphens for the workspace URL.",
    );
  }
  if (!displayName || displayName.length > 160) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_tenant_name",
      "Workspace name must contain 1–160 characters.",
    );
  }
  if (!assistantName || assistantName.length > 80) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_assistant_name",
      "Assistant name must contain 1–80 characters.",
    );
  }
  if (
    !/^#[0-9A-Fa-f]{6}$/u.test(input.primaryColor) ||
    !/^#[0-9A-Fa-f]{6}$/u.test(input.accentColor)
  ) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_brand_color",
      "Brand colors must be six-digit hex colors.",
    );
  }

  return {
    slug,
    displayName,
    assistantName,
    primaryColor: input.primaryColor.toUpperCase(),
    accentColor: input.accentColor.toUpperCase(),
    region,
  };
}

export function assertSameOrigin(request: Request) {
  const expected = new URL(request.url).origin;
  const actual = request.headers.get("origin");
  if (actual !== expected) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_origin",
      "The request origin could not be verified.",
    );
  }
}

export async function requireVerifiedUser(
  supabase: SupabaseClient,
): Promise<User> {
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;

  if (
    error ||
    !user ||
    user.is_anonymous ||
    (!user.email_confirmed_at && !user.phone_confirmed_at)
  ) {
    throw new AuthenticationBoundaryError(
      "auth.authentication_required",
      "A verified sign-in is required.",
    );
  }

  return user;
}

export async function listTenantMemberships(
  supabase: SupabaseClient,
): Promise<TenantMembership[]> {
  const { data, error } = await supabase.rpc("auth_list_tenant_memberships");
  if (error) {
    throw new AuthenticationBoundaryError(
      "auth.membership_lookup_failed",
      "Tenant memberships could not be verified.",
    );
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    tenantId: String(row.tenant_id),
    tenantSlug: String(row.tenant_slug),
    tenantDisplayName: String(row.tenant_display_name),
    membershipId: String(row.membership_id),
    identityRole: String(row.identity_role),
    selected: row.selected === true,
  }));
}

export async function getCurrentTenantContext(
  supabase: SupabaseClient,
): Promise<TenantContext> {
  const { data, error } = await supabase.rpc("auth_current_tenant_context");
  const row = firstRow(
    data as Array<Record<string, unknown>> | Record<string, unknown> | null,
  );
  if (error || !row) {
    throw new AuthenticationBoundaryError(
      "auth.context_lookup_failed",
      "The active tenant context could not be verified.",
    );
  }

  return {
    selected: row.selected === true,
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    membershipId: row.membership_id ? String(row.membership_id) : null,
    principalId: row.principal_id ? String(row.principal_id) : null,
    identityRole: row.identity_role ? String(row.identity_role) : null,
    appRole: row.app_role ? String(row.app_role) : null,
    selectionVersion:
      row.selection_version === null || row.selection_version === undefined
        ? null
        : Number(row.selection_version),
    claimsRefreshRequired: row.claims_refresh_required === true,
  };
}

export async function getManagedAccessState(
  supabase: SupabaseClient,
): Promise<ManagedAccessState> {
  const { data, error } = await supabase.rpc("auth_current_access_state");
  const row = firstRow(
    data as Array<Record<string, unknown>> | Record<string, unknown> | null,
  );
  if (error || !row) {
    throw new AuthenticationBoundaryError(
      "auth.access_state_failed",
      "The managed account state could not be verified.",
    );
  }
  return {
    managed: row.managed === true,
    mustChangePassword: row.must_change_password === true,
    email: row.email_normalized ? String(row.email_normalized) : null,
    identityRole: row.identity_role ? String(row.identity_role) : null,
    credentialVersion:
      row.credential_version === null ||
      row.credential_version === undefined
        ? null
        : Number(row.credential_version),
  };
}

export async function bootstrapTenantOwner(
  supabase: SupabaseClient,
  input: ReturnType<typeof validateTenantBootstrapInput> & {
    requestId: string;
    traceId: string;
  },
): Promise<TenantBootstrap> {
  const { data, error } = await supabase.rpc("auth_bootstrap_tenant_owner", {
    requested_slug: input.slug,
    requested_display_name: input.displayName,
    request_id: input.requestId,
    trace_id: input.traceId,
    requested_region: input.region,
    requested_assistant_name: input.assistantName,
    requested_primary_color: input.primaryColor,
    requested_accent_color: input.accentColor,
  });
  const row = firstRow(
    data as Array<Record<string, unknown>> | Record<string, unknown> | null,
  );
  if (error || !row) {
    throw new AuthenticationBoundaryError(
      "auth.bootstrap_failed",
      "The workspace could not be created. No local fallback was used.",
    );
  }

  return {
    tenantId: String(row.tenant_id),
    membershipId: String(row.membership_id),
    principalId: String(row.principal_id),
    selectionVersion: Number(row.selection_version),
    created: row.created === true,
  };
}

export async function claimPreprovisionedTenantOwner(
  supabase: SupabaseClient,
  input: {
    slug: string;
    claimToken: string;
    requestId: string;
    traceId: string;
  },
): Promise<TenantOwnerClaim> {
  const slug = input.slug.trim().toLowerCase();
  const claimToken = input.claimToken.trim();
  if (
    !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(slug) ||
    claimToken.length < 32 ||
    claimToken.length > 256
  ) {
    throw new AuthenticationBoundaryError(
      "auth.invalid_owner_claim",
      "The owner claim is invalid.",
    );
  }
  const { data, error } = await supabase.rpc(
    "auth_claim_preprovisioned_tenant_owner",
    {
      requested_slug: slug,
      claim_token: claimToken,
      request_id: input.requestId,
      trace_id: input.traceId,
    },
  );
  const row = firstRow(
    data as Array<Record<string, unknown>> | Record<string, unknown> | null,
  );
  if (error || !row || row.claimed !== true) {
    throw new AuthenticationBoundaryError(
      "auth.owner_claim_failed",
      "The owner claim could not be verified.",
    );
  }
  return {
    tenantId: String(row.tenant_id),
    membershipId: String(row.membership_id),
    principalId: String(row.principal_id),
    selectionVersion: Number(row.selection_version),
    claimed: true,
  };
}

export async function selectTenant(
  supabase: SupabaseClient,
  input: { tenantId: string; requestId: string; traceId: string },
): Promise<TenantSelection> {
  const { data, error } = await supabase.rpc("auth_select_tenant", {
    target_tenant_id: input.tenantId,
    request_id: input.requestId,
    trace_id: input.traceId,
  });
  const row = firstRow(
    data as Array<Record<string, unknown>> | Record<string, unknown> | null,
  );
  if (error || !row) {
    throw new AuthenticationBoundaryError(
      "auth.tenant_selection_failed",
      "The tenant selection could not be verified.",
    );
  }

  const selection = {
    selected: row.selected === true,
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    membershipId: row.membership_id ? String(row.membership_id) : null,
    identityRole: row.identity_role ? String(row.identity_role) : null,
    appRole: row.app_role ? String(row.app_role) : null,
    selectionVersion:
      row.selection_version === null || row.selection_version === undefined
        ? null
        : Number(row.selection_version),
    reason: String(row.reason ?? "unknown"),
  };

  if (!selection.selected) {
    throw new AuthenticationBoundaryError(
      "auth.membership_not_active",
      "That tenant membership is no longer active.",
    );
  }
  return selection;
}

export async function refreshClaimsWhenRequired(
  supabase: SupabaseClient,
): Promise<TenantContext> {
  let context = await getCurrentTenantContext(supabase);
  if (!context.claimsRefreshRequired) {
    return context;
  }

  const { error } = await supabase.auth.refreshSession();
  if (error) {
    throw new AuthenticationBoundaryError(
      "auth.claims_refresh_failed",
      "The tenant was selected, but the authenticated session could not be refreshed.",
    );
  }
  await requireVerifiedUser(supabase);
  context = await getCurrentTenantContext(supabase);
  if (context.claimsRefreshRequired) {
    throw new AuthenticationBoundaryError(
      "auth.claims_refresh_incomplete",
      "The authenticated session does not yet contain the selected tenant claims.",
    );
  }
  return context;
}
