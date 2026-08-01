import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";

export const platformSectionKeys = [
  "agent",
  "insights",
  "course",
  "people",
  "platform",
  // `widget` joined the durable catalogue in 20260731081000. Before that it
  // was a console PanelKey with no row behind it, so the tenant's own
  // site-facing surface was the one section a platform administrator could
  // not flag per client.
  "widget",
  "settings",
] as const;

export type PlatformSectionKey = (typeof platformSectionKeys)[number];

/**
 * What a client workspace may change for itself.
 *
 * A capability is not a section: sections decide which dock entries exist,
 * capabilities decide which controls inside them a tenant administrator may
 * operate. Until 20260731081000 there was no record for this at all — the
 * ability to rename the bot, rewrite the welcome copy, change voice, choose a
 * model or invite people came entirely from role membership, so it could not
 * be restricted for one client without restricting the role everywhere.
 */
export const platformCapabilityKeys = [
  "bot_identity",
  "welcome_message",
  "voice_answer_length",
  "model_choice",
  "invite_members",
] as const;

export type PlatformCapabilityKey = (typeof platformCapabilityKeys)[number];

export const platformTenantStatuses = ["active", "suspended"] as const;

export type PlatformTenantStatus = (typeof platformTenantStatuses)[number];

export const platformClientPlans = [
  "unconfirmed",
  "starter",
  "growth",
  "enterprise",
] as const;

export type PlatformClientPlan = (typeof platformClientPlans)[number];

export const platformClaimStatuses = [
  "pending",
  "claimed",
  "revoked",
  "expired",
] as const;

export type PlatformClaimStatus = (typeof platformClaimStatuses)[number];

/**
 * The workspace slug grammar is owned by the database: public.tenants enforces
 * `^[a-z0-9][a-z0-9-]{1,62}$` and platform_admin_create_tenant re-checks it.
 * This mirror exists so the console can tell an author what is wrong before a
 * round trip — it never replaces the server-side check.
 */
export const platformSlugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/u;

export function normalizePlatformSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
}

export function isPlatformSlug(value: unknown): value is string {
  return typeof value === "string" && platformSlugPattern.test(value);
}

export type TenantSection = {
  sectionKey: PlatformSectionKey;
  enabled: boolean;
  updatedAt: string | null;
};

export type TenantCapability = {
  capabilityKey: PlatformCapabilityKey;
  enabled: boolean;
  updatedAt: string | null;
};

export type PlatformTenantSummary = {
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  region: string | null;
  assistantName: string;
  courses: number;
  publishedCourses: number;
  members: number;
  sources: number;
  knowledgeChunks: number;
  updatedAt: string;
};

export type PlatformOverview = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  totals: {
    tenants: number;
    activeTenants: number;
    courses: number;
    members: number;
    sources: number;
    knowledgeChunks: number;
  };
  tenants: PlatformTenantSummary[];
};

export type PlatformTenantDetail = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  tenant: {
    tenantId: string;
    slug: string;
    displayName: string;
    status: string;
    region: string | null;
    assistantName: string;
    createdAt: string;
    updatedAt: string;
  };
  sections: TenantSection[];
  counts: {
    members: number;
    admins: number;
    courses: number;
    publishedCourses: number;
    sources: number;
    knowledgeChunks: number;
    conversations: number;
  };
  readiness: {
    onboardingStatus: string;
    launchedAt: string | null;
    hasBranding: boolean;
    hasPublishedCourse: boolean;
    hasKnowledge: boolean;
    hasActiveMembers: boolean;
  };
  lastActivityAt: string | null;
  activePlatformSessions: Array<{
    sessionId: string;
    enteredAt: string;
    isCaller: boolean;
  }>;
};

export type TenantSectionUpdate = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  section: TenantSection;
};

export type PlatformTenantCapabilities = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  tenantId: string;
  capabilities: TenantCapability[];
};

export type TenantCapabilityUpdate = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  capability: TenantCapability;
};

export type PlatformTenantStatusChange = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  previousStatus: string;
  status: string;
  changed: boolean;
};

export type PlatformTenantEntry = {
  ok: true;
  dataMode: "durable";
  sessionId: string;
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  membershipId: string;
  identityRole: string;
  selectionVersion: number;
  enteredAt: string;
  claimsRefreshRequired: boolean;
};

export type PlatformTenantExit = {
  ok: true;
  dataMode: "durable";
  exited: boolean;
  tenantId: string | null;
  restoredPreviousTenant?: boolean;
  previousTenantId?: string | null;
};

