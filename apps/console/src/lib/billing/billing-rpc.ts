import type { SupabaseClient } from "@supabase/supabase-js";
import { PlatformRpcError } from "../supabase/platform-rpc";

/* ------------------------------------------------------------------ *
 * Billing, margin and Stripe entitlement — the platform-admin surface.
 *
 * Every read here goes through a SECURITY DEFINER RPC gated by
 * `platform_admin_is_authorized()`. Non-negotiable per PLAN.md S10.2: true
 * provider cost, margin and billed amount are platform-admin-only. Nothing
 * in this module, or in the route that calls it, is reachable by a signed-in
 * creator — `tenant_get_billing_summary` (their own plan and price, never
 * cost or margin) is a separate RPC this module deliberately does not wrap,
 * because no creator-facing surface is in scope for this change.
 * ------------------------------------------------------------------ */

export const billingPlans = [
  "unconfirmed",
  "starter",
  "growth",
  "enterprise",
] as const;
export type BillingPlan = (typeof billingPlans)[number];

export const billingSubscriptionStatuses = [
  "none",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
] as const;
export type BillingSubscriptionStatus =
  (typeof billingSubscriptionStatuses)[number];

export const billingDunningStages = ["none", "grace", "dark"] as const;
export type BillingDunningStage = (typeof billingDunningStages)[number];

export const billingSectionSources = [
  "unset",
  "subscription",
  "manual_override",
] as const;
export type BillingSectionSource = (typeof billingSectionSources)[number];

export function isBillingPlan(value: unknown): value is BillingPlan {
  return (
    typeof value === "string" &&
    (billingPlans as readonly string[]).includes(value)
  );
}

export function isBillingSubscriptionStatus(
  value: unknown,
): value is BillingSubscriptionStatus {
  return (
    typeof value === "string" &&
    (billingSubscriptionStatuses as readonly string[]).includes(value)
  );
}

export type BillingTenantSummary = {
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  plan: BillingPlan;
  planSource: "manual" | "stripe";
  subscriptionStatus: BillingSubscriptionStatus;
  dunningStage: BillingDunningStage;
  gracePeriodEndsAt: string | null;
  modelTier: string | null;
  currency: string;
  windowTrueCostMicro: number;
  windowBilledMicro: number;
  windowUnreportedMicro: number;
  marginMultiplier: number;
  fixedMarkupMicro: number;
  floorMicro: number;
  dailyBudgetMicro: number | null;
  monthlyBudgetMicro: number | null;
  monthSpendMicro: number;
  monthBudgetHeadroomMicro: number;
  hasStripeCustomer: boolean;
  hasStripeSubscription: boolean;
};

export type BillingOverview = {
  ok: true;
  dataMode: "durable";
  windowDays: number;
  microUnitsPerMajorUnit: number;
  generatedAt: string;
  totals: {
    tenants: number;
    windowTrueCostMicro: number;
    windowBilledMicro: number;
    windowUnreportedMicro: number;
  };
  tenants: BillingTenantSummary[];
};

export type BillingSectionDetail = {
  sectionKey: string;
  enabled: boolean;
  source: BillingSectionSource;
  updatedAt: string | null;
};

export type BillingUsageReportEntry = {
  costEntryId: string;
  capability: string;
  modelKey: string | null;
  costMicro: number;
  billedMicro: number;
  reportedAt: string;
};

export type BillingTenantDetail = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  windowDays: number;
  tenant: {
    tenantId: string;
    slug: string;
    displayName: string;
    status: string;
  };
  subscription: {
    plan: BillingPlan;
    planSource: "manual" | "stripe";
    subscriptionStatus: BillingSubscriptionStatus;
    dunningStage: BillingDunningStage;
    gracePeriodEndsAt: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripePriceId: string | null;
    hasMeteredItem: boolean;
    lastStripeEventAt: string | null;
  };
  margin: {
    marginMultiplier: number;
    fixedMarkupMicro: number;
    floorMicro: number;
    currency: string;
  };
  budget: {
    dailyBudgetMicro: number | null;
    monthlyBudgetMicro: number | null;
    daySpendMicro: number;
    monthSpendMicro: number;
  };
  usage: {
    windowTrueCostMicro: number;
    windowCalls: number;
    recentReports: BillingUsageReportEntry[];
  };
  modelTier: string | null;
  sections: BillingSectionDetail[];
};

export type BillingMarginPolicyUpdate = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  marginMultiplier: number;
  fixedMarkupMicro: number;
  floorMicro: number;
  currency: string;
  recordVersion: number;
};

export type BillingSubscriptionUpdate = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  plan: BillingPlan;
  planSource: "manual" | "stripe";
  subscriptionStatus: BillingSubscriptionStatus;
  dunningStage: BillingDunningStage;
};

