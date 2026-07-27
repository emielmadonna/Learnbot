import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "../../../../../lib/supabase/config";

/**
 * The telemetry outbox drain.
 *
 * `public.learning_record_usage_event` (0027) has written a row into
 * `public.telemetry_outbox` for every usage event since it shipped, and
 * nothing has ever read one back out: the table only grows. This route is
 * the reader.
 *
 * Each run claims a bounded batch under a lease
 * (`telemetry_outbox_claim_batch`), "delivers" every claimed row, marks
 * delivered rows `delivered` and failed ones `pending` (retry, with backoff)
 * or `failed` (retry budget exhausted or reported non-retryable)
 * (`telemetry_outbox_complete_batch` / `telemetry_outbox_fail_batch`), and
 * finally removes rows that finished and are past the configured retention
 * window (`telemetry_outbox_purge_expired`). All four are durable, atomic
 * SQL operations; see migration 20260726099000 for the claim/lease/retry
 * contract that makes concurrent and crash-mid-batch runs safe.
 *
 * "Delivery" today is a structured, bounded log line, because nothing in
 * this codebase names an external telemetry sink to send it to (checked:
 * no Segment/PostHog/Datadog/webhook configuration anywhere in .env.example
 * or the source tree). `learning_record_usage_event` only ever writes a
 * fixed property allowlist (courseId, lessonId, durationMs, and similar) --
 * never learner content -- so emitting the payload verbatim to the platform's
 * own log aggregation is safe. A real sink is a later change to `deliver()`
 * alone; the claim/complete/fail contract around it does not change.
 *
 * Authority is the `telemetry.outbox.drain` operation secret -- the same
 * mechanism that already gates `/api/learning/embeddings` and the answer
 * path's server-only RPCs. A scheduler (Vercel Cron, a GitHub Action, a
 * platform admin's own authenticated call) can invoke this with no user
 * session; a signed-in browser cannot reach it at all, because the RPCs this
 * route calls are not granted to `authenticated`.
 */

const MAX_BATCHES = 20;
const RUN_BUDGET_MS = 45_000;
const MAX_LOG_CHARS = 2_000;

type JsonRecord = Record<string, unknown>;

type ClaimedItem = {
  readonly tenantId: string;
  readonly outboxId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly attemptCount: number;
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

/** Constant-time for equal-length inputs; length is not itself a secret. */
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
  const requested = Number(value ?? "50");
  if (!Number.isSafeInteger(requested)) return 50;
  return Math.min(Math.max(requested, 1), 500);
}

function claimedItems(value: unknown): ClaimedItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const { tenantId, outboxId, topic, attemptCount } = candidate;
    if (
      typeof tenantId !== "string" ||
      typeof outboxId !== "string" ||
      typeof topic !== "string" ||
      typeof attemptCount !== "number"
    ) {
      return [];
    }
    return [{ tenantId, outboxId, topic, payload: candidate.payload, attemptCount }];
  });
}

/**
 * See the module comment: this is the whole "sink" today. It never throws on
 * a well-formed item; it is wrapped in try/catch below purely so a future,
 * real sink that can fail over the network reports that failure back to the
 * outbox as a retryable error instead of crashing the run.
 */
function deliver(item: ClaimedItem) {
  const line = JSON.stringify({
    topic: item.topic,
    tenantId: item.tenantId,
    outboxId: item.outboxId,
    attempt: item.attemptCount,
    payload: item.payload,
  }).slice(0, MAX_LOG_CHARS);
  console.info("telemetry.outbox.delivered", line);
}

export async function POST(request: Request) {
  const expectedToken =
    process.env.LEARNINGBOT_TELEMETRY_OUTBOX_OPERATION_TOKEN?.trim() ?? "";
  // Fail closed: an unconfigured worker is not an open worker.
  if (expectedToken.length < 32) {
    return json({ ok: false, code: "worker_not_configured" }, 503);
  }
  const presented = presentedToken(request);
  if (!presented || !tokensMatch(presented, expectedToken)) {
    return json({ ok: false, code: "access_denied" }, 401);
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
  let deliveredCount = 0;
  let failedCount = 0;
  let batchCount = 0;
  let remainingPending = 0;

  while (batchCount < MAX_BATCHES && Date.now() < runDeadline) {
    const claim = await supabase.rpc("telemetry_outbox_claim_batch", {
      operation_token: expectedToken,
      batch_limit: batchLimit,
    });
    if (claim.error || !isRecord(claim.data) || claim.data.ok !== true) {
      return json(
        {
          ok: false,
          code: "claim_failed",
          claimed: claimedCount,
          delivered: deliveredCount,
          failed: failedCount,
          batches: batchCount,
        },
        502,
      );
    }
    const leaseOwner =
      typeof claim.data.leaseOwner === "string" ? claim.data.leaseOwner : "";
    remainingPending =
      typeof claim.data.remainingPending === "number"
        ? claim.data.remainingPending
        : 0;
    const items = claimedItems(claim.data.items);
    if (items.length === 0 || !leaseOwner) break;

    batchCount += 1;
    claimedCount += items.length;

    const delivered: { tenantId: string; outboxId: string }[] = [];
    const failed: {
      tenantId: string;
      outboxId: string;
      retryable: boolean;
      errorMessage: string;
    }[] = [];

    for (const item of items) {
      try {
        deliver(item);
        delivered.push({ tenantId: item.tenantId, outboxId: item.outboxId });
      } catch (error) {
        failed.push({
          tenantId: item.tenantId,
          outboxId: item.outboxId,
          retryable: true,
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "delivery_failed",
        });
      }
    }

    if (delivered.length > 0) {
      const complete = await supabase.rpc("telemetry_outbox_complete_batch", {
        operation_token: expectedToken,
        lease_owner: leaseOwner,
        items: delivered.map((entry) => ({
          tenant_id: entry.tenantId,
          outbox_id: entry.outboxId,
        })),
      });
      if (!complete.error && isRecord(complete.data) && complete.data.ok === true) {
        deliveredCount +=
          typeof complete.data.completed === "number"
            ? complete.data.completed
            : delivered.length;
      }
    }
    if (failed.length > 0) {
      const fail = await supabase.rpc("telemetry_outbox_fail_batch", {
        operation_token: expectedToken,
        lease_owner: leaseOwner,
        items: failed.map((entry) => ({
          tenant_id: entry.tenantId,
          outbox_id: entry.outboxId,
          retryable: entry.retryable,
          error_message: entry.errorMessage,
        })),
      });
      if (!fail.error && isRecord(fail.data) && fail.data.ok === true) {
        failedCount +=
          typeof fail.data.failed === "number" ? fail.data.failed : 0;
      }
    }

    if (items.length < batchLimit) break;
  }

  const purge = await supabase.rpc("telemetry_outbox_purge_expired", {
    operation_token: expectedToken,
    batch_limit: 500,
  });
  const purged =
    !purge.error && isRecord(purge.data) && purge.data.ok === true
      ? Number(purge.data.purged ?? 0)
      : 0;

  return json({
    ok: true,
    dataMode: "durable",
    claimed: claimedCount,
    delivered: deliveredCount,
    failed: failedCount,
    purged,
    batches: batchCount,
    remainingPending,
  });
}