export type TenantSections = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  generatedAt: string;
  sections: TenantSection[];
};

/**
 * The owner claim token is readable exactly once, in the response to the call
 * that minted it. Only its SHA-256 digest is ever stored, so `token` is null on
 * a replayed creation and on every listing — there is no path back to it.
 */
export type PlatformClientClaimSecret = {
  claimId: string;
  status: PlatformClaimStatus;
  expiresAt: string | null;
  token: string | null;
};

export type PlatformClientCreation = {
  ok: true;
  dataMode: "durable";
  created: boolean;
  generatedAt: string;
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  region: string | null;
  plan: string;
  assistantName: string;
  claim: PlatformClientClaimSecret | null;
};

export type PlatformClientClaim = {
  claimId: string;
  tenantId: string;
  slug: string;
  displayName: string;
  tenantStatus: string;
  status: PlatformClaimStatus;
  expiresAt: string | null;
  createdAt: string | null;
  claimedAt: string | null;
  provisionedByPlatform: boolean;
};

export type PlatformClientClaims = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  claims: PlatformClientClaim[];
};

export type PlatformClientClaimRevocation = {
  ok: true;
  dataMode: "durable";
  claimId: string;
  tenantId: string;
  status: PlatformClaimStatus;
  expiresAt: string | null;
};

