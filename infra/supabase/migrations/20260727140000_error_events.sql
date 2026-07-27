-- ============================================================
-- 20260727140000_error_events.sql
-- Error tracking, in-house.
--
-- PLAN.md Section 2 lists "error tracking, monitoring, alerting" as absent, and
-- notes how the 2026-07-27 outage of the agent, insights and billing panels was
-- found: a person noticed. This migration is the storage and query half of
-- fixing that.
--
-- WHY NOT SENTRY
--
-- A deliberate choice, made knowing the trade. Sentry gives grouping, release
-- correlation and alerting out of the box; this gives the first two and needs
-- the third built. What it buys is that the console keeps its seven runtime
-- dependencies, no error payload leaves the tenant's own database, and the
-- error store is subject to the same RLS and retention rules as everything
-- else -- which matters directly for the privacy work, since error payloads are
-- one of the classic places personal data leaks out of a system.
--
-- THE ALERTING GAP, STATED PLAINLY
--
-- A table nobody reads is not monitoring. `observability_claim_error_digest`
-- below is what closes that: a worker claims groups that have crossed a
-- threshold and mails them. Until that worker runs, this is a black box
-- recorder, not an alarm.
--
-- GROUPING
--
-- Two tables, not one. `error_events` is every occurrence; `error_groups` is
-- the aggregate a human actually reads. The fingerprint is computed here, from
-- the error kind, the route and a caller-supplied digest of the normalized
-- stack -- so the caller influences grouping only through those inputs and
-- cannot, say, send a random fingerprint per request and defeat aggregation.
--
-- PERSONAL DATA
--
-- `message` and `context` can contain anything the throwing code put in them,
-- which in practice sometimes means an email address or an id. They are capped,
-- they inherit `retain_until`, and the digest deliberately carries only
-- group-level fields (kind, route, counts) so an alert email never ships a
-- payload off the platform. Callers should still scrub before sending.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A capability for the error intake, extending the list last set by
--    20260727110000.
-- ---------------------------------------------------------------------------

alter table app_private.learning_operation_secrets
  drop constraint if exists learning_operation_secrets_capability_allowed;
alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_capability_allowed
  check (
    capability in (
      'conversation.answer.record',
      'knowledge.embedding.worker',
      'telemetry.outbox.drain',
      'billing.stripe.webhook',
      'billing.operations',
      'security.malware_scan',
      'observability.error_intake'
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
    'telemetry.outbox.drain',
    'billing.stripe.webhook',
    'billing.operations',
    'security.malware_scan',
    'observability.error_intake'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Storage.
-- ---------------------------------------------------------------------------

create table if not exists public.error_groups (
  fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{64}$'),
  -- Nullable on purpose: an error can be thrown before a tenant is resolved,
  -- and losing those is exactly how an auth bug stays invisible.
  tenant_id uuid references public.tenants(tenant_id),
  environment text not null check (length(environment) between 1 and 64),
  source text not null
    check (source in ('api', 'worker', 'edge', 'client')),
  severity text not null
    check (severity in ('warning', 'error', 'fatal')),
  error_kind text not null check (length(error_kind) between 1 and 200),
  route text check (length(route) <= 512),
  sample_message text check (length(sample_message) <= 2000),
  occurrence_count bigint not null default 0 check (occurrence_count >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_release_ref text check (length(last_release_ref) <= 200),
  -- Digest bookkeeping. notified_count is the occurrence_count as of the last
  -- alert, so the next alert fires on growth rather than re-reporting a group
  -- that has been quiet since.
  notified_at timestamptz,
  notified_count bigint not null default 0 check (notified_count >= 0),
  resolved_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists error_groups_unresolved_idx
  on public.error_groups (last_seen_at desc)
  where resolved_at is null;
create index if not exists error_groups_tenant_idx
  on public.error_groups (tenant_id, last_seen_at desc);

create table if not exists public.error_events (
  error_event_id uuid primary key default gen_random_uuid(),
  fingerprint text not null references public.error_groups(fingerprint),
  tenant_id uuid references public.tenants(tenant_id),
  occurred_at timestamptz not null default now(),
  severity text not null
    check (severity in ('warning', 'error', 'fatal')),
  message text check (length(message) <= 2000),
  stack text check (length(stack) <= 8000),
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object'),
  release_ref text check (length(release_ref) <= 200),
  route text check (length(route) <= 512),
  trace_id text check (length(trace_id) <= 200),
  request_id text check (length(request_id) <= 200),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  retain_until timestamptz not null,
  unique (idempotency_key)
);
create index if not exists error_events_fingerprint_idx
  on public.error_events (fingerprint, occurred_at desc);
create index if not exists error_events_retention_idx
  on public.error_events (retain_until);

alter table public.error_groups enable row level security;
alter table public.error_events enable row level security;

-- No policies are defined, so RLS denies everything. Reads go through the
-- platform-admin readout below, writes through the operation-secret intake.
-- Both are SECURITY DEFINER, which is the only way in by design.
revoke all on table public.error_groups from public, anon, authenticated;
revoke all on table public.error_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Intake. Server-side only -- a browser session cannot write here, for the
--    same reason it cannot write a malware verdict: anything reachable from a
--    session is forgeable by a session, and a monitoring store that can be
--    poisoned is worse than none.
--
--    'client' source errors therefore have to be relayed by a server route
--    holding the secret, not posted from the page.
-- ---------------------------------------------------------------------------

create or replace function public.observability_record_error(
  operation_token text,
  environment text,
  source text,
  severity text,
  error_kind text,
  stack_digest text,
  message text default null,
  stack text default null,
  route text default null,
  target_tenant_id uuid default null,
  release_ref text default null,
  trace_id text default null,
  request_id text default null,
  context jsonb default '{}'::jsonb,
  occurrence_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  now_ts timestamptz := clock_timestamp();
  computed_fingerprint text;
  normalized_severity text;
  normalized_source text;
  dedupe_key text;
  retention_days integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'observability.error_intake',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  normalized_severity := lower(btrim(coalesce(severity, '')));
  normalized_source := lower(btrim(coalesce(source, '')));

  if normalized_severity not in ('warning', 'error', 'fatal')
     or normalized_source not in ('api', 'worker', 'edge', 'client')
     or environment is null or length(btrim(environment)) not between 1 and 64
     or error_kind is null or length(btrim(error_kind)) not between 1 and 200
     or stack_digest is null or stack_digest !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(coalesce(context, '{}'::jsonb)) <> 'object'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  -- Grouping is decided here, not by the caller. Route is included so the same
  -- exception from two endpoints stays two groups -- they usually have
  -- different causes and different owners.
  computed_fingerprint := encode(
    extensions.digest(
      btrim(environment) || chr(31) || normalized_source || chr(31) ||
      btrim(error_kind) || chr(31) || coalesce(route, '') || chr(31) ||
      stack_digest,
      'sha256'
    ),
    'hex'
  );

  insert into public.error_groups as g (
    fingerprint, tenant_id, environment, source, severity, error_kind, route,
    sample_message, occurrence_count, first_seen_at, last_seen_at,
    last_release_ref
  )
  values (
    computed_fingerprint, target_tenant_id, btrim(environment),
    normalized_source, normalized_severity, btrim(error_kind), route,
    left(message, 2000), 1, now_ts, now_ts, release_ref
  )
  on conflict (fingerprint) do update
    set occurrence_count = g.occurrence_count + 1,
        last_seen_at = now_ts,
        last_release_ref = coalesce(excluded.last_release_ref, g.last_release_ref),
        -- A group that recurs is not resolved, whatever someone ticked.
        resolved_at = null,
        -- Escalate but never quietly downgrade: a group that has ever been
        -- fatal stays fatal until someone resolves it.
        severity = case
          when g.severity = 'fatal' or excluded.severity = 'fatal' then 'fatal'
          when g.severity = 'error' or excluded.severity = 'error' then 'error'
          else 'warning'
        end,
        updated_at = now_ts,
        record_version = g.record_version + 1;

  retention_days := coalesce(
    nullif(current_setting('app.error_retention_days', true), '')::integer,
    90
  );

  -- Without an occurrence_key every call is a distinct event. With one, a
  -- retried request records once -- the same property the rest of this schema
  -- gets from idempotency_key.
  dedupe_key := 'error:' || computed_fingerprint || chr(31) ||
    coalesce(occurrence_key, gen_random_uuid()::text);

  insert into public.error_events (
    fingerprint, tenant_id, occurred_at, severity, message, stack, context,
    release_ref, route, trace_id, request_id, idempotency_key, retain_until
  )
  values (
    computed_fingerprint, target_tenant_id, now_ts, normalized_severity,
    left(message, 2000), left(stack, 8000), coalesce(context, '{}'::jsonb),
    release_ref, route, trace_id, request_id, dedupe_key,
    now_ts + make_interval(days => retention_days)
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object(
    'ok', true,
    'fingerprint', computed_fingerprint
  );
end;
$$;

revoke execute on function public.observability_record_error(
  text, text, text, text, text, text, text, text, text, uuid, text, text, text,
  jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.observability_record_error(
  text, text, text, text, text, text, text, text, text, uuid, text, text, text,
  jsonb, text
) to anon, service_role;

-- ---------------------------------------------------------------------------
-- 4. The readout. Platform admin only -- this is cross-tenant by nature, so it
--    is deliberately not a tenant-scoped RPC.
-- ---------------------------------------------------------------------------

create or replace function public.platform_admin_error_readout(
  include_resolved boolean default false,
  max_groups integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  groups_summary jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(jsonb_agg(row_to_json(g)::jsonb order by g.last_seen_at desc), '[]'::jsonb)
  into groups_summary
  from (
    select
      eg.fingerprint,
      eg.tenant_id,
      eg.environment,
      eg.source,
      eg.severity,
      eg.error_kind,
      eg.route,
      eg.sample_message,
      eg.occurrence_count,
      eg.first_seen_at,
      eg.last_seen_at,
      eg.last_release_ref,
      eg.notified_at,
      eg.resolved_at
    from public.error_groups eg
    where include_resolved or eg.resolved_at is null
    order by eg.last_seen_at desc
    limit greatest(1, least(coalesce(max_groups, 50), 500))
  ) g;

  return jsonb_build_object(
    'ok', true,
    'groups', groups_summary,
    'generatedAt', to_char(
      clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    )
  );
end;
$$;

revoke execute on function public.platform_admin_error_readout(boolean, integer)
  from public, anon, service_role;
grant execute on function public.platform_admin_error_readout(boolean, integer)
  to authenticated;

create or replace function public.platform_admin_resolve_error_group(
  target_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_fingerprint is null or target_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  update public.error_groups
    set resolved_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        record_version = record_version + 1
  where fingerprint = target_fingerprint
    and resolved_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'resolved', true);
end;
$$;

revoke execute on function public.platform_admin_resolve_error_group(text)
  from public, anon, service_role;
grant execute on function public.platform_admin_resolve_error_group(text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The digest claim. This is the part that turns a table into an alarm.
--
--    A worker calls this on a schedule. It returns the groups that have grown
--    by at least `growth_threshold` occurrences since they were last reported,
--    and marks them reported in the same statement -- so two workers racing
--    cannot both mail the same group, and a worker that crashes after claiming
--    loses one digest rather than repeating forever.
--
--    Group-level fields only. No message, no stack, no context: an alert leaves
--    the platform by email and must not carry a payload with it.
-- ---------------------------------------------------------------------------

create or replace function public.observability_claim_error_digest(
  operation_token text,
  growth_threshold bigint default 1,
  max_groups integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  claimed jsonb;
begin
  if not app_private.learning_operation_token_is_valid(
    'observability.error_intake',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if growth_threshold is null or growth_threshold < 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  with due as (
    -- The delta is computed here, before the update. RETURNING reports the new
    -- row, where notified_count has already been set equal to
    -- occurrence_count, so computing it there would report zero every time.
    select
      eg.fingerprint,
      eg.occurrence_count - eg.notified_count as new_occurrences
    from public.error_groups eg
    where eg.resolved_at is null
      and eg.occurrence_count - eg.notified_count >= growth_threshold
    order by eg.last_seen_at desc
    limit greatest(1, least(coalesce(max_groups, 25), 100))
    for update skip locked
  ),
  marked as (
    update public.error_groups eg
      set notified_at = clock_timestamp(),
          notified_count = eg.occurrence_count,
          updated_at = clock_timestamp(),
          record_version = eg.record_version + 1
    from due
    where eg.fingerprint = due.fingerprint
    returning
      eg.fingerprint,
      eg.environment,
      eg.source,
      eg.severity,
      eg.error_kind,
      eg.route,
      eg.occurrence_count,
      due.new_occurrences,
      eg.first_seen_at,
      eg.last_seen_at,
      eg.last_release_ref
  )
  select coalesce(jsonb_agg(row_to_json(marked)::jsonb), '[]'::jsonb)
  into claimed
  from marked;

  return jsonb_build_object(
    'ok', true,
    'groups', claimed,
    'claimedAt', to_char(
      clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    )
  );
end;
$$;

revoke execute on function public.observability_claim_error_digest(
  text, bigint, integer
) from public, anon, authenticated, service_role;
grant execute on function public.observability_claim_error_digest(
  text, bigint, integer
) to anon, service_role;

commit;
