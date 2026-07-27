import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../lib/supabase/learning-route";
import { PlatformRpcError, isPlatformAdmin } from "../../../lib/supabase/platform-rpc";
import {
  clearTenantSectionOverride,
  getBillingOverview,
  getBillingTenantDetail,
  isBillingPlan,
  isBillingSubscriptionStatus,
  setTenantMarginPolicy,
  setTenantSubscription,
} from "../../../lib/billing/billing-rpc";
import {
  createBillingPortalSession,
  createCheckoutSession,
  readBillingConfig,
} from "../../../lib/billing/stripe";

/**
 * The platform-admin billing surface: true cost, margin, billed amount, plan,
 * subscription state and budget headroom per tenant (PLAN.md S10.4), plus the
 * writes that steer them. Authorization is re-checked here exactly like
 * `/api/platform` — the shell only offers the section when
 * `platform_admin_is_authorized` already said yes, and this route checks it
 * again before touching anything.
 *
 * Stripe itself is optional. `checkout.create` and `portal.create` return a
 * clear `stripe_not_configured` response when the required environment
 * variables are absent, rather than throwing — every other action here
 * (margin policy, manual subscription overrides, section-override clearing,
 * the overview and detail reads) works with or without Stripe configured,
 * because a platform admin must always be able to comp or correct an
 * account even during a Stripe outage.
 */

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["invalid_request", 400],
  ["tenant_not_found", 404],
  ["section_not_found", 404],
  ["stripe_not_configured", 503],
  ["plan_not_configured", 503],
  ["stripe_customer_missing", 409],
  ["request_failed", 503],
  ["invalid_response", 502],
]);

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return response({ ok: false, code: failure.code }, failure.status);
  }
  if (error instanceof PlatformRpcError) {
    return response(
      { ok: false, code: error.code },
      statusByCode.get(error.code) ?? 400,
    );
  }
  if (error instanceof Error && statusByCode.has(error.message)) {
    return response(
      { ok: false, code: error.message },
      statusByCode.get(error.message) ?? 400,
    );
  }
  return response({ ok: false, code: "request_failed" }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireTenantId(value: unknown) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new PlatformRpcError("invalid_request");
  }
  return value;
}

function requireFiniteNumber(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new PlatformRpcError("invalid_request");
  }
  return parsed;
}

function boundedWindowDays(value: string | null) {
  const parsed = Number(value ?? "30");
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(Math.max(Math.trunc(parsed), 1), 180);
}

async function billingClient(request: Request, mutation: boolean) {
  if (mutation) assertSameOrigin(request);
  const supabase = await authenticatedLearningClient(request, { mutation });
  if (!(await isPlatformAdmin(supabase))) {
    throw new PlatformRpcError("access_denied");
  }
  return supabase;
}

export async function GET(request: Request) {
  try {
    const supabase = await billingClient(request, false);
    const url = new URL(request.url);
    const windowDays = boundedWindowDays(url.searchParams.get("windowDays"));
    const requestedTenantId = url.searchParams.get("tenantId");
    if (requestedTenantId !== null) {
      return response(
        await getBillingTenantDetail(
          supabase,
          requireTenantId(requestedTenantId),
          windowDays,
        ),
      );
    }
    return response(await getBillingOverview(supabase, windowDays));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await billingClient(request, true);
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new PlatformRpcError("invalid_request");
    const action = typeof input.action === "string" ? input.action : "";

    if (action === "margin.set") {
      return response(
        await setTenantMarginPolicy(supabase, {
          tenantId: requireTenantId(input.tenantId),
          marginMultiplier: requireFiniteNumber(input.marginMultiplier, 0, 100),
          fixedMarkupMicro: requireFiniteNumber(
            input.fixedMarkupMicro,
            0,
            1_000_000_000,
          ),
          floorMicro: requireFiniteNumber(input.floorMicro, 0, 1_000_000_000),
        }),
      );
    }

    if (action === "subscription.set") {
      if (
        !isBillingPlan(input.plan) ||
        !isBillingSubscriptionStatus(input.subscriptionStatus)
      ) {
        throw new PlatformRpcError("invalid_request");
      }
      return response(
        await setTenantSubscription(supabase, {
          tenantId: requireTenantId(input.tenantId),
          plan: input.plan,
          subscriptionStatus: input.subscriptionStatus,
          note: typeof input.note === "string" ? input.note.slice(0, 500) : null,
        }),
      );
    }

    if (action === "section.override.clear") {
      if (typeof input.sectionKey !== "string") {
        throw new PlatformRpcError("invalid_request");
      }
      return response(
        await clearTenantSectionOverride(supabase, {
          tenantId: requireTenantId(input.tenantId),
          sectionKey: input.sectionKey,
        }),
      );
    }

    if (action === "checkout.create") {
      if (!isBillingPlan(input.plan) || input.plan === "unconfirmed") {
        throw new PlatformRpcError("invalid_request");
      }
      const config = readBillingConfig();
      if (config === null) throw new Error("stripe_not_configured");
      const tenantId = requireTenantId(input.tenantId);
      const detail = await getBillingTenantDetail(supabase, tenantId, 1);
      const origin = new URL(request.url).origin;
      const session = await createCheckoutSession({
        tenantId,
        plan: input.plan,
        successUrl: `${origin}/app/platform?id=${tenantId}&billing=checkout_complete`,
        cancelUrl: `${origin}/app/platform?id=${tenantId}&billing=checkout_canceled`,
        customerEmail: null,
      });
      return response({
        ok: true,
        dataMode: "durable",
        tenantId,
        displayName: detail.tenant.displayName,
        checkoutUrl: session.url,
      });
    }

    if (action === "portal.create") {
      const tenantId = requireTenantId(input.tenantId);
      const detail = await getBillingTenantDetail(supabase, tenantId, 1);
      if (detail.subscription.stripeCustomerId === null) {
        throw new Error("stripe_customer_missing");
      }
      const config = readBillingConfig();
      if (config === null) throw new Error("stripe_not_configured");
      const origin = new URL(request.url).origin;
      const session = await createBillingPortalSession({
        stripeCustomerId: detail.subscription.stripeCustomerId,
        returnUrl: `${origin}/app/platform?id=${tenantId}`,
      });
      return response({
        ok: true,
        dataMode: "durable",
        tenantId,
        portalUrl: session.url,
      });
    }

    throw new PlatformRpcError("invalid_request");
  } catch (error) {
    return errorResponse(error);
  }
}
