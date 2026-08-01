import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createCheckoutSession,
  readBillingConfig,
  reportMeterEvent,
  resetBillingConfigCacheForTests,
  verifyStripeWebhookSignature,
} from "../src/lib/billing/stripe";
import { mapStripeEventToIngestParams } from "../src/lib/billing/webhook-events";

/**
 * Covers the two places PLAN.md S10.3's non-negotiables are actually
 * enforced in TypeScript: webhook signature verification (never trust an
 * unsigned or forged Stripe event) and the event -> ingest-params mapping
 * (never touch a tenant this platform cannot identify).
 */

function sign(secret: string, timestamp: number, payload: string): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

test("a correctly signed, fresh webhook body verifies", () => {
  const secret = "whsec_test_secret_value";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed" });
  const now = Math.floor(Date.now() / 1000);
  const header = sign(secret, now, payload);
  assert.equal(
    verifyStripeWebhookSignature(payload, header, secret, now),
    true,
  );
});

test("a tampered payload fails verification even with a valid-looking header", () => {
  const secret = "whsec_test_secret_value";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed" });
  const now = Math.floor(Date.now() / 1000);
  const header = sign(secret, now, payload);
  const tampered = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted" });
  assert.equal(
    verifyStripeWebhookSignature(tampered, header, secret, now),
    false,
  );
});

test("the wrong signing secret fails verification", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed" });
  const now = Math.floor(Date.now() / 1000);
  const header = sign("whsec_wrong", now, payload);
  assert.equal(
    verifyStripeWebhookSignature(payload, header, "whsec_test_secret_value", now),
    false,
  );
});

test("a stale timestamp is rejected as a replay", () => {
  const secret = "whsec_test_secret_value";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed" });
  const now = Math.floor(Date.now() / 1000);
  const staleTimestamp = now - 60 * 60; // one hour old
  const header = sign(secret, staleTimestamp, payload);
  assert.equal(
    verifyStripeWebhookSignature(payload, header, secret, now),
    false,
  );
});

test("a missing signature header is rejected, not treated as unsigned-but-fine", () => {
  const secret = "whsec_test_secret_value";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed" });
  assert.equal(verifyStripeWebhookSignature(payload, null, secret), false);
});

test("readBillingConfig returns null when Stripe is not configured", () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_METERED_PRICE_ID;
    delete process.env.STRIPE_METER_EVENT_NAME;
    resetBillingConfigCacheForTests();
    assert.equal(readBillingConfig(), null);
  } finally {
    process.env = originalEnv;
    resetBillingConfigCacheForTests();
  }
});

test("readBillingConfig maps configured plan prices", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value";
    process.env.STRIPE_METERED_PRICE_ID = "price_metered";
    process.env.STRIPE_METER_EVENT_NAME = "learningbot_usage";
    process.env.STRIPE_PRICE_STARTER = "price_starter";
    process.env.STRIPE_PRICE_GROWTH = "price_growth";
    delete process.env.STRIPE_PRICE_ENTERPRISE;
    resetBillingConfigCacheForTests();
    const config = readBillingConfig();
    assert.notEqual(config, null);
    assert.equal(config?.pricesByPlan.starter, "price_starter");
    assert.equal(config?.pricesByPlan.growth, "price_growth");
    assert.equal(config?.pricesByPlan.enterprise, undefined);
    assert.equal(config?.plansByPrice.get("price_starter"), "starter");
  } finally {
    process.env = originalEnv;
    resetBillingConfigCacheForTests();
  }
});