export type BillingSectionOverrideClear = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  section: BillingSectionDetail;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireSuccess(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PlatformRpcError("invalid_response");
  if (value.ok !== true) {
    throw new PlatformRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  return value;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function plan(value: unknown): BillingPlan {
  return isBillingPlan(value) ? value : "unconfirmed";
}

function planSource(value: unknown): "manual" | "stripe" {
  return value === "stripe" ? "stripe" : "manual";
}

function subscriptionStatus(value: unknown): BillingSubscriptionStatus {
  return isBillingSubscriptionStatus(value) ? value : "none";
}

function dunningStage(value: unknown): BillingDunningStage {
  return (billingDunningStages as readonly string[]).includes(
    String(value ?? ""),
  )
    ? (value as BillingDunningStage)
    : "none";
}

function sectionSource(value: unknown): BillingSectionSource {
  return (billingSectionSources as readonly string[]).includes(
    String(value ?? ""),
  )
    ? (value as BillingSectionSource)
    : "unset";
}

function parseSection(value: unknown): BillingSectionDetail | null {
  if (!isRecord(value) || typeof value.sectionKey !== "string") return null;
  return {
    sectionKey: value.sectionKey,
    enabled: value.enabled === true,
    source: sectionSource(value.source),
    updatedAt: optionalText(value.updatedAt),
  };
}

function parseTenantSummary(value: unknown): BillingTenantSummary | null {
  if (!isRecord(value) || typeof value.tenantId !== "string") return null;
  return {
    tenantId: value.tenantId,
    slug: String(value.slug ?? ""),
    displayName: String(value.displayName ?? "Unnamed workspace"),
    status: String(value.status ?? "unknown"),
    plan: plan(value.plan),
    planSource: planSource(value.planSource),
    subscriptionStatus: subscriptionStatus(value.subscriptionStatus),
    dunningStage: dunningStage(value.dunningStage),
    gracePeriodEndsAt: optionalText(value.gracePeriodEndsAt),
    modelTier: optionalText(value.modelTier),
    currency: String(value.currency ?? "USD"),
    windowTrueCostMicro: number(value.windowTrueCostMicro),
    windowBilledMicro: number(value.windowBilledMicro),
    windowUnreportedMicro: number(value.windowUnreportedMicro),
    marginMultiplier: number(value.marginMultiplier),
    fixedMarkupMicro: number(value.fixedMarkupMicro),
    floorMicro: number(value.floorMicro),
    dailyBudgetMicro: nullableNumber(value.dailyBudgetMicro),
    monthlyBudgetMicro: nullableNumber(value.monthlyBudgetMicro),
    monthSpendMicro: number(value.monthSpendMicro),
    monthBudgetHeadroomMicro: number(value.monthBudgetHeadroomMicro),
    hasStripeCustomer: value.hasStripeCustomer === true,
    hasStripeSubscription: value.hasStripeSubscription === true,
  };
}

export function parseBillingOverview(value: unknown): BillingOverview {
  const result = requireSuccess(value);
  if (result.dataMode !== "durable" || !Array.isArray(result.tenants)) {
    throw new PlatformRpcError("invalid_response");
  }
  const totals = isRecord(result.totals) ? result.totals : {};
  return {
    ok: true,
    dataMode: "durable",
    windowDays: number(result.windowDays),
    microUnitsPerMajorUnit: number(result.microUnitsPerMajorUnit) || 1_000_000,
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    totals: {
      tenants: number(totals.tenants),
      windowTrueCostMicro: number(totals.windowTrueCostMicro),
      windowBilledMicro: number(totals.windowBilledMicro),
      windowUnreportedMicro: number(totals.windowUnreportedMicro),
    },
    tenants: result.tenants.map(parseTenantSummary).filter((entry) => entry !== null),
  };
}

export function parseBillingTenantDetail(value: unknown): BillingTenantDetail {
  const result = requireSuccess(value);
  if (
    result.dataMode !== "durable" ||
    !isRecord(result.tenant) ||
    !isRecord(result.subscription) ||
    !isRecord(result.margin) ||
    !isRecord(result.budget) ||
    !isRecord(result.usage)
  ) {
    throw new PlatformRpcError("invalid_response");
  }
  const tenant = result.tenant;
  const subscription = result.subscription;
  const margin = result.margin;
  const budget = result.budget;
  const usage = result.usage;
  const reports = Array.isArray(usage.recentReports)
    ? usage.recentReports
    : [];
  return {
    ok: true,
    dataMode: "durable",
    generatedAt:
      typeof result.generatedAt === "string"
        ? result.generatedAt
        : new Date().toISOString(),
    windowDays: number(result.windowDays),
    tenant: {
      tenantId: String(tenant.tenantId ?? ""),
      slug: String(tenant.slug ?? ""),
      displayName: String(tenant.displayName ?? "Unnamed workspace"),
      status: String(tenant.status ?? "unknown"),
    },
    subscription: {
      plan: plan(subscription.plan),
      planSource: planSource(subscription.planSource),
      subscriptionStatus: subscriptionStatus(subscription.subscriptionStatus),
      dunningStage: dunningStage(subscription.dunningStage),
      gracePeriodEndsAt: optionalText(subscription.gracePeriodEndsAt),
      currentPeriodEnd: optionalText(subscription.currentPeriodEnd),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd === true,
      stripeCustomerId: optionalText(subscription.stripeCustomerId),
      stripeSubscriptionId: optionalText(subscription.stripeSubscriptionId),
      stripePriceId: optionalText(subscription.stripePriceId),
      hasMeteredItem: subscription.hasMeteredItem === true,
      lastStripeEventAt: optionalText(subscription.lastStripeEventAt),
    },
    margin: {
      marginMultiplier: number(margin.marginMultiplier),
      fixedMarkupMicro: number(margin.fixedMarkupMicro),
      floorMicro: number(margin.floorMicro),
      currency: String(margin.currency ?? "USD"),
    },
    budget: {
      dailyBudgetMicro: nullableNumber(budget.dailyBudgetMicro),
      monthlyBudgetMicro: nullableNumber(budget.monthlyBudgetMicro),
      daySpendMicro: number(budget.daySpendMicro),
      monthSpendMicro: number(budget.monthSpendMicro),
    },
    usage: {
      windowTrueCostMicro: number(usage.windowTrueCostMicro),
      windowCalls: number(usage.windowCalls),
      recentReports: reports.filter(isRecord).map((entry) => ({
        costEntryId: String(entry.costEntryId ?? ""),
        capability: String(entry.capability ?? ""),
        modelKey: optionalText(entry.modelKey),
        costMicro: number(entry.costMicro),
        billedMicro: number(entry.billedMicro),
        reportedAt: String(entry.reportedAt ?? ""),
      })),
    },
    modelTier: optionalText(result.modelTier),
    sections: Array.isArray(result.sections)
      ? result.sections.map(parseSection).filter((entry) => entry !== null)
      : [],
  };
}

export function parseMarginPolicyUpdate(
  value: unknown,
): BillingMarginPolicyUpdate {
  const result = requireSuccess(value);
  if (typeof result.tenantId !== "string") {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: result.tenantId,
    marginMultiplier: number(result.marginMultiplier),
    fixedMarkupMicro: number(result.fixedMarkupMicro),
    floorMicro: number(result.floorMicro),
    currency: String(result.currency ?? "USD"),
    recordVersion: number(result.recordVersion),
  };
}

export function parseSubscriptionUpdate(
  value: unknown,
): BillingSubscriptionUpdate {
  const result = requireSuccess(value);
  if (typeof result.tenantId !== "string") {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: result.tenantId,
    plan: plan(result.plan),
    planSource: planSource(result.planSource),
    subscriptionStatus: subscriptionStatus(result.subscriptionStatus),
    dunningStage: dunningStage(result.dunningStage),
  };
}

export function parseSectionOverrideClear(
  value: unknown,
): BillingSectionOverrideClear {
  const result = requireSuccess(value);
  const section = parseSection(result.section);
  if (typeof result.tenantId !== "string" || section === null) {
    throw new PlatformRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: result.tenantId,
    section,
  };
}

async function callBillingRpc(
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

export async function getBillingOverview(
  supabase: SupabaseClient,
  windowDays: number,
): Promise<BillingOverview> {
  return parseBillingOverview(
    await callBillingRpc(supabase, "platform_admin_billing_overview", {
      window_days: windowDays,
    }),
  );
}

export async function getBillingTenantDetail(
  supabase: SupabaseClient,
  tenantId: string,
  windowDays: number,
): Promise<BillingTenantDetail> {
  return parseBillingTenantDetail(
    await callBillingRpc(supabase, "platform_admin_tenant_billing_detail", {
      target_tenant_id: tenantId,
      window_days: windowDays,
    }),
  );
}

export async function setTenantMarginPolicy(
  supabase: SupabaseClient,
  input: {
    tenantId: string;
    marginMultiplier: number;
    fixedMarkupMicro: number;
    floorMicro: number;
  },
): Promise<BillingMarginPolicyUpdate> {
  return parseMarginPolicyUpdate(
    await callBillingRpc(
      supabase,
      "platform_admin_set_tenant_margin_policy",
      {
        target_tenant_id: input.tenantId,
        margin_multiplier: input.marginMultiplier,
        fixed_markup_micro: input.fixedMarkupMicro,
        floor_micro: input.floorMicro,
      },
    ),
  );
}

export async function setTenantSubscription(
  supabase: SupabaseClient,
  input: {
    tenantId: string;
    plan: BillingPlan;
    subscriptionStatus: BillingSubscriptionStatus;
    note?: string | null;
  },
): Promise<BillingSubscriptionUpdate> {
  return parseSubscriptionUpdate(
    await callBillingRpc(supabase, "platform_admin_set_tenant_subscription", {
      target_tenant_id: input.tenantId,
      plan: input.plan,
      subscription_status: input.subscriptionStatus,
      note: input.note ?? null,
    }),
  );
}

export async function clearTenantSectionOverride(
  supabase: SupabaseClient,
  input: { tenantId: string; sectionKey: string },
): Promise<BillingSectionOverrideClear> {
  return parseSectionOverrideClear(
    await callBillingRpc(
      supabase,
      "platform_admin_clear_tenant_section_override",
      {
        target_tenant_id: input.tenantId,
        target_section_key: input.sectionKey,
      },
    ),
  );
}
