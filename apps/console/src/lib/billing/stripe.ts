import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingPlan } from "./billing-rpc";

/**
 * A thin Stripe REST wrapper. No `stripe` package dependency: every call here
 * is a single documented endpoint, and avoiding the SDK keeps this change
 * inside its file scope without touching `package.json`. Nothing here ever
 * sees, logs or stores a card number, CVC or expiry — every interaction is
 * hosted Checkout, the hosted Billing Portal, or a server-to-server API call
 * that only ever carries identifiers and amounts (PLAN.md S10.3).
 *
 * `readBillingConfig()` is the single source of truth for whether Stripe is
 * configured. Every route that touches Stripe calls it first and returns a
 * clear `stripe_not_configured` response instead of throwing — a missing key
 * degrades the billing surface, it never breaks the console or, more
 * importantly, a learner's conversation (non-negotiable: billing failure
 * must not stop learning).
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2024-06-20";
// Stripe's webhook timestamp tolerance. Anything older is a replay, not a
// retry, and is rejected the same way Stripe's own libraries do.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type BillingConfig = {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly meteredPriceId: string;
  readonly pricesByPlan: Partial<Record<BillingPlan, string>>;
  readonly plansByPrice: Map<string, BillingPlan>;
};

let cachedConfig: BillingConfig | null | undefined;

function planPriceEnv(plan: BillingPlan): string | undefined {
  switch (plan) {
    case "starter":
      return process.env.STRIPE_PRICE_STARTER;
    case "growth":
      return process.env.STRIPE_PRICE_GROWTH;
    case "enterprise":
      return process.env.STRIPE_PRICE_ENTERPRISE;
    default:
      return undefined;
  }
}

/**
 * Reads and validates the Stripe configuration. Returns `null` — never
 * throws — when anything required is missing, so every caller can degrade to
 * a "billing not configured" response instead of a 500.
 */
export function readBillingConfig(): BillingConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const meteredPriceId = process.env.STRIPE_METERED_PRICE_ID?.trim() ?? "";

  if (
    !secretKey.startsWith("sk_") ||
    webhookSecret.length < 16 ||
    meteredPriceId.length === 0
  ) {
    cachedConfig = null;
    return cachedConfig;
  }

  const pricesByPlan: Partial<Record<BillingPlan, string>> = {};
  const plansByPrice = new Map<string, BillingPlan>();
  for (const plan of ["starter", "growth", "enterprise"] as const) {
    const priceId = planPriceEnv(plan)?.trim();
    if (priceId) {
      pricesByPlan[plan] = priceId;
      plansByPrice.set(priceId, plan);
    }
  }

  cachedConfig = {
    secretKey,
    webhookSecret,
    meteredPriceId,
    pricesByPlan,
    plansByPrice,
  };
  return cachedConfig;
}

