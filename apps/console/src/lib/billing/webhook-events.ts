import type { BillingConfig } from "./stripe";

/**
 * Maps a subset of Stripe webhook event types onto the parameters
 * `billing_webhook_ingest` expects. Event types this platform does not act
 * on (payment methods, disputes, most `customer.*` housekeeping, and so on)
 * map to `null` and the route never calls the database for them — the
 * dedupe/idempotency guarantee in SQL only needs to cover events that are
 * actually applied.
 */

export type BillingIngestParams = {
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly targetTenantId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripePriceId: string | null;
  readonly stripeMeteredItemId: string | null;
  readonly planKey: string | null;
  readonly subscriptionStatus: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean | null;
  readonly dunningSignal: "payment_failed" | "payment_succeeded" | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochToIso(value: unknown): string | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** A Stripe Subscription object's line items, resolved into plan + metered item. */
function readSubscriptionItems(
  subscription: Record<string, unknown>,
  config: BillingConfig,
): { readonly priceId: string | null; readonly planKey: string | null; readonly meteredItemId: string | null } {
  const items = subscription.items;
  const data =
    isRecord(items) && Array.isArray(items.data) ? items.data : [];
  let priceId: string | null = null;
  let planKey: string | null = null;
  let meteredItemId: string | null = null;
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const price = entry.price;
    const priceIdValue = isRecord(price) ? text(price.id) : null;
    const itemId = text(entry.id);
    if (priceIdValue && priceIdValue === config.meteredPriceId) {
      meteredItemId = itemId;
      continue;
    }
    if (priceIdValue) {
      priceId = priceIdValue;
      const mapped = config.plansByPrice.get(priceIdValue);
      if (mapped) planKey = mapped;
    }
  }
  return { priceId, planKey, meteredItemId };
}

export function mapStripeEventToIngestParams(
  event: Record<string, unknown>,
  config: BillingConfig,
): BillingIngestParams | null {
  const eventId = text(event.id);
  const eventType = text(event.type);
  const data = event.data;
  const object = isRecord(data) ? data.object : null;
  if (!eventId || !eventType || !isRecord(object)) return null;

  const base = {
    stripeEventId: eventId,
    eventType,
    targetTenantId: null as string | null,
    stripeCustomerId: null as string | null,
    stripeSubscriptionId: null as string | null,
    stripePriceId: null as string | null,
    stripeMeteredItemId: null as string | null,
    planKey: null as string | null,
    subscriptionStatus: null as string | null,
    currentPeriodEnd: null as string | null,
    cancelAtPeriodEnd: null as boolean | null,
    dunningSignal: null as "payment_failed" | "payment_succeeded" | null,
  };

  switch (eventType) {
    case "checkout.session.completed": {
      // Only a subscription checkout carries the tenant mapping this
      // platform needs; anything else (a one-off payment link, for example)
      // is out of scope and left unresolved on purpose.
      if (object.mode !== "subscription") return null;
      return {
        ...base,
        targetTenantId: text(object.client_reference_id),
        stripeCustomerId: text(object.customer),
        stripeSubscriptionId: text(object.subscription),
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const { priceId, planKey, meteredItemId } = readSubscriptionItems(
        object,
        config,
      );
      return {
        ...base,
        stripeCustomerId: text(object.customer),
        stripeSubscriptionId: text(object.id),
        stripePriceId: priceId,
        stripeMeteredItemId: meteredItemId,
        planKey,
        subscriptionStatus: text(object.status),
        currentPeriodEnd: epochToIso(object.current_period_end),
        cancelAtPeriodEnd: object.cancel_at_period_end === true,
      };
    }
    case "customer.subscription.deleted": {
      return {
        ...base,
        stripeCustomerId: text(object.customer),
        stripeSubscriptionId: text(object.id),
        subscriptionStatus: "canceled",
      };
    }
    case "invoice.payment_failed": {
      return {
        ...base,
        stripeCustomerId: text(object.customer),
        stripeSubscriptionId: text(object.subscription),
        dunningSignal: "payment_failed",
      };
    }
    case "invoice.payment_succeeded": {
      return {
        ...base,
        stripeCustomerId: text(object.customer),
        stripeSubscriptionId: text(object.subscription),
        dunningSignal: "payment_succeeded",
      };
    }
    default:
      return null;
  }
}
