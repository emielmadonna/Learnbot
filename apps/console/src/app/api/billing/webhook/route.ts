import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "../../../../lib/supabase/config";
import { mapStripeEventToIngestParams } from "../../../../lib/billing/webhook-events";
import { readBillingConfig, verifyStripeWebhookSignature } from "../../../../lib/billing/stripe";

/**
 * The Stripe webhook receiver.
 *
 * No user session reaches this route — it is Stripe calling this server, not
 * a browser — so authority is two independent things, both required:
 *
 *   1. `verifyStripeWebhookSignature` over the *raw, unparsed* request body.
 *      The body is read as text before anything is parsed as JSON, because
 *      the signature covers the exact bytes Stripe sent; parsing first and
 *      re-serializing would silently break verification. An unsigned or
 *      forged request is rejected before its content is even trusted enough
 *      to log the Stripe event id (non-negotiable #3).
 *   2. The `billing.stripe.webhook` operation token, checked again inside
 *      `billing_webhook_ingest` itself — the same defense-in-depth the
 *      embedding worker and telemetry drain already use, so a compromised
 *      webhook secret alone still cannot write through this path.
 *
 * Stripe retries undelivered webhooks; `billing_webhook_ingest` dedupes on
 * the Stripe event id in `public.billing_stripe_events`; a retried delivery
 * is a 200 with `replayed: true` and no repeated side effect.
 *
 * If `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are not configured, this
 * route returns 503 rather than 500 or a silent 200 — a real event would
 * otherwise be dropped without any signal that billing is unconfigured.
 */

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
  const config = readBillingConfig();
  if (config === null) {
    return json({ ok: false, code: "stripe_not_configured" }, 503);
  }

  const operationToken =
    process.env.LEARNINGBOT_BILLING_WEBHOOK_OPERATION_TOKEN?.trim() ?? "";
  if (operationToken.length < 32) {
    return json({ ok: false, code: "worker_not_configured" }, 503);
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");
  if (
    !verifyStripeWebhookSignature(rawBody, signatureHeader, config.webhookSecret)
  ) {
    return json({ ok: false, code: "invalid_signature" }, 400);
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, code: "invalid_payload" }, 400);
  }
  if (!isRecord(event)) {
    return json({ ok: false, code: "invalid_payload" }, 400);
  }

  const ingestParams = mapStripeEventToIngestParams(event, config);
  if (ingestParams === null) {
    // Recognized-but-unhandled or genuinely unrecognized event types are
    // acknowledged without touching the database — there is nothing to
    // dedupe because nothing was applied.
    return json({ ok: true, dataMode: "durable", ignored: true });
  }

  let supabaseUrl: string;
  let publishableKey: string;
  try {
    const supabaseConfig = readSupabasePublicConfig();
    supabaseUrl = supabaseConfig.url;
    publishableKey = supabaseConfig.publishableKey;
  } catch {
    return json({ ok: false, code: "provider_not_configured" }, 503);
  }
  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  const ingest = await supabase.rpc("billing_webhook_ingest", {
    operation_token: operationToken,
    stripe_event_id: ingestParams.stripeEventId,
    event_type: ingestParams.eventType,
    target_tenant_id: ingestParams.targetTenantId,
    stripe_customer_id: ingestParams.stripeCustomerId,
    stripe_subscription_id: ingestParams.stripeSubscriptionId,
    stripe_price_id: ingestParams.stripePriceId,
    stripe_metered_item_id: ingestParams.stripeMeteredItemId,
    plan_key: ingestParams.planKey,
    subscription_status: ingestParams.subscriptionStatus,
    current_period_end: ingestParams.currentPeriodEnd,
    cancel_at_period_end: ingestParams.cancelAtPeriodEnd,
    dunning_signal: ingestParams.dunningSignal,
  });

  if (ingest.error || !isRecord(ingest.data) || ingest.data.ok !== true) {
    // A 500 here is deliberate: Stripe will retry, and the ingest RPC is
    // idempotent, so a transient database error should be retried rather
    // than silently accepted as handled.
    return json({ ok: false, code: "ingest_failed" }, 500);
  }

  return json(ingest.data);
}