/** Test-only escape hatch; production code never needs to call this. */
export function resetBillingConfigCacheForTests() {
  cachedConfig = undefined;
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Stripe API request failed (${status})`);
    this.name = "StripeApiError";
  }
}

function toFormBody(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

async function stripeRequest(
  config: BillingConfig,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
): Promise<Record<string, unknown>> {
  const url =
    method === "GET" && params
      ? `${STRIPE_API_BASE}${path}?${toFormBody(params)}`
      : `${STRIPE_API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(method === "POST"
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: method === "POST" && params ? toFormBody(params) : null,
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new StripeApiError(response.status, text.slice(0, 2000));
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StripeApiError(response.status, "invalid_json_response");
  }
}

/**
 * Hosted Checkout only — never a card form. `client_reference_id` carries the
 * tenant id so the webhook can map the resulting subscription back without a
 * separate lookup table; the metered usage price is always attached
 * alongside the flat plan price so usage reporting has a subscription item to
 * report against from day one.
 */
export async function createCheckoutSession(input: {
  readonly tenantId: string;
  readonly plan: BillingPlan;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly customerEmail?: string | null;
}): Promise<{ readonly url: string; readonly sessionId: string }> {
  const config = readBillingConfig();
  if (config === null) {
    throw new Error("stripe_not_configured");
  }
  const planPriceId = config.pricesByPlan[input.plan];
  if (!planPriceId) {
    throw new Error("plan_not_configured");
  }

  const params: Record<string, string> = {
    mode: "subscription",
    client_reference_id: input.tenantId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "line_items[0][price]": planPriceId,
    "line_items[0][quantity]": "1",
    "line_items[1][price]": config.meteredPriceId,
    "subscription_data[metadata][tenant_id]": input.tenantId,
    "subscription_data[metadata][plan]": input.plan,
    // Stripe Tax, not hand-rolled VAT (PLAN.md S10.3).
    automatic_tax: "true",
  };
  if (input.customerEmail) {
    params.customer_email = input.customerEmail;
  }
  const session = await stripeRequest(config, "POST", "/checkout/sessions", params);
  const url = session.url;
  const id = session.id;
  if (typeof url !== "string" || typeof id !== "string") {
    throw new StripeApiError(502, "missing_checkout_url");
  }
  return { url, sessionId: id };
}

/** The hosted Billing Portal — the only place a subscription is managed. */
export async function createBillingPortalSession(input: {
  readonly stripeCustomerId: string;
  readonly returnUrl: string;
}): Promise<{ readonly url: string }> {
  const config = readBillingConfig();
  if (config === null) {
    throw new Error("stripe_not_configured");
  }
  const session = await stripeRequest(config, "POST", "/billing_portal/sessions", {
    customer: input.stripeCustomerId,
    return_url: input.returnUrl,
  });
  const url = session.url;
  if (typeof url !== "string") {
    throw new StripeApiError(502, "missing_portal_url");
  }
  return { url };
}

/**
 * Reports one row of metered usage. `quantity` is whole minor currency units
 * (cents), matching a metered Price configured at $0.01/unit — see the
 * migration comment on `app_private.billing_micro_to_minor` for the
 * conversion. `action: "increment"` composes correctly with the idempotent
 * per-row commit in SQL: each Stripe call reports exactly one `cost_ledger`
 * row's billed amount, never a running total.
 */
export async function reportUsageRecord(input: {
  readonly stripeSubscriptionItemId: string;
  readonly quantityMinorUnits: number;
  readonly occurredAtEpochSeconds: number;
}): Promise<{ readonly usageRecordId: string | null }> {
  const config = readBillingConfig();
  if (config === null) {
    throw new Error("stripe_not_configured");
  }
  const record = await stripeRequest(
    config,
    "POST",
    `/subscription_items/${encodeURIComponent(input.stripeSubscriptionItemId)}/usage_records`,
    {
      quantity: Math.max(0, Math.round(input.quantityMinorUnits)),
      timestamp: Math.max(0, Math.round(input.occurredAtEpochSeconds)),
      action: "increment",
    },
  );
  const id = record.id;
  return { usageRecordId: typeof id === "string" ? id : null };
}

/**
 * Verifies a Stripe webhook signature by hand — the same construction
 * Stripe's own SDKs use (`t=<timestamp>,v1=<hex hmac>` over
 * `${timestamp}.${payload}`, HMAC-SHA256 with the webhook signing secret) —
 * without adding the `stripe` package as a dependency. Every failure path
 * (missing header, malformed header, stale timestamp, mismatched digest)
 * returns `false`; an unsigned or forged webhook is a way to grant a free
 * plan, so this is deny-by-default (non-negotiable #3).
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;
  let timestamp: number | null = null;
  const candidateDigests: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2).map((piece) => piece.trim());
    if (key === "t" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1" && value) {
      candidateDigests.push(value);
    }
  }
  if (timestamp === null || candidateDigests.length === 0) return false;
  if (Math.abs(nowEpochSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return candidateDigests.some((candidate) => {
    if (!/^[0-9a-f]+$/iu.test(candidate)) return false;
    const candidateBuffer = Buffer.from(candidate, "hex");
    if (candidateBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(candidateBuffer, expectedBuffer);
  });
}
