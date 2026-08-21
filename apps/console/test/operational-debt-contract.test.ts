import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Contract coverage for docs/PLAN.md Phase 12, items 1 and 2:
 *
 *   1. Voice / provider rate limiting is atomic in SQL (migration
 *      20260726099000), not a read-then-write race.
 *   2. `telemetry_outbox` has a reader: a lease-based claim/complete/fail/
 *      purge contract, exposed as an authenticated, schedulable route.
 *
 * Following the style already used by client-action-contract.test.ts and the
 * voice contract tests: assert against the real migration SQL and route
 * source rather than standing up a database, since nothing in this test
 * suite runs one.
 */

function migration(name: string) {
  return readFileSync(
    new URL(`../../../infra/supabase/migrations/${name}`, import.meta.url),
    "utf8",
  );
}

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const sql = migration("20260726099000_operational_debt.sql");
const drainRoute = source(
  "../src/app/api/ops/telemetry-outbox/drain/route.ts",
);
const rateLimitFile = source(
  "../src/app/api/learning/voice/rate-limit.ts",
);
const voiceRuntime = source("../src/lib/voice-runtime.ts");
const managedVoiceEdge = source(
  "../../../infra/supabase/functions/learning-provider-voice/index.ts",
);
const transcribeRoute = source(
  "../src/app/api/learning/voice/transcribe/route.ts",
);
const speakRoute = source("../src/app/api/learning/voice/speak/route.ts");
const realtimeRoute = source(
  "../src/app/api/learning/voice/realtime/route.ts",
);

test("the rate-limit check and its increment are one statement, not a read then a write", () => {
  // The atomic primitive: a single INSERT .. ON CONFLICT .. DO UPDATE ..
  // RETURNING, which Postgres resolves under a row-level lock. There is no
  // separate `select count(*)` before it for the three call-rate limits.
  assert.match(
    sql,
    /create or replace function app_private\.provider_rate_counter_increment/,
  );
  const incrementBody = sql.slice(
    sql.indexOf(
      "create or replace function app_private.provider_rate_counter_increment",
    ),
    sql.indexOf("$$;", sql.indexOf(
      "create or replace function app_private.provider_rate_counter_increment",
    )),
  );
  assert.match(incrementBody, /insert into public\.provider_rate_counters/);
  assert.match(incrementBody, /on conflict \(counter_key\) do update/);
  assert.match(incrementBody, /returning request_count/);
  assert.doesNotMatch(incrementBody, /select .*count\(\*\)/is);

  // provider_call_decision now sources its three counts from the atomic
  // primitive, once per limit, instead of counting historical rows.
  const decisionStart = sql.indexOf(
    "create or replace function app_private.provider_call_decision",
  );
  assert.notEqual(decisionStart, -1);
  const decisionEnd = sql.indexOf("$$;", decisionStart);
  const decisionBody = sql.slice(decisionStart, decisionEnd);
  assert.match(
    decisionBody,
    /subject_minute := app_private\.provider_rate_counter_increment/,
  );
  assert.match(
    decisionBody,
    /tenant_minute := app_private\.provider_rate_counter_increment/,
  );
  assert.match(
    decisionBody,
    /tenant_day := app_private\.provider_rate_counter_increment/,
  );
  assert.doesNotMatch(decisionBody, /select count\(\*\)::integer into (subject_minute|tenant_minute)/);
});

test("rate limits stay per-tenant and per-subject and stay configurable, not hardcoded", () => {
  // The existing configurable policy table and its admin setter (unchanged
  // by this migration) are what makes the limits configurable rather than a
  // constant in code.
  assert.match(sql, /cost_policy\.max_calls_per_minute/);
  assert.match(sql, /cost_policy\.max_calls_per_day/);
  assert.match(sql, /cost_policy\.max_subject_calls_per_minute/);
  assert.doesNotMatch(sql, /max_calls_per_minute\s*:=\s*\d/);
});