export class PlatformRpcError extends Error {
  constructor(readonly code: string) {
    super(`Platform request denied: ${code}`);
    this.name = "PlatformRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requirePlatformRpcSuccess(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new PlatformRpcError("invalid_response");
  if (value.ok !== true) {
    throw new PlatformRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  return value;
}

export function isPlatformSectionKey(
  value: unknown,
): value is PlatformSectionKey {
  return (
    typeof value === "string" &&
    (platformSectionKeys as readonly string[]).includes(value)
  );
}

export function isPlatformCapabilityKey(
  value: unknown,
): value is PlatformCapabilityKey {
  return (
    typeof value === "string" &&
    (platformCapabilityKeys as readonly string[]).includes(value)
  );
}

export function isPlatformTenantStatus(
  value: unknown,
): value is PlatformTenantStatus {
  return (
    typeof value === "string" &&
    (platformTenantStatuses as readonly string[]).includes(value)
  );
}

export function isPlatformClientPlan(
  value: unknown,
): value is PlatformClientPlan {
  return (
    typeof value === "string" &&
    (platformClientPlans as readonly string[]).includes(value)
  );
}

// Fails closed: a status this console does not recognize is never shown as an
// outstanding, actionable claim.
function claimStatus(value: unknown): PlatformClaimStatus {
  return typeof value === "string" &&
    (platformClaimStatuses as readonly string[]).includes(value)
    ? (value as PlatformClaimStatus)
    : "expired";
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseTenantSections(value: unknown): TenantSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((section) => isPlatformSectionKey(section.sectionKey))
    .map((section) => ({
      sectionKey: section.sectionKey as PlatformSectionKey,
      enabled: section.enabled === true,
      updatedAt: optionalText(section.updatedAt),
    }));
}

/**
 * A capability key this console does not recognize is dropped rather than
 * rendered as an unlabelled toggle. The same fail-closed rule as
 * `parseTenantSections`: the browser accepts exactly the shapes the server
 * produced and nothing else.
 */
export function parseTenantCapabilities(value: unknown): TenantCapability[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((capability) => isPlatformCapabilityKey(capability.capabilityKey))
    .map((capability) => ({
      capabilityKey: capability.capabilityKey as PlatformCapabilityKey,
      enabled: capability.enabled === true,
      updatedAt: optionalText(capability.updatedAt),
    }));
}

export function parsePlatformTenantCapabilities(
  value: unknown,
): PlatformTenantCapabilities {
  const result = requirePlatformRpcSuccess(value);
  if (result.dataMode !== "durable" || !Array.isArray(result.capabilities)) {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    tenantId: String(result.tenantId ?? ""),
    capabilities: parseTenantCapabilities(result.capabilities),
  };
}

export function parseTenantCapabilityUpdate(
  value: unknown,
): TenantCapabilityUpdate {
  const result = requirePlatformRpcSuccess(value);
  const capability = isRecord(result.capability) ? result.capability : null;
  if (!capability || !isPlatformCapabilityKey(capability.capabilityKey)) {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: String(result.tenantId ?? ""),
    capability: {
      capabilityKey: capability.capabilityKey,
      enabled: capability.enabled === true,
      updatedAt: optionalText(capability.updatedAt),
    },
  };
}

export function parsePlatformOverview(value: unknown): PlatformOverview {
  const result = requirePlatformRpcSuccess(value);
  if (result.dataMode !== "durable" || !Array.isArray(result.tenants)) {
    throw new PlatformRpcError("invalid_response");
  }
  const totals = isRecord(result.totals) ? result.totals : {};
  return {
    ok: true,
    dataMode: "durable",
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    totals: {
      tenants: number(totals.tenants),
      activeTenants: number(totals.activeTenants),
      courses: number(totals.courses),
      members: number(totals.members),
      sources: number(totals.sources),
      knowledgeChunks: number(totals.knowledgeChunks),
    },
    tenants: result.tenants.filter(isRecord).map((tenant) => ({
      tenantId: String(tenant.tenantId ?? ""),
      slug: String(tenant.slug ?? ""),
      displayName: String(tenant.displayName ?? "Unnamed workspace"),
      status: String(tenant.status ?? "unknown"),
      region: optionalText(tenant.region),
      assistantName: String(tenant.assistantName ?? "Corso"),
      courses: number(tenant.courses),
      publishedCourses: number(tenant.publishedCourses),
      members: number(tenant.members),
      sources: number(tenant.sources),
      knowledgeChunks: number(tenant.knowledgeChunks),
      updatedAt: String(tenant.updatedAt ?? ""),
    })),
  };
}

export function parsePlatformTenantDetail(
  value: unknown,
): PlatformTenantDetail {
  const result = requirePlatformRpcSuccess(value);
  if (result.dataMode !== "durable" || !isRecord(result.tenant)) {
    throw new PlatformRpcError("invalid_response");
  }
  const tenant = result.tenant;
  const counts = isRecord(result.counts) ? result.counts : {};
  const readiness = isRecord(result.readiness) ? result.readiness : {};
  const sessions = Array.isArray(result.activePlatformSessions)
    ? result.activePlatformSessions
    : [];
  return {
    ok: true,
    dataMode: "durable",
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    tenant: {
      tenantId: String(tenant.tenantId ?? ""),
      slug: String(tenant.slug ?? ""),
      displayName: String(tenant.displayName ?? "Unnamed workspace"),
      status: String(tenant.status ?? "unknown"),
      region: optionalText(tenant.region),
      assistantName: String(tenant.assistantName ?? "Corso"),
      createdAt: String(tenant.createdAt ?? ""),
      updatedAt: String(tenant.updatedAt ?? ""),
    },
    sections: parseTenantSections(result.sections),
    counts: {
      members: number(counts.members),
      admins: number(counts.admins),
      courses: number(counts.courses),
      publishedCourses: number(counts.publishedCourses),
      sources: number(counts.sources),
      knowledgeChunks: number(counts.knowledgeChunks),
      conversations: number(counts.conversations),
    },
    readiness: {
      onboardingStatus: String(readiness.onboardingStatus ?? "not_started"),
      launchedAt: optionalText(readiness.launchedAt),
      hasBranding: readiness.hasBranding === true,
      hasPublishedCourse: readiness.hasPublishedCourse === true,
      hasKnowledge: readiness.hasKnowledge === true,
      hasActiveMembers: readiness.hasActiveMembers === true,
    },
    lastActivityAt: optionalText(result.lastActivityAt),
    activePlatformSessions: sessions.filter(isRecord).map((session) => ({
      sessionId: String(session.sessionId ?? ""),
      enteredAt: String(session.enteredAt ?? ""),
      isCaller: session.isCaller === true,
    })),
  };
}

export function parseTenantSectionUpdate(value: unknown): TenantSectionUpdate {
  const result = requirePlatformRpcSuccess(value);
  const section = isRecord(result.section) ? result.section : null;
  if (!section || !isPlatformSectionKey(section.sectionKey)) {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: String(result.tenantId ?? ""),
    section: {
      sectionKey: section.sectionKey,
      enabled: section.enabled === true,
      updatedAt: optionalText(section.updatedAt),
    },
  };
}

export function parsePlatformTenantStatusChange(
  value: unknown,
): PlatformTenantStatusChange {
  const result = requirePlatformRpcSuccess(value);
  return {
    ok: true,
    dataMode: "durable",
    tenantId: String(result.tenantId ?? ""),
    previousStatus: String(result.previousStatus ?? "unknown"),
    status: String(result.status ?? "unknown"),
    changed: result.changed === true,
  };
}

export function parsePlatformTenantEntry(value: unknown): PlatformTenantEntry {
  const result = requirePlatformRpcSuccess(value);
  if (typeof result.tenantId !== "string") {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    sessionId: String(result.sessionId ?? ""),
    tenantId: result.tenantId,
    slug: String(result.slug ?? ""),
    displayName: String(result.displayName ?? ""),
    status: String(result.status ?? "unknown"),
    membershipId: String(result.membershipId ?? ""),
    identityRole: String(result.identityRole ?? ""),
    selectionVersion: number(result.selectionVersion),
    enteredAt: String(result.enteredAt ?? ""),
    claimsRefreshRequired: result.claimsRefreshRequired === true,
  };
}

export function parsePlatformTenantExit(value: unknown): PlatformTenantExit {
  const result = requirePlatformRpcSuccess(value);
  return {
    ok: true,
    dataMode: "durable",
    exited: result.exited === true,
    tenantId: optionalText(result.tenantId),
    restoredPreviousTenant: result.restoredPreviousTenant === true,
    previousTenantId: optionalText(result.previousTenantId),
  };
}

export function parseTenantSectionsResult(value: unknown): TenantSections {
  const result = requirePlatformRpcSuccess(value);
  if (result.dataMode !== "durable") {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: String(result.tenantId ?? ""),
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    sections: parseTenantSections(result.sections),
  };
}

export function parsePlatformClientCreation(
  value: unknown,
): PlatformClientCreation {
  const result = requirePlatformRpcSuccess(value);
  if (result.dataMode !== "durable" || typeof result.tenantId !== "string") {
    throw new PlatformRpcError("invalid_response");
  }
  const claim = isRecord(result.claim) ? result.claim : null;
  return {
    ok: true,
    dataMode: "durable",
    created: result.created === true,
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    tenantId: result.tenantId,
    slug: String(result.slug ?? ""),
    displayName: String(result.displayName ?? "Unnamed workspace"),
    status: String(result.status ?? "unknown"),
    region: optionalText(result.region),
    plan: String(result.plan ?? "unconfirmed"),
    assistantName: String(result.assistantName ?? "Corso"),
    claim:
      claim === null
        ? null
        : {
            claimId: String(claim.claimId ?? ""),
            status: claimStatus(claim.status),
            expiresAt: optionalText(claim.expiresAt),
            token: optionalText(claim.token),
          },
  };
}

export function parsePlatformClientClaims(
  value: unknown,
): PlatformClientClaims {
  const result = requirePlatformRpcSuccess(value);
  if (result.dataMode !== "durable" || !Array.isArray(result.claims)) {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    claims: result.claims.filter(isRecord).map((claim) => ({
      claimId: String(claim.claimId ?? ""),
      tenantId: String(claim.tenantId ?? ""),
      slug: String(claim.slug ?? ""),
      displayName: String(claim.displayName ?? "Unnamed workspace"),
      tenantStatus: String(claim.tenantStatus ?? "unknown"),
      status: claimStatus(claim.status),
      expiresAt: optionalText(claim.expiresAt),
      createdAt: optionalText(claim.createdAt),
      claimedAt: optionalText(claim.claimedAt),
      provisionedByPlatform: claim.provisionedByPlatform === true,
    })),
  };
}

export function parsePlatformClientClaimRevocation(
  value: unknown,
): PlatformClientClaimRevocation {
  const result = requirePlatformRpcSuccess(value);
  if (typeof result.claimId !== "string") {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    claimId: result.claimId,
    tenantId: String(result.tenantId ?? ""),
    status: claimStatus(result.status),
    expiresAt: optionalText(result.expiresAt),
  };
}

async function callPlatformRpc(
  supabase: SupabaseClient,
  name: string,
  input: Record<string, unknown> = {},
) {
  const response = await supabase.rpc(name, input);
  if (response.error) {
    throw new PlatformRpcError("request_failed");
  }
  return response.data as unknown;
}

export async function isPlatformAdmin(
  supabase: SupabaseClient,
): Promise<boolean> {
  const response = await supabase.rpc("platform_admin_is_authorized");
  if (response.error) {
    throw new AuthenticationBoundaryError(
      "platform.authorization_failed",
      "The platform administrator authorization could not be verified.",
    );
  }
  return response.data === true;
}

export async function getPlatformOverview(
  supabase: SupabaseClient,
): Promise<PlatformOverview> {
  return parsePlatformOverview(
    await callPlatformRpc(supabase, "platform_admin_overview"),
  );
}

export async function getPlatformTenantDetail(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<PlatformTenantDetail> {
  return parsePlatformTenantDetail(
    await callPlatformRpc(supabase, "platform_admin_tenant_detail", {
      target_tenant_id: tenantId,
    }),
  );
}

export async function setTenantSection(
  supabase: SupabaseClient,
  input: {
    tenantId: string;
    sectionKey: PlatformSectionKey;
    enabled: boolean;
  },
): Promise<TenantSectionUpdate> {
  return parseTenantSectionUpdate(
    await callPlatformRpc(supabase, "platform_admin_set_tenant_section", {
      target_tenant_id: input.tenantId,
      target_section_key: input.sectionKey,
      target_enabled: input.enabled,
    }),
  );
}

export async function getPlatformTenantCapabilities(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<PlatformTenantCapabilities> {
  return parsePlatformTenantCapabilities(
    await callPlatformRpc(supabase, "platform_admin_tenant_capabilities", {
      target_tenant_id: tenantId,
    }),
  );
}

export async function setTenantCapability(
  supabase: SupabaseClient,
  input: {
    tenantId: string;
    capabilityKey: PlatformCapabilityKey;
    enabled: boolean;
  },
): Promise<TenantCapabilityUpdate> {
  return parseTenantCapabilityUpdate(
    await callPlatformRpc(supabase, "platform_admin_set_tenant_capability", {
      target_tenant_id: input.tenantId,
      target_capability_key: input.capabilityKey,
      target_enabled: input.enabled,
    }),
  );
}

export async function setPlatformTenantStatus(
  supabase: SupabaseClient,
  input: { tenantId: string; status: PlatformTenantStatus },
): Promise<PlatformTenantStatusChange> {
  return parsePlatformTenantStatusChange(
    await callPlatformRpc(supabase, "platform_admin_set_tenant_status", {
      target_tenant_id: input.tenantId,
      target_status: input.status,
    }),
  );
}

export async function enterPlatformTenant(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<PlatformTenantEntry> {
  return parsePlatformTenantEntry(
    await callPlatformRpc(supabase, "platform_admin_enter_tenant", {
      target_tenant_id: tenantId,
    }),
  );
}

export async function exitPlatformTenant(
  supabase: SupabaseClient,
): Promise<PlatformTenantExit> {
  return parsePlatformTenantExit(
    await callPlatformRpc(supabase, "platform_admin_exit_tenant"),
  );
}

export async function getTenantSections(
  supabase: SupabaseClient,
): Promise<TenantSections> {
  return parseTenantSectionsResult(
    await callPlatformRpc(supabase, "tenant_get_sections"),
  );
}

/**
 * Creates a client workspace and mints its one-time owner claim. The returned
 * `claim.token` is the only disclosure of that secret; a replay of the same
 * `idempotencyKey` returns the same workspace with a null token.
 */
export async function createPlatformClient(
  supabase: SupabaseClient,
  input: {
    slug: string;
    displayName: string;
    assistantName: string;
    primaryColor: string;
    accentColor: string;
    idempotencyKey: string;
    region?: string | null;
    plan?: PlatformClientPlan;
  },
): Promise<PlatformClientCreation> {
  return parsePlatformClientCreation(
    await callPlatformRpc(supabase, "platform_admin_create_tenant", {
      requested_slug: input.slug,
      requested_display_name: input.displayName,
      requested_assistant_name: input.assistantName,
      requested_primary_color: input.primaryColor,
      requested_accent_color: input.accentColor,
      requested_idempotency_key: input.idempotencyKey,
      requested_region: input.region ?? null,
      requested_plan: input.plan ?? "unconfirmed",
    }),
  );
}

export async function getPlatformClientClaims(
  supabase: SupabaseClient,
): Promise<PlatformClientClaims> {
  return parsePlatformClientClaims(
    await callPlatformRpc(supabase, "platform_admin_list_client_claims"),
  );
}

export async function revokePlatformClientClaim(
  supabase: SupabaseClient,
  claimId: string,
): Promise<PlatformClientClaimRevocation> {
  return parsePlatformClientClaimRevocation(
    await callPlatformRpc(supabase, "platform_admin_revoke_client_claim", {
      target_claim_id: claimId,
    }),
  );
}

export function platformOperationKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}
