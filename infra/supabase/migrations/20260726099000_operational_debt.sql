-- Operational debt, part 1 and 2 of docs/PLAN.md Section 11 Phase 12.
--
--   1. Voice rate limiting was never actually a per-process `Map` problem in
--      the code as it stands today -- migration 20260726096000 already moved
--      the authoritative check into SQL (`learning_reserve_provider_call` /
--      `app_private.provider_call_decision`), reading durable counters in
--      `public.tenant_cost_policies` (per-tenant AND per-subject limits,
--      already admin-configurable via `platform_admin_set_tenant_cost_policy`,
--      never hardcoded) and `public.provider_rate_events`. What survived from
--      the original defect is a real one, just one level deeper: that
--      function reads the last minute/day's rows with a plain `select
--      count(*)`, decides allow/deny, and only afterward inserts this call's
--      own row. Reading and writing are two separate statements with a gap
--      between them, so two concurrent requests can both read the same
--      "count so far" and both pass a limit of one -- exactly the race the
--      durable rewrite was supposed to close. `apps/console/src/app/api/
--      learning/voice/rate-limit.ts` already documents its `Map` as a
--      same-instance burst guard only, deferring to this SQL check as
--      authoritative, so that file needs no change; this migration closes the
--      race in the SQL it defers to, which is also what every other caller of
--      `learning_reserve_provider_call` (conversation answers, classification,
--      the widget) shares.
--
--      The fix: `app_private.provider_rate_counter_increment` performs the
--      read and the write as one statement -- `insert .. on conflict (key) do
--      update .. returning` -- against a new fixed-window counter table,
--      `public.provider_rate_counters`. Postgres resolves a conflicting
--      insert with a row-level lock, so concurrent callers for the same
--      window are serialized and each gets a distinct, race-free count back.
--      `app_private.provider_call_decision` is rewritten to call this once
--      per limit (subject-minute, tenant-minute, tenant-day) instead of
--      counting historical rows, and to compare the 1-indexed result with
--      `>` where it used to compare a 0-indexed prior count with `>=` --
--      same refusal point, race-free arithmetic. Budget checks
--      (`cost_ledger` spend against the daily/monthly budget) are unchanged:
--      they are a soft, already-metered-after-the-fact threshold, not a hard
--      "at most N concurrent" guarantee, and touching them was not needed to
--      close the atomicity gap this task is about.
--      `public.provider_rate_events` keeps recording exactly what it did
--      before (unchanged), because `platform_admin_cost_overview` and the
--      existing OPS-04 test read it directly; only the internal counting
--      this function used to decide "allow" or "deny" moved to the atomic
--      table.
--
--      Fail-open/fail-closed choice: unchanged from the existing design in
--      `cost-metering.ts`'s `reserveProviderCall`, which this migration does
--      not touch. A real decision from this RPC (allow or deny) is always
--      honoured -- fail closed on the decision itself. If the RPC cannot be
--      reached at all (network error, unapplied migration), the TypeScript
--      wrapper fails OPEN and marks the result `degraded`, because refusing
--      every voice and chat request platform-wide over an infrastructure
--      outage in the *limiter* is a worse failure than temporarily running
--      unmetered. That policy is already correct and is left alone here;
--      this migration only makes the *decision*, when it is reachable,
--      actually race-free.
--
--   2. `public.telemetry_outbox` (0007) has had a writer
--      (`learning_record_usage_event`, 0027) and no reader since it shipped.
--      This adds the reader: a lease-based claim/complete/fail contract
--      (mirroring the shape `learning_claim_embedding_work` /
--      `_commit_embedding_work` / `_release_embedding_work` already
--      established for the embedding queue in 20260726095000) plus a
--      configurable retry budget, a terminal `failed` state so a poison row
--      cannot block the queue forever, and a retention purge. All four are
--      gated by a new operation-secret capability, `telemetry.outbox.drain`,
--      the same mechanism the embedding worker uses -- reachable without a
--      session, authorised only by a bearer token, so a scheduler can call it
--      and a signed-in browser cannot reach it at all.
--
-- Boundaries kept: every new function is SECURITY DEFINER with `search_path`
-- fixed to `pg_catalog`; every grant is the narrowest role that has to call
-- it; nothing here reads or stores prompt text, learner messages or audio.

begin;

-- ---------------------------------------------------------------------------
-- 1. Atomic rate-limit counters
-- ---------------------------------------------------------------------------

create table if not exists public.provider_rate_counters (
  counter_key text primary key,
  tenant_id uuid not null references public.tenants(tenant_id),
  scope text not null check (scope in ('tenant_minute', 'tenant_day', 'subject_minute')),
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists provider_rate_counters_window_idx
  on public.provider_rate_counters (window_start);

alter table public.provider_rate_counters enable row level security;
alter table public.provider_rate_counters force row level security;
revoke all on table public.provider_rate_counters
  from public, anon, authenticated;
drop policy if exists provider_rate_counters_no_direct_access
  on public.provider_rate_counters;
create policy provider_rate_counters_no_direct_access
  on public.provider_rate_counters
  for all
  using (false)
  with check (false);

-- The atomic primitive. One statement does the read-check-write that used to
-- be a `select count(*)` followed by a separate `insert`: the `on conflict ..
-- do update .. returning` is resolved under a row-level lock, so two
-- concurrent callers for the same counter_key are serialized by Postgres
-- itself and each gets back its own distinct, correct position in the
-- window. The caller compares the returned (1-indexed) count against its
-- limit; nothing here decides allow/deny, so it stays reusable for any fixed
-- window a caller wants counted this way.
create or replace function app_private.provider_rate_counter_increment(
  counter_key text,
  target_tenant_id uuid,
  scope text,
  window_start timestamptz
)
returns integer
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  insert into public.provider_rate_counters (
    counter_key, tenant_id, scope, window_start, request_count
  )
  values (counter_key, target_tenant_id, scope, window_start, 1)
  on conflict (counter_key) do update
    set request_count = public.provider_rate_counters.request_count + 1,
        updated_at = clock_timestamp()
  returning request_count;
$$;
revoke execute on function app_private.provider_rate_counter_increment(
  text, uuid, text, timestamptz
) from public, anon, authenticated, service_role;

-- Same signature, same return shape, same capability set as the version in
-- 20260726096000. Internals only: the three call counts are now read from
-- the atomic counter above instead of a `select count(*)` over history.
create or replace function app_private.provider_call_decision(
  target_tenant_id uuid,
  requested_capability text,
  subject_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  cost_policy public.tenant_cost_policies%rowtype;
  tenant_status text;
  subject_digest text;
  now_ts timestamptz := statement_timestamp();
  minute_window timestamptz;
  day_window timestamptz;
  subject_minute integer;
  tenant_minute integer;
  tenant_day integer;
  day_spend bigint;
  month_spend bigint;
  deny_code text := null;
  retry_after integer := 0;
  allowed boolean;
begin
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if requested_capability is null
    or length(btrim(requested_capability)) not between 1 and 100
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select t.status into tenant_status
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  cost_policy := app_private.tenant_cost_policy(target_tenant_id);
  subject_digest := app_private.provider_rate_subject_hash(
    target_tenant_id,
    subject_key
  );

  -- Opportunistic pruning keeps both counter stores bounded without a
  -- scheduler. Unchanged for provider_rate_events; added for the new table.
  if random() < 0.01 then
    delete from public.provider_rate_events
    where occurred_at < now_ts - interval '2 days';
    delete from public.provider_rate_counters
    where window_start < now_ts - interval '2 days';
  end if;

  select coalesce(sum(c.estimated_cost_micro), 0)::bigint into day_spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= date_trunc('day', now_ts);

  select coalesce(sum(c.estimated_cost_micro), 0)::bigint into month_spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= date_trunc('month', now_ts);

  -- Fixed windows, aligned to the minute and to the UTC calendar day -- the
  -- latter now matches day_spend above (and the "resets at midnight UTC"
  -- language `cost-metering.ts` already shows learners) rather than the
  -- previous rolling 24h window, which nothing depended on. Each call is
  -- unconditional: it always claims its place in all three windows, exactly
  -- as the previous implementation always *read* all three before deciding.
  -- A call that ends up denied still occupies a slot in a window it will
  -- keep failing against anyway until the window rolls over, which changes
  -- no observable allow/deny outcome; it only avoids a second read.
  minute_window := date_trunc('minute', now_ts);
  day_window := date_trunc('day', now_ts);

  subject_minute := app_private.provider_rate_counter_increment(
    'subject_minute:' || subject_digest || ':' ||
      (extract(epoch from minute_window)::bigint)::text,
    target_tenant_id,
    'subject_minute',
    minute_window
  );
  tenant_minute := app_private.provider_rate_counter_increment(
    'tenant_minute:' || target_tenant_id::text || ':' ||
      (extract(epoch from minute_window)::bigint)::text,
    target_tenant_id,
    'tenant_minute',
    minute_window
  );
  tenant_day := app_private.provider_rate_counter_increment(
    'tenant_day:' || target_tenant_id::text || ':' ||
      (extract(epoch from day_window)::bigint)::text,
    target_tenant_id,
    'tenant_day',
    day_window
  );

  -- A freshly bootstrapped tenant is legitimately still `provisioning`, so only
  -- an explicit suspension or deletion refuses spend here.
  if tenant_status in ('suspended', 'deleted') then
    deny_code := 'tenant_suspended';
  elsif month_spend >= cost_policy.monthly_budget_micro then
    deny_code := 'monthly_budget_exceeded';
  elsif day_spend >= cost_policy.daily_budget_micro then
    deny_code := 'daily_budget_exceeded';
  elsif tenant_day > cost_policy.max_calls_per_day then
    deny_code := 'tenant_daily_call_limit';
  elsif tenant_minute > cost_policy.max_calls_per_minute then
    deny_code := 'tenant_rate_limited';
    retry_after := 60;
  elsif subject_minute > cost_policy.max_subject_calls_per_minute then
    deny_code := 'subject_rate_limited';
    retry_after := 60;
  end if;

  -- `monitor` records what would have been refused without refusing it, so a
  -- new limit can be observed against real traffic before it bites.
  allowed := deny_code is null or cost_policy.enforcement = 'monitor';

  insert into public.provider_rate_events (
    tenant_id, capability, subject_hash, decision, deny_reason
  ) values (
    target_tenant_id,
    btrim(requested_capability),
    subject_digest,
    case when allowed then 'allow' else 'deny' end,
    deny_code
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'allowed', allowed,
    'scope', 'durable-tenant',
    'enforcement', cost_policy.enforcement,
    'code', coalesce(deny_code, 'allowed'),
    'wouldDeny', deny_code is not null,
    'retryAfterSeconds', retry_after,
    'currency', cost_policy.currency,
    'daySpendMicro', day_spend,
    'monthSpendMicro', month_spend,
    'dailyBudgetMicro', cost_policy.daily_budget_micro,
    'monthlyBudgetMicro', cost_policy.monthly_budget_micro,
    'tenantCallsThisMinute', tenant_minute,
    'tenantCallsToday', tenant_day,
    'subjectCallsThisMinute', subject_minute
  );
end;
$$;
revoke execute on function app_private.provider_call_decision(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. telemetry_outbox: a reader
-- ---------------------------------------------------------------------------

-- A terminal state for rows that will never succeed, alongside the pending /
-- processing / delivered states 0007 already declared.
alter table public.telemetry_outbox
  add column if not exists failed_at timestamptz;

-- Both check constraints below were declared inline in 0007 and therefore
-- carry generated names; located by predicate rather than guessed at, so
-- this cannot half-apply and leave the narrower, three-state check in force.
-- ('%status%' matches only these two constraints on this table -- no other
-- column or table-level check on telemetry_outbox mentions "status".)
do $$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select con.conname
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'telemetry_outbox'
      and con.contype = 'c'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%status%'
  loop
    execute format(
      'alter table public.telemetry_outbox drop constraint %I',
      existing_constraint
    );
  end loop;
end $$;

alter table public.telemetry_outbox
  add constraint telemetry_outbox_status_check
  check (status in ('pending', 'processing', 'delivered', 'failed'));

alter table public.telemetry_outbox
  add constraint telemetry_outbox_state_shape_check
  check (
    (
      status = 'pending'
      and locked_by is null and locked_at is null
      and delivered_at is null and failed_at is null
    )
    or (
      status = 'processing'
      and locked_by is not null and locked_at is not null
      and delivered_at is null and failed_at is null
    )
    or (
      status = 'delivered'
      and locked_by is null and locked_at is null
      and delivered_at is not null and failed_at is null
    )
    or (
      status = 'failed'
      and locked_by is null and locked_at is null
      and delivered_at is null and failed_at is not null
    )
  );

-- `delivered` was already terminal for updates; `failed` joins it. The
-- payload/identity guard is untouched -- this only widens which statuses
-- freeze the row.
create or replace function app_private.protect_telemetry_outbox_payload()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.outbox_id is distinct from old.outbox_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.topic is distinct from old.topic
    or new.payload is distinct from old.payload
    or new.payload_fingerprint is distinct from old.payload_fingerprint
    or old.status in ('delivered', 'failed')
  then
    raise exception 'telemetry_outbox payload and delivered facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- 0007 rejected every delete unconditionally, which was correct when nothing
-- ever finished a row. Retention needs to remove terminal rows, so the
-- blanket rejection is replaced with a narrower guard: only `delivered` or
-- `failed` rows may ever be deleted, so a bug in the purge function's WHERE
-- clause still cannot remove a live (pending/processing) row.
drop trigger if exists telemetry_outbox_reject_delete on public.telemetry_outbox;

create or replace function app_private.telemetry_outbox_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.status not in ('delivered', 'failed') then
    raise exception
      'telemetry_outbox rows may only be removed after reaching a terminal state'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger telemetry_outbox_guard_delete
before delete on public.telemetry_outbox
for each row execute function app_private.telemetry_outbox_guard_delete();

-- Configurable retry/lease/retention policy. Global, not per-tenant -- the
-- outbox is an internal delivery queue, not a tenant-facing resource -- but
-- deliberately a table rather than a constant so an operator can change the
-- retention window or the attempt budget without a deploy.
create table if not exists public.telemetry_outbox_policy (
  policy_id boolean primary key default true check (policy_id),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  lease_seconds integer not null default 300 check (lease_seconds between 30 and 3600),
  backoff_base_seconds integer not null default 30
    check (backoff_base_seconds between 1 and 3600),
  backoff_max_seconds integer not null default 3600
    check (backoff_max_seconds between 60 and 86400),
  retention_days integer not null default 14 check (retention_days between 1 and 365),
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.telemetry_outbox_policy (policy_id) values (true)
  on conflict (policy_id) do nothing;

alter table public.telemetry_outbox_policy enable row level security;
alter table public.telemetry_outbox_policy force row level security;
revoke all on table public.telemetry_outbox_policy from anon, authenticated;
drop policy if exists telemetry_outbox_policy_admin_select
  on public.telemetry_outbox_policy;
create policy telemetry_outbox_policy_admin_select
  on public.telemetry_outbox_policy
  for select to authenticated
  using (public.platform_admin_is_authorized());
grant select on public.telemetry_outbox_policy to authenticated;

create or replace function app_private.current_telemetry_outbox_policy()
returns public.telemetry_outbox_policy
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select * from public.telemetry_outbox_policy where policy_id = true;
$$;
revoke execute on function app_private.current_telemetry_outbox_policy()
  from public, anon, authenticated, service_role;

create or replace function public.platform_admin_set_telemetry_outbox_policy(
  max_attempts integer,
  lease_seconds integer,
  backoff_base_seconds integer,
  backoff_max_seconds integer,
  retention_days integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.telemetry_outbox_policy%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if max_attempts is null or max_attempts not between 1 and 50
    or lease_seconds is null or lease_seconds not between 30 and 3600
    or backoff_base_seconds is null
    or backoff_base_seconds not between 1 and 3600
    or backoff_max_seconds is null
    or backoff_max_seconds not between 60 and 86400
    or backoff_max_seconds < backoff_base_seconds
    or retention_days is null or retention_days not between 1 and 365
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  update public.telemetry_outbox_policy p
  set max_attempts = platform_admin_set_telemetry_outbox_policy.max_attempts,
      lease_seconds = platform_admin_set_telemetry_outbox_policy.lease_seconds,
      backoff_base_seconds =
        platform_admin_set_telemetry_outbox_policy.backoff_base_seconds,
      backoff_max_seconds =
        platform_admin_set_telemetry_outbox_policy.backoff_max_seconds,
      retention_days = platform_admin_set_telemetry_outbox_policy.retention_days,
      updated_by = auth.uid(),
      updated_at = clock_timestamp()
  where p.policy_id = true
  returning * into updated;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'maxAttempts', updated.max_attempts,
    'leaseSeconds', updated.lease_seconds,
    'backoffBaseSeconds', updated.backoff_base_seconds,
    'backoffMaxSeconds', updated.backoff_max_seconds,
    'retentionDays', updated.retention_days
  );
end;
$$;

-- The worker capability joins the two existing ones in the same secret table.
-- Named, not guessed at, since 20260726095000 already gave this constraint a
-- stable name.
alter table app_private.learning_operation_secrets
  drop constraint if exists learning_operation_secrets_capability_allowed;
alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_capability_allowed
  check (
    capability in (
      'conversation.answer.record',
      'knowledge.embedding.worker',
      'telemetry.outbox.drain'
    )
  );

create or replace function app_private.learning_operation_capabilities()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array[
    'conversation.answer.record',
    'knowledge.embedding.worker',
    'telemetry.outbox.drain'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The drain worker's server contract: claim, complete, fail, purge.
--
-- Mirrors the shape 20260726095000 established for the embedding queue.
-- `telemetry_outbox_claim_batch` also reclaims `processing` rows whose lease
-- has expired (a worker that died mid-batch), so a crash never strands rows;
-- it terminally fails, rather than reclaims, a stale row that has already
-- exhausted its attempt budget, so a repeatedly-crashing poison row cannot
-- retry forever even without an explicit failure report. Complete and fail
-- both require the caller's own lease_owner to still hold the row, so a
-- worker whose lease was reclaimed by someone else cannot clobber the new
-- claimant's work with a late, stale completion -- this is also what makes
-- calling complete or fail twice for the same batch safe: the second call's
-- WHERE clause matches nothing once the first has already moved the row out
-- of `processing`.
-- ---------------------------------------------------------------------------

create or replace function public.telemetry_outbox_claim_batch(
  operation_token text,
  batch_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.telemetry_outbox_policy%rowtype;
  bounded_limit integer;
  lease_owner text;
  items jsonb;
  pending_remaining integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  policy := app_private.current_telemetry_outbox_policy();
  bounded_limit := greatest(1, least(coalesce(batch_limit, 50), 500));
  lease_owner := 'outbox-drain:' || gen_random_uuid()::text;

  -- A row whose lease expired and which has already spent its whole attempt
  -- budget has only ever crashed workers, never reported an explicit
  -- failure. Fail it now rather than hand it out again.
  update public.telemetry_outbox
  set status = 'failed',
      failed_at = clock_timestamp(),
      locked_by = null,
      locked_at = null,
      last_error = coalesce(
        last_error,
        'exhausted its retry budget after a stale processing lease'
      )
  where status = 'processing'
    and locked_at < clock_timestamp() - make_interval(secs => policy.lease_seconds)
    and attempt_count >= policy.max_attempts;

  with candidate as (
    select tenant_id, outbox_id
    from public.telemetry_outbox
    where attempt_count < policy.max_attempts
      and (
        (status = 'pending' and available_at <= clock_timestamp())
        or (
          status = 'processing'
          and locked_at < clock_timestamp()
            - make_interval(secs => policy.lease_seconds)
        )
      )
    order by available_at, created_at, tenant_id, outbox_id
    limit bounded_limit
    for update skip locked
  ),
  claimed as (
    update public.telemetry_outbox target
    set status = 'processing',
        locked_by = lease_owner,
        locked_at = clock_timestamp(),
        attempt_count = target.attempt_count + 1
    from candidate
    where target.tenant_id = candidate.tenant_id
      and target.outbox_id = candidate.outbox_id
    returning
      target.tenant_id,
      target.outbox_id,
      target.topic,
      target.payload,
      target.attempt_count,
      target.idempotency_key
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tenantId', claimed.tenant_id,
        'outboxId', claimed.outbox_id,
        'topic', claimed.topic,
        'payload', claimed.payload,
        'attemptCount', claimed.attempt_count,
        'idempotencyKey', claimed.idempotency_key
      )
      order by claimed.tenant_id, claimed.outbox_id
    ),
    '[]'::jsonb
  )
  into items
  from claimed;

  select count(*)::integer into pending_remaining
  from public.telemetry_outbox
  where status = 'pending' and available_at <= clock_timestamp();

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'leaseOwner', lease_owner,
    'leaseSeconds', policy.lease_seconds,
    'items', items,
    'remainingPending', pending_remaining
  );
end;
$$;

create or replace function public.telemetry_outbox_complete_batch(
  operation_token text,
  lease_owner text,
  items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  completed integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if lease_owner is null or length(lease_owner) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 500 then
    return jsonb_build_object('ok', false, 'code', 'invalid_batch');
  end if;

  update public.telemetry_outbox t
  set status = 'delivered',
      delivered_at = clock_timestamp(),
      locked_by = null,
      locked_at = null
  from jsonb_to_recordset(items) as supplied(tenant_id uuid, outbox_id text)
  where t.tenant_id = supplied.tenant_id
    and t.outbox_id = supplied.outbox_id
    and t.status = 'processing'
    and t.locked_by = lease_owner;
  get diagnostics completed = row_count;

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'completed', completed);
end;
$$;

create or replace function public.telemetry_outbox_fail_batch(
  operation_token text,
  lease_owner text,
  items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.telemetry_outbox_policy%rowtype;
  retried integer := 0;
  failed integer := 0;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if lease_owner is null or length(lease_owner) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 500 then
    return jsonb_build_object('ok', false, 'code', 'invalid_batch');
  end if;

  policy := app_private.current_telemetry_outbox_policy();

  -- Still within budget and reported retryable: back to `pending` with
  -- exponential backoff (capped at backoff_max_seconds).
  with supplied as (
    select
      s.tenant_id,
      s.outbox_id,
      coalesce(s.retryable, true) as retryable,
      left(coalesce(s.error_message, ''), 500) as error_message
    from jsonb_to_recordset(items) as s(
      tenant_id uuid, outbox_id text, retryable boolean, error_message text
    )
  )
  update public.telemetry_outbox t
  set status = 'pending',
      locked_by = null,
      locked_at = null,
      last_error = supplied.error_message,
      available_at = clock_timestamp() + make_interval(
        secs => least(
          policy.backoff_max_seconds,
          policy.backoff_base_seconds
            * (1 << least(greatest(t.attempt_count - 1, 0), 16))
        )
      )
  from supplied
  where t.tenant_id = supplied.tenant_id
    and t.outbox_id = supplied.outbox_id
    and t.status = 'processing'
    and t.locked_by = lease_owner
    and supplied.retryable
    and t.attempt_count < policy.max_attempts;
  get diagnostics retried = row_count;

  -- Either the caller reported it non-retryable, or the attempt budget is
  -- gone: terminal, so a poison row stops competing for future batches.
  with supplied as (
    select
      s.tenant_id,
      s.outbox_id,
      coalesce(s.retryable, true) as retryable,
      left(coalesce(s.error_message, ''), 500) as error_message
    from jsonb_to_recordset(items) as s(
      tenant_id uuid, outbox_id text, retryable boolean, error_message text
    )
  )
  update public.telemetry_outbox t
  set status = 'failed',
      failed_at = clock_timestamp(),
      locked_by = null,
      locked_at = null,
      last_error = supplied.error_message
  from supplied
  where t.tenant_id = supplied.tenant_id
    and t.outbox_id = supplied.outbox_id
    and t.status = 'processing'
    and t.locked_by = lease_owner
    and (not supplied.retryable or t.attempt_count >= policy.max_attempts);
  get diagnostics failed = row_count;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'retried', retried,
    'failed', failed
  );
end;
$$;

-- Retention. Only `delivered` or `failed` rows past the configured window are
-- ever candidates, and `telemetry_outbox_guard_delete` (above) refuses to
-- remove anything else regardless of what this WHERE clause does.
create or replace function public.telemetry_outbox_purge_expired(
  operation_token text,
  batch_limit integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.telemetry_outbox_policy%rowtype;
  bounded_limit integer;
  purged integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  policy := app_private.current_telemetry_outbox_policy();
  bounded_limit := greatest(1, least(coalesce(batch_limit, 500), 5000));

  with candidate as (
    select tenant_id, outbox_id
    from public.telemetry_outbox
    where (
        status = 'delivered'
        and delivered_at < clock_timestamp()
          - make_interval(days => policy.retention_days)
      )
      or (
        status = 'failed'
        and failed_at < clock_timestamp()
          - make_interval(days => policy.retention_days)
      )
    order by coalesce(delivered_at, failed_at)
    limit bounded_limit
    for update skip locked
  )
  delete from public.telemetry_outbox t
  using candidate c
  where t.tenant_id = c.tenant_id
    and t.outbox_id = c.outbox_id;
  get diagnostics purged = row_count;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'purged', purged,
    'retentionDays', policy.retention_days
  );
end;
$$;

-- Read-only operational visibility for the platform owner: queue depth by
-- status, the age of the oldest still-pending row, and the effective policy.
create or replace function public.platform_admin_telemetry_outbox_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  now_ts timestamptz := statement_timestamp();
  counts jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'processing', count(*) filter (where status = 'processing'),
    'delivered', count(*) filter (where status = 'delivered'),
    'failed', count(*) filter (where status = 'failed'),
    'oldestPendingAgeSeconds', (
      select floor(extract(epoch from now_ts - min(available_at)))::integer
      from public.telemetry_outbox
      where status = 'pending'
    )
  )
  into counts
  from public.telemetry_outbox;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', now_ts,
    'counts', counts,
    'policy', (
      select jsonb_build_object(
        'maxAttempts', p.max_attempts,
        'leaseSeconds', p.lease_seconds,
        'backoffBaseSeconds', p.backoff_base_seconds,
        'backoffMaxSeconds', p.backoff_max_seconds,
        'retentionDays', p.retention_days
      )
      from public.telemetry_outbox_policy p
      where p.policy_id = true
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.platform_admin_set_telemetry_outbox_policy(
  integer, integer, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.platform_admin_set_telemetry_outbox_policy(
  integer, integer, integer, integer, integer
) to authenticated;

revoke all on function public.platform_admin_telemetry_outbox_overview()
  from public, anon, authenticated, service_role;
grant execute on function public.platform_admin_telemetry_outbox_overview()
  to authenticated;

-- The worker entrypoints are reachable without a session and authorised only
-- by the operation secret, so `authenticated` is deliberately not granted: a
-- signed-in browser must never be able to reach the outbox drain at all.
revoke execute on function public.telemetry_outbox_claim_batch(text, integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.telemetry_outbox_complete_batch(
  text, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.telemetry_outbox_fail_batch(
  text, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.telemetry_outbox_purge_expired(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.telemetry_outbox_claim_batch(text, integer)
  to anon, service_role;
grant execute on function public.telemetry_outbox_complete_batch(text, text, jsonb)
  to anon, service_role;
grant execute on function public.telemetry_outbox_fail_batch(text, text, jsonb)
  to anon, service_role;
grant execute on function public.telemetry_outbox_purge_expired(text, integer)
  to anon, service_role;

commit;