test("checkout enables Stripe Tax and usage is reported as idempotent micro-unit meter events", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value";
    process.env.STRIPE_METERED_PRICE_ID = "price_metered";
    process.env.STRIPE_METER_EVENT_NAME = "learningbot_usage";
    process.env.STRIPE_PRICE_STARTER = "price_starter";
    resetBillingConfigCacheForTests();
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      const checkout = String(input).endsWith("/checkout/sessions");
      return new Response(
        JSON.stringify(
          checkout
            ? { id: "cs_test_1", url: "https://checkout.stripe.test/session" }
            : { object: "billing.meter_event" },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await createCheckoutSession({
      tenantId: "11111111-1111-4111-8111-111111111111",
      plan: "starter",
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
    });
    await reportMeterEvent({
      stripeCustomerId: "cus_123",
      billedMicro: 12_345,
      identifier: "11111111-1111-4111-8111-111111111111",
      occurredAtEpochSeconds: 1_700_000_000,
    });

    assert.equal(requests[0]?.body.get("automatic_tax[enabled]"), "true");
    assert.equal(requests[0]?.body.has("automatic_tax"), false);
    assert.match(requests[1]?.url ?? "", /\/billing\/meter_events$/u);
    assert.equal(requests[1]?.body.get("event_name"), "learningbot_usage");
    assert.equal(requests[1]?.body.get("payload[stripe_customer_id]"), "cus_123");
    assert.equal(requests[1]?.body.get("payload[value]"), "12345");
    assert.equal(
      requests[1]?.body.get("identifier"),
      "11111111-1111-4111-8111-111111111111",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    resetBillingConfigCacheForTests();
  }
});

function fixtureConfig() {
  resetBillingConfigCacheForTests();
  process.env.STRIPE_SECRET_KEY = "sk_test_abc";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_value";
  process.env.STRIPE_METERED_PRICE_ID = "price_metered";
  process.env.STRIPE_METER_EVENT_NAME = "learningbot_usage";
  process.env.STRIPE_PRICE_STARTER = "price_starter";
  process.env.STRIPE_PRICE_GROWTH = "price_growth";
  process.env.STRIPE_PRICE_ENTERPRISE = "price_enterprise";
  const config = readBillingConfig();
  if (config === null) throw new Error("fixture config failed to build");
  return config;
}

test("checkout.session.completed maps client_reference_id to the target tenant", () => {
  const config = fixtureConfig();
  const params = mapStripeEventToIngestParams(
    {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          client_reference_id: "11111111-1111-4111-8111-111111111111",
          customer: "cus_123",
          subscription: "sub_123",
        },
      },
    },
    config,
  );
  assert.notEqual(params, null);
  assert.equal(params?.targetTenantId, "11111111-1111-4111-8111-111111111111");
  assert.equal(params?.stripeCustomerId, "cus_123");
  assert.equal(params?.stripeSubscriptionId, "sub_123");
});

test("a non-subscription checkout session is ignored", () => {
  const config = fixtureConfig();
  const params = mapStripeEventToIngestParams(
    {
      id: "evt_checkout_payment",
      type: "checkout.session.completed",
      data: { object: { mode: "payment", client_reference_id: "irrelevant" } },
    },
    config,
  );
  assert.equal(params, null);
});

test("customer.subscription.updated resolves the plan and the metered item", () => {
  const config = fixtureConfig();
  const params = mapStripeEventToIngestParams(
    {
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          current_period_end: 1_800_000_000,
          cancel_at_period_end: false,
          items: {
            data: [
              { id: "si_plan", price: { id: "price_growth" } },
              { id: "si_metered", price: { id: "price_metered" } },
            ],
          },
        },
      },
    },
    config,
  );
  assert.notEqual(params, null);
  assert.equal(params?.planKey, "growth");
  assert.equal(params?.stripeMeteredItemId, "si_metered");
  assert.equal(params?.stripePriceId, "price_growth");
  assert.equal(params?.subscriptionStatus, "active");
  assert.equal(params?.dunningSignal, null);
});

test("invoice.payment_failed carries the grace-period dunning signal", () => {
  const config = fixtureConfig();
  const params = mapStripeEventToIngestParams(
    {
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_123", subscription: "sub_123" } },
    },
    config,
  );
  assert.equal(params?.dunningSignal, "payment_failed");
});

test("invoice.payment_succeeded clears the dunning signal", () => {
  const config = fixtureConfig();
  const params = mapStripeEventToIngestParams(
    {
      id: "evt_invoice_paid",
      type: "invoice.payment_succeeded",
      data: { object: { customer: "cus_123", subscription: "sub_123" } },
    },
    config,
  );
  assert.equal(params?.dunningSignal, "payment_succeeded");
});

test("an event type this platform does not act on is ignored", () => {
  const config = fixtureConfig();
  const params = mapStripeEventToIngestParams(
    {
      id: "evt_unhandled",
      type: "payment_method.attached",
      data: { object: { id: "pm_123" } },
    },
    config,
  );
  assert.equal(params, null);
});
