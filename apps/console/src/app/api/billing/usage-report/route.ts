import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "../../../../lib/supabase/config";
import { readBillingConfig, reportMeterEvent } from "../../../../lib/billing/stripe";

/**
 * Usage -> margin -> Stripe, on a schedule.
 *
 * Same worker-token pattern as `/api/learning/embeddings` and
 * `/api/ops/telemetry-outbox/drain`: authority is the `billing.operations`
 * operation secret, never a Supabase session, so a scheduler can call this
 * with no user and a signed-in browser cannot reach it at all (the RPCs it
 * calls are granted to `anon`/`service_role`, not `authenticated`).
 *
 * Idempotency (non-negotiable #4) is enforced in two layers, deliberately
 * redundant:
 *
 *   1. `billing_claim_unreported_usage` anti-joins against
 *      `public.billing_usage_reports`, so an already-reported `cost_ledger`
 *      row is never even claimed again.
 *   2. `billing_commit_usage_report` only writes after this route's own
 *      Stripe API call has succeeded, and that write is itself guarded by
 *      `unique (tenant_id, cost_entry_id)` — the actual database-level
 *      guarantee that a row is billed at most once, even under a retried or
 *      overlapping run.
 *
 * If a Stripe usage-record call fails partway through a batch, the affected
 * rows are simply left unreported and picked up by the next run; nothing
 * here blocks or reverses the rows that already succeeded.
 */

const MAX_BATCHES = 10;
const RUN_BUDGET_MS = 45_000;

type JsonRecord = Record<string, unknown>;

type ClaimedItem = {
  readonly tenantId: string;
  readonly costEntryId: string;
  readonly capability: string;
  readonly providerKey: string;
  readonly modelKey: string | null;
  readonly costMicro: number;
  readonly occurredAt: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionItemId: string;
  readonly marginMultiplier: number;
  readonly fixedMarkupMicro: number;
  readonly floorMicro: number;
  readonly billedMicro: number;
  readonly billedMinorUnits: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: JsonRecord, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function tokensMatch(presented: string, expected: string) {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function presentedToken(request: Request) {
  const header = request.headers.get("x-learningbot-operation-token");
  if (header) return header.trim();
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return "";
}

function boundedLimit(value: string | null) {
  const requested = Number(value ?? "200");
  if (!Number.isSafeInteger(requested)) return 200;
  return Math.min(Math.max(requested, 1), 1000);
}

function claimedItems(value: unknown): ClaimedItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const {
      tenantId, costEntryId, capability, providerKey, occurredAt,
      stripeCustomerId, stripeSubscriptionItemId,
    } = candidate;
    if (
      typeof tenantId !== "string" ||
      typeof costEntryId !== "string" ||
      typeof capability !== "string" ||
      typeof providerKey !== "string" ||
      typeof occurredAt !== "string" ||
      typeof stripeCustomerId !== "string" ||
      typeof stripeSubscriptionItemId !== "string"
    ) {
      return [];
    }
    return [{
      tenantId,
      costEntryId,
      capability,
      providerKey,
      modelKey: typeof candidate.modelKey === "string" ? candidate.modelKey : null,
      costMicro: Number(candidate.costMicro ?? 0),
      occurredAt,
      stripeCustomerId,
      stripeSubscriptionItemId,
      marginMultiplier: Number(candidate.marginMultiplier ?? 1),
      fixedMarkupMicro: Number(candidate.fixedMarkupMicro ?? 0),
      floorMicro: Number(candidate.floorMicro ?? 0),
      billedMicro: Number(candidate.billedMicro ?? 0),
      billedMinorUnits: Number(candidate.billedMinorUnits ?? 0),
    }];
  });
}

export async function POST(request: Request) {
  const expectedToken =
    process.env.LEARNINGBOT_BILLING_OPERATIONS_TOKEN?.trim() ?? "";
  if (expectedToken.length < 32) {
    return json({ ok: false, code: "worker_not_configured" }, 503);
  }
  const presented = presentedToken(request);
  if (!presented || !tokensMatch(presented, expectedToken)) {
    return json({ ok: false, code: "access_denied" }, 401);
  }

  const billingConfig = readBillingConfig();
  if (billingConfig === null) {
    return json({ ok: false, code: "stripe_not_configured" }, 503);
  }

  let supabaseUrl: string;
  let publishableKey: string;
  try {
    const config = readSupabasePublicConfig();
    supabaseUrl = config.url;
    publishableKey = config.publishableKey;
  } catch {
    return json({ ok: false, code: "provider_not_configured" }, 503);
  }

  const batchLimit = boundedLimit(new URL(request.url).searchParams.get("limit"));
  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  const runDeadline = Date.now() + RUN_BUDGET_MS;

  let claimedCount = 0;
  let reportedCount = 0;
  let failedCount = 0;
  let batchCount = 0;

  while (batchCount < MAX_BATCHES && Date.now() < runDeadline) {
    const claim = await supabase.rpc("billing_claim_unreported_usage", {
      operation_token: expectedToken,
      batch_limit: batchLimit,
    });
    if (claim.error || !isRecord(claim.data) || claim.data.ok !== true) {
      return json(
        {
          ok: false,
          code: "claim_failed",
          claimed: claimedCount,
          reported: reportedCount,
          failed: failedCount,
          batches: batchCount,
        },
        502,
      );
    }
    const items = claimedItems(claim.data.items);
    if (items.length === 0) break;

    batchCount += 1;
    claimedCount += items.length;

    for (const item of items) {
      try {
        const occurredAtSeconds = Math.floor(
          new Date(item.occurredAt).getTime() / 1000,
        );
        const meterEvent = await reportMeterEvent({
          stripeCustomerId: item.stripeCustomerId,
          billedMicro: item.billedMicro,
          identifier: item.costEntryId,
          occurredAtEpochSeconds: Number.isFinite(occurredAtSeconds)
            ? occurredAtSeconds
            : Math.floor(Date.now() / 1000),
        });
        const commit = await supabase.rpc("billing_commit_usage_report", {
          operation_token: expectedToken,
          target_tenant_id: item.tenantId,
          cost_entry_id: item.costEntryId,
          stripe_subscription_item_id: item.stripeSubscriptionItemId,
          stripe_usage_record_id: meterEvent.meterEventIdentifier,
          cost_micro: item.costMicro,
          billed_micro: item.billedMicro,
          billed_minor_units: item.billedMinorUnits,
          margin_multiplier: item.marginMultiplier,
          fixed_markup_micro: item.fixedMarkupMicro,
          floor_micro: item.floorMicro,
          capability: item.capability,
          provider_key: item.providerKey,
          model_key: item.modelKey,
        });
        if (
          !commit.error &&
          isRecord(commit.data) &&
          commit.data.ok === true
        ) {
          reportedCount += 1;
        } else {
          failedCount += 1;
        }
      } catch {
        // A Stripe outage or a rejected usage record must not stop the rest
        // of the batch, and never marks the row reported — it is picked up
        // again on the next run.
        failedCount += 1;
      }
    }

    if (items.length < batchLimit) break;
  }

  return json({
    ok: true,
    dataMode: "durable",
    claimed: claimedCount,
    reported: reportedCount,
    failed: failedCount,
    batches: batchCount,
  });
}