test("voice routes defer to the managed Edge boundary and its durable SQL reservation", () => {
  // Provider credentials, metering, and the durable rate-limit reservation
  // now live behind the authenticated Edge boundary. Next only forwards the
  // verified tenant request and cannot bypass the durable reservation.
  for (const route of [transcribeRoute, speakRoute, realtimeRoute]) {
    assert.match(route, /invokeManagedVoice/);
  }
  assert.match(managedVoiceEdge, /learning_reserve_provider_call/);
  assert.match(managedVoiceEdge, /await reserve\(/);
  assert.match(managedVoiceEdge, /learning_record_provider_cost/);
  assert.match(voiceRuntime, /reserveProviderCall/);
  assert.match(rateLimitFile, /Same-instance burst guard only/);
});

test("telemetry_outbox gains a terminal failed state instead of only pending/processing/delivered", () => {
  assert.match(sql, /add column if not exists failed_at timestamptz/);
  assert.match(
    sql,
    /check \(status in \('pending', 'processing', 'delivered', 'failed'\)\)/,
  );
});

test("claiming a batch is a single atomic statement using for update skip locked", () => {
  const claimStart = sql.indexOf(
    "create or replace function public.telemetry_outbox_claim_batch",
  );
  assert.notEqual(claimStart, -1);
  const claimEnd = sql.indexOf("$$;", claimStart);
  const claimBody = sql.slice(claimStart, claimEnd);
  assert.match(claimBody, /for update skip locked/);
  assert.match(claimBody, /attempt_count = target\.attempt_count \+ 1/);
  // Stale processing rows (a worker that crashed mid-batch) are reclaimable.
  assert.match(
    claimBody,
    /status = 'processing'\s*\n\s*and locked_at < clock_timestamp\(\)/,
  );
  // A row that has already exhausted its attempt budget is failed here
  // rather than handed out again, even if it was never explicitly reported
  // as failed (repeated crashes, never an explicit failure).
  assert.match(claimBody, /attempt_count >= policy\.max_attempts/);
});

test("complete and fail both require the caller's own lease, so a stale or repeated call cannot double-process a row", () => {
  const completeStart = sql.indexOf(
    "create or replace function public.telemetry_outbox_complete_batch",
  );
  const completeEnd = sql.indexOf("$$;", completeStart);
  const completeBody = sql.slice(completeStart, completeEnd);
  assert.match(completeBody, /t\.status = 'processing'/);
  assert.match(completeBody, /t\.locked_by = lease_owner/);

  const failStart = sql.indexOf(
    "create or replace function public.telemetry_outbox_fail_batch",
  );
  const failEnd = sql.indexOf("commit;", failStart);
  const failBody = sql.slice(failStart, failEnd);
  assert.match(failBody, /t\.status = 'processing'/g);
  assert.match(failBody, /t\.locked_by = lease_owner/g);
  // Bounded attempts: exhausted or explicitly non-retryable goes terminal;
  // otherwise it is retried with backoff, never retried unconditionally.
  assert.match(failBody, /t\.attempt_count < policy\.max_attempts/);
  assert.match(
    failBody,
    /not supplied\.retryable or t\.attempt_count >= policy\.max_attempts/,
  );
});

test("retention is configurable and only ever removes terminal rows", () => {
  assert.match(sql, /retention_days integer not null default 14/);
  assert.match(sql, /platform_admin_set_telemetry_outbox_policy/);
  const purgeStart = sql.indexOf(
    "create or replace function public.telemetry_outbox_purge_expired",
  );
  const purgeEnd = sql.indexOf("$$;", purgeStart);
  const purgeBody = sql.slice(purgeStart, purgeEnd);
  assert.match(purgeBody, /status = 'delivered'/);
  assert.match(purgeBody, /status = 'failed'/);
  assert.doesNotMatch(purgeBody, /status = 'pending'|status = 'processing'/);

  // The delete guard is the backstop: even a bug in the purge WHERE clause
  // above cannot remove a live row, because the trigger itself refuses.
  assert.match(
    sql,
    /old\.status not in \('delivered', 'failed'\)/,
  );
  assert.match(sql, /before delete on public\.telemetry_outbox/);
});

test("the drain worker entrypoints are reachable without a session but not by a signed-in browser", () => {
  assert.match(
    sql,
    /grant execute on function public\.telemetry_outbox_claim_batch\(text, integer\)\s*\n\s*to anon, service_role/,
  );
  assert.match(
    sql,
    /revoke execute on function public\.telemetry_outbox_claim_batch\(text, integer\)\s*\n\s*from public, anon, authenticated, service_role/,
  );
  assert.match(sql, /'telemetry\.outbox\.drain'/);
});

test("the drain route is bearer-token gated with a constant-time comparison and fails closed when unconfigured", () => {
  assert.match(
    drainRoute,
    /LEARNINGBOT_TELEMETRY_OUTBOX_OPERATION_TOKEN/,
  );
  assert.match(drainRoute, /expectedToken\.length < 32/);
  assert.match(drainRoute, /"worker_not_configured"/);
  assert.match(drainRoute, /difference \|= presented\.charCodeAt/);
  assert.match(drainRoute, /"access_denied"/);
});

test("the drain route claims, delivers, completes or fails, and purges every run", () => {
  assert.match(drainRoute, /telemetry_outbox_claim_batch/);
  assert.match(drainRoute, /telemetry_outbox_complete_batch/);
  assert.match(drainRoute, /telemetry_outbox_fail_batch/);
  assert.match(drainRoute, /telemetry_outbox_purge_expired/);
  assert.match(drainRoute, /function deliver\(/);
});

test("the new operation-secret capability is documented in .env.example with a named reader", () => {
  const envExample = source("../../../.env.example");
  assert.match(envExample, /LEARNINGBOT_TELEMETRY_OUTBOX_OPERATION_TOKEN/);
  assert.match(
    envExample,
    /Read by: POST \/api\/ops\/telemetry-outbox\/drain/,
  );
  assert.match(envExample, /'telemetry\.outbox\.drain'/);
});
