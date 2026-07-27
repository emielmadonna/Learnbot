-- Operational safety: the three failures that are invisible until they are
-- expensive or fatal.
--
--   1. The conversation operation secret had no producer. `0021` created
--      `app_private.learning_operation_secrets` with a mandatory `expires_at`,
--      and every migration since gates a server-only capability on it, but no
--      migration, seed or script ever inserted a row and nothing surfaced its
--      expiry. Chat therefore either never worked or stopped working on a date
--      nobody recorded. This adds an audited, platform-admin-only registration
--      and revocation path, a status read that reports days remaining, and a
--      health read the answer path can use to fail honestly.
--
--   2. `public.cost_ledger` (`0005`) had zero writers. Provider spend was
--      completely unmetered while a live `OPENAI_API_KEY` served a surface that
--      is about to accept anonymous widget traffic. This adds a durable spend
--      record, a per-tenant budget and rate policy enforced in SQL, and a
--      platform-owner read of cost per client.
--
--   3. Voice rate limiting lived in a per-process `Map`, which a serverless
--      platform resets on every cold start. The reservation function below is
--      the durable replacement.
--
-- Boundaries kept: no plaintext token is ever stored, returned or logged --
-- only a SHA-256 digest and its first eight hex characters, which identify a
-- secret without reconstructing it. Nothing here reads or records prompt text,
-- learner messages, source contents or audio; the cost ledger stores counts,
-- model keys and money only. Every new function is SECURITY DEFINER with
-- `search_path` fixed to `pg_catalog`, and every grant is the narrowest role
-- that has to call it.

begin;

-- ---------------------------------------------------------------------------
-- 1. Operation secret lifecycle
-- ---------------------------------------------------------------------------

-- The capability catalogue. It must stay in step with the CHECK constraint on
-- app_private.learning_operation_secrets.capability.
--
--   `conversation.answer.record` gates four consumers, so one secret unlocks
--   all of them:
--     * public.learning_record_assistant_message    (0021)
--     * public.learning_get_agent_directive         (20260725120000)
--     * public.learning_record_question_label       (20260726091000)
--     * public.widget_ask / widget answer recording (20260726093000/094000)
--
--   `knowledge.embedding.worker` gates the embedding worker claim/commit pair
--   (20260726095000).
create or replace function app_private.learning_operation_capabilities()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array[
    'conversation.answer.record',
    'knowledge.embedding.worker'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- Operator-facing identity for a secret. `label` names the place the plaintext
-- lives (for example the Vercel environment it was installed into) so a
-- rotation can be reasoned about without ever seeing the value.
alter table app_private.learning_operation_secrets
  add column if not exists label text,
  add column if not exists created_by_auth_user_id uuid references auth.users(id),
  add column if not exists revoked_by_auth_user_id uuid references auth.users(id),
  add column if not exists revoke_reason text;

alter table app_private.learning_operation_secrets
  drop constraint if exists learning_operation_secrets_label_check;
alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_label_check
  check (label is null or length(btrim(label)) between 1 and 80);

create index if not exists learning_operation_secrets_validity_idx
  on app_private.learning_operation_secrets (capability, expires_at desc)
  where status = 'active';

-- Append-only provisioning history. It records who registered or revoked which
-- secret and when, and deliberately holds only the digest prefix.
create table if not exists app_private.learning_operation_secret_events (
  event_id uuid primary key default gen_random_uuid(),
  operation_secret_id uuid,
  capability text not null,
  action text not null check (action in ('registered', 'revoked')),
  token_digest_prefix text not null check (token_digest_prefix ~ '^[0-9a-f]{8}$'),
  label text,
  expires_at timestamptz,
  actor_auth_user_id uuid,
  reason text check (reason is null or length(btrim(reason)) between 1 and 500),
  occurred_at timestamptz not null default now()
);
create index if not exists learning_operation_secret_events_capability_idx
  on app_private.learning_operation_secret_events (capability, occurred_at desc);

alter table app_private.learning_operation_secret_events
  enable row level security;
revoke all on table app_private.learning_operation_secret_events
  from public, anon, authenticated, service_role;
drop policy if exists learning_operation_secret_events_no_direct_access
  on app_private.learning_operation_secret_events;
create policy learning_operation_secret_events_no_direct_access
  on app_private.learning_operation_secret_events
  for all
  using (false)
  with check (false);

-- Counts the secrets that would satisfy the verifier right now. Overlapping
-- validity is the whole point: `learning_operation_token_is_valid` already
-- accepts *any* active, unexpired row for the capability, so a replacement can
-- be registered and installed while the outgoing secret is still accepted, and
-- rotation never needs a maintenance window.
create or replace function app_private.learning_operation_valid_secret_count(
  requested_capability text
)
returns integer
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select count(*)::integer
  from app_private.learning_operation_secrets s
  where s.capability = requested_capability
    and s.status = 'active'
    and s.expires_at > statement_timestamp();
$$;
revoke execute on function app_private.learning_operation_valid_secret_count(text)
  from public, anon, authenticated, service_role;

-- Registers a new secret for a capability. The plaintext is hashed on arrival
-- and is never stored, returned or written to any log line. Registering does
-- not disturb any existing secret, which is what makes rotation overlapping.
create or replace function public.platform_admin_register_operation_secret(
  requested_capability text,
  operation_token text,
  valid_days integer default 90,
  secret_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  normalized_capability text := btrim(coalesce(requested_capability, ''));
  normalized_label text := nullif(btrim(coalesce(secret_label, '')), '');
  digest_hex text;
  expiry timestamptz;
  created app_private.learning_operation_secrets%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if not (
    normalized_capability = any (app_private.learning_operation_capabilities())
  ) then
    return jsonb_build_object('ok', false, 'code', 'unknown_capability');
  end if;
  if valid_days is null or valid_days not between 1 and 365 then
    return jsonb_build_object('ok', false, 'code', 'invalid_validity_window');
  end if;
  if normalized_label is not null and length(normalized_label) > 80 then
    return jsonb_build_object('ok', false, 'code', 'invalid_label');
  end if;
  -- The verifier accepts 32..512 characters. Refuse anything shorter here as
  -- well as anything that is obviously not a generated secret, so a weak token
  -- can never be installed by accident.
  if operation_token is null
    or length(operation_token) not between 32 and 512
    or operation_token !~ '^[A-Za-z0-9._~+/=-]+$'
    or (
      select count(distinct character_row.value)
      from regexp_split_to_table(operation_token, '')
        as character_row(value)
    ) < 12
  then
    return jsonb_build_object('ok', false, 'code', 'weak_operation_token');
  end if;

  digest_hex := encode(
    extensions.digest(operation_token, 'sha256'),
    'hex'
  );
  expiry := statement_timestamp() + make_interval(days => valid_days);

  if exists (
    select 1
    from app_private.learning_operation_secrets s
    where s.capability = normalized_capability
      and s.token_hash = digest_hex
  ) then
    return jsonb_build_object('ok', false, 'code', 'secret_already_registered');
  end if;

  insert into app_private.learning_operation_secrets (
    capability,
    token_hash,
    status,
    expires_at,
    label,
    created_by_auth_user_id
  ) values (
    normalized_capability,
    digest_hex,
    'active',
    expiry,
    normalized_label,
    auth.uid()
  )
  returning * into created;

  insert into app_private.learning_operation_secret_events (
    operation_secret_id,
    capability,
    action,
    token_digest_prefix,
    label,
    expires_at,
    actor_auth_user_id
  ) values (
    created.operation_secret_id,
    normalized_capability,
    'registered',
    left(digest_hex, 8),
    normalized_label,
    expiry,
    auth.uid()
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'secretId', created.operation_secret_id,
    'capability', normalized_capability,
    'label', normalized_label,
    'digestPrefix', left(digest_hex, 8),
    'expiresAt', expiry,
    'daysRemaining', greatest(
      0,
      floor(extract(epoch from expiry - statement_timestamp()) / 86400)::integer
    ),
    'validSecretCount',
    app_private.learning_operation_valid_secret_count(normalized_capability)
  );
end;
$$;

-- Revokes a secret. The interlock refuses to remove the last valid secret for
-- a capability unless the caller says so explicitly, because doing that turns
-- every answer into an access denial with no other signal.
create or replace function public.platform_admin_revoke_operation_secret(
  target_secret_id uuid,
  revoke_reason text,
  allow_last boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  normalized_reason text := nullif(btrim(coalesce(revoke_reason, '')), '');
  target app_private.learning_operation_secrets%rowtype;
  remaining integer;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_secret_id is null
    or normalized_reason is null
    or length(normalized_reason) > 500
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select * into target
  from app_private.learning_operation_secrets s
  where s.operation_secret_id = target_secret_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'secret_not_found');
  end if;
  if target.status = 'revoked' then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true,
      'secretId', target.operation_secret_id,
      'capability', target.capability,
      'validSecretCount',
      app_private.learning_operation_valid_secret_count(target.capability)
    );
  end if;

  remaining := app_private.learning_operation_valid_secret_count(
    target.capability
  );
  if remaining <= 1
    and target.expires_at > statement_timestamp()
    and coalesce(allow_last, false) is false
  then
    return jsonb_build_object(
      'ok', false,
      'code', 'last_valid_secret',
      'capability', target.capability,
      'message',
      'Register the replacement secret before revoking the only valid one.'
    );
  end if;

  update app_private.learning_operation_secrets
  set status = 'revoked',
      revoked_at = statement_timestamp(),
      revoked_by_auth_user_id = auth.uid(),
      revoke_reason = normalized_reason
  where operation_secret_id = target_secret_id;

  insert into app_private.learning_operation_secret_events (
    operation_secret_id,
    capability,
    action,
    token_digest_prefix,
    label,
    expires_at,
    actor_auth_user_id,
    reason
  ) values (
    target.operation_secret_id,
    target.capability,
    'revoked',
    left(target.token_hash, 8),
    target.label,
    target.expires_at,
    auth.uid(),
    normalized_reason
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'secretId', target.operation_secret_id,
    'capability', target.capability,
    'validSecretCount',
    app_private.learning_operation_valid_secret_count(target.capability)
  );
end;
$$;

-- Expiry visibility. This is the read an operator looks at before a deploy:
-- one row per registered secret with days remaining, plus a per-capability
-- verdict that names the failure before it happens.
create or replace function public.platform_admin_operation_secret_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  capabilities text[] := app_private.learning_operation_capabilities();
  result jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(jsonb_agg(entry order by entry ->> 'capability'), '[]'::jsonb)
  into result
  from (
    select jsonb_build_object(
      'capability', capability_key,
      'validSecretCount', valid_count,
      'status', case
        when valid_count = 0 then 'unconfigured'
        when earliest_expiry <= statement_timestamp() + interval '7 days'
          then 'expiring_soon'
        else 'healthy'
      end,
      'earliestExpiresAt', earliest_expiry,
      'daysRemaining', case
        when earliest_expiry is null then null
        else greatest(
          0,
          floor(
            extract(epoch from earliest_expiry - statement_timestamp()) / 86400
          )::integer
        )
      end,
      'secrets', coalesce(secret_rows, '[]'::jsonb)
    ) as entry
    from unnest(capabilities) as capability_key
    cross join lateral (
      select
        count(*) filter (
          where s.status = 'active' and s.expires_at > statement_timestamp()
        )::integer as valid_count,
        min(s.expires_at) filter (
          where s.status = 'active' and s.expires_at > statement_timestamp()
        ) as earliest_expiry,
        jsonb_agg(
          jsonb_build_object(
            'secretId', s.operation_secret_id,
            'label', s.label,
            'digestPrefix', left(s.token_hash, 8),
            'status', case
              when s.status = 'revoked' then 'revoked'
              when s.expires_at <= statement_timestamp() then 'expired'
              else 'active'
            end,
            'expiresAt', s.expires_at,
            'createdAt', s.created_at,
            'revokedAt', s.revoked_at,
            'daysRemaining', greatest(
              0,
              floor(
                extract(epoch from s.expires_at - statement_timestamp()) / 86400
              )::integer
            )
          )
          order by s.expires_at desc
        ) as secret_rows
      from app_private.learning_operation_secrets s
      where s.capability = capability_key
    ) summary
  ) entries;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'capabilities', result,
    'healthy', not exists (
      select 1
      from unnest(capabilities) as capability_key
      where app_private.learning_operation_valid_secret_count(
        capability_key
      ) = 0
    )
  );
end;
$$;

-- Honest failure for the answer path. When the server-held token does not match
-- any currently valid secret, every downstream RPC denies in a way that is
-- indistinguishable from an authorization bug. This read -- which discloses no
-- secret material, only whether the platform is provisioned -- lets the answer
-- route say "the conversation operation secret is missing or expired" instead
-- of returning a generic denial or, worse, an ungrounded answer.
create or replace function public.learning_operation_capability_health(
  requested_capability text default 'conversation.answer.record'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  normalized_capability text := btrim(coalesce(requested_capability, ''));
  valid_count integer;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if not (
    normalized_capability = any (app_private.learning_operation_capabilities())
  ) then
    return jsonb_build_object('ok', false, 'code', 'unknown_capability');
  end if;

  valid_count := app_private.learning_operation_valid_secret_count(
    normalized_capability
  );
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'capability', normalized_capability,
    'configured', valid_count > 0,
    'code', case
      when valid_count > 0 then 'operation_secret_available'
      else 'operation_secret_unavailable'
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Cost metering
-- ---------------------------------------------------------------------------

-- `cost_ledger.estimated_cost_minor` is whole currency minor units. A single
-- chat completion routinely costs a fraction of one cent, so accumulating in
-- cents rounds every call to zero and no budget ever trips. Micro-units --
-- millionths of one major currency unit -- are the accumulation column;
-- `estimated_cost_minor` stays populated as the rounded, human-facing figure.
alter table public.cost_ledger
  add column if not exists estimated_cost_micro bigint not null default 0;
alter table public.cost_ledger
  drop constraint if exists cost_ledger_estimated_cost_micro_check;
alter table public.cost_ledger
  add constraint cost_ledger_estimated_cost_micro_check
  check (estimated_cost_micro >= 0);

-- Per-tenant budget and rate policy. Defaults are deliberately generous enough
-- for a real client day and small enough that a runaway loop or an abusive
-- anonymous widget visitor is capped within minutes rather than at invoice
-- time. The platform owner raises them per client.
create table if not exists public.tenant_cost_policies (
  tenant_id uuid primary key references public.tenants(tenant_id),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  daily_budget_micro bigint not null default 25000000
    check (daily_budget_micro >= 0),
  monthly_budget_micro bigint not null default 500000000
    check (monthly_budget_micro >= 0),
  max_calls_per_minute integer not null default 60
    check (max_calls_per_minute > 0),
  max_calls_per_day integer not null default 5000
    check (max_calls_per_day > 0),
  max_subject_calls_per_minute integer not null default 12
    check (max_subject_calls_per_minute > 0),
  enforcement text not null default 'enforce'
    check (enforcement in ('enforce', 'monitor')),
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_cost_policies enable row level security;
alter table public.tenant_cost_policies force row level security;
revoke all on table public.tenant_cost_policies from anon, authenticated;

-- A tenant administrator may read their own budget. Writes belong to the
-- platform owner through the definer RPC below, so there is deliberately no
-- insert, update or delete policy for any browser-reachable role.
drop policy if exists tenant_cost_policies_select on public.tenant_cost_policies;
create policy tenant_cost_policies_select on public.tenant_cost_policies
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));
drop policy if exists tenant_cost_policies_deny_anon
  on public.tenant_cost_policies;
create policy tenant_cost_policies_deny_anon on public.tenant_cost_policies
  for all to anon
  using (false)
  with check (false);
grant select on public.tenant_cost_policies to authenticated;

drop trigger if exists tenant_cost_policies_set_version
  on public.tenant_cost_policies;
create trigger tenant_cost_policies_set_version
before update on public.tenant_cost_policies
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_cost_policies (tenant_id)
select t.tenant_id
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id) do nothing;

-- Durable call counter. This is the replacement for the per-process `Map` that
-- a serverless cold start reset: every reservation decision, allow or deny,
-- lands here, so the limit holds across instances and the denials are
-- countable. Rows are pruned opportunistically; nothing depends on history
-- older than the widest window.
create table if not exists public.provider_rate_events (
  rate_event_id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(tenant_id),
  capability text not null check (length(capability) between 1 and 100),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('allow', 'deny')),
  deny_reason text,
  occurred_at timestamptz not null default clock_timestamp()
);
create index if not exists provider_rate_events_tenant_window_idx
  on public.provider_rate_events (tenant_id, occurred_at desc);
create index if not exists provider_rate_events_subject_window_idx
  on public.provider_rate_events (subject_hash, occurred_at desc);

alter table public.provider_rate_events enable row level security;
alter table public.provider_rate_events force row level security;
revoke all on table public.provider_rate_events
  from public, anon, authenticated;
drop policy if exists provider_rate_events_no_direct_access
  on public.provider_rate_events;
create policy provider_rate_events_no_direct_access
  on public.provider_rate_events
  for all
  using (false)
  with check (false);

-- Stable, non-reversible subject key. The raw principal or widget session id
-- never lands in the rate table.
create or replace function app_private.provider_rate_subject_hash(
  target_tenant_id uuid,
  subject_key text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.digest(
      coalesce(target_tenant_id::text, '') || ':' ||
      coalesce(nullif(btrim(subject_key), ''), 'anonymous'),
      'sha256'
    ),
    'hex'
  );
$$;
revoke execute on function app_private.provider_rate_subject_hash(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function app_private.tenant_cost_policy(target_tenant_id uuid)
returns public.tenant_cost_policies
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  cost_policy public.tenant_cost_policies%rowtype;
begin
  select * into cost_policy
  from public.tenant_cost_policies p
  where p.tenant_id = target_tenant_id;
  if found then
    return cost_policy;
  end if;
  insert into public.tenant_cost_policies (tenant_id)
  values (target_tenant_id)
  on conflict (tenant_id) do nothing;
  select * into cost_policy
  from public.tenant_cost_policies p
  where p.tenant_id = target_tenant_id;
  return cost_policy;
end;
$$;
revoke execute on function app_private.tenant_cost_policy(uuid)
  from public, anon, authenticated, service_role;

-- The enforcement decision itself. Order matters: a budget breach is reported
-- before a rate breach, because "you are out of money" and "you are going too
-- fast" call for different operator responses.
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

  -- Opportunistic pruning keeps the counter table bounded without a scheduler.
  if random() < 0.01 then
    delete from public.provider_rate_events
    where occurred_at < now_ts - interval '2 days';
  end if;

  select count(*)::integer into subject_minute
  from public.provider_rate_events e
  where e.subject_hash = subject_digest
    and e.decision = 'allow'
    and e.occurred_at > now_ts - interval '1 minute';

  select
    count(*) filter (
      where e.occurred_at > now_ts - interval '1 minute'
    )::integer,
    count(*)::integer
  into tenant_minute, tenant_day
  from public.provider_rate_events e
  where e.tenant_id = target_tenant_id
    and e.decision = 'allow'
    and e.occurred_at > now_ts - interval '1 day';

  select coalesce(sum(c.estimated_cost_micro), 0)::bigint into day_spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= date_trunc('day', now_ts);

  select coalesce(sum(c.estimated_cost_micro), 0)::bigint into month_spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= date_trunc('month', now_ts);

  -- A freshly bootstrapped tenant is legitimately still `provisioning`, so only
  -- an explicit suspension or deletion refuses spend here.
  if tenant_status in ('suspended', 'deleted') then
    deny_code := 'tenant_suspended';
  elsif month_spend >= cost_policy.monthly_budget_micro then
    deny_code := 'monthly_budget_exceeded';
  elsif day_spend >= cost_policy.daily_budget_micro then
    deny_code := 'daily_budget_exceeded';
  elsif tenant_day >= cost_policy.max_calls_per_day then
    deny_code := 'tenant_daily_call_limit';
  elsif tenant_minute >= cost_policy.max_calls_per_minute then
    deny_code := 'tenant_rate_limited';
    retry_after := 60;
  elsif subject_minute >= cost_policy.max_subject_calls_per_minute then
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

-- Pre-call reservation. The answer, classification and voice paths call this
-- before spending anything. When `target_tenant_id` is supplied the caller is a
-- trusted server acting for an anonymous visitor (the widget), and a valid
-- operation token is mandatory; otherwise the tenant is resolved from the
-- caller's own verified membership and a browser cannot name another tenant.
create or replace function public.learning_reserve_provider_call(
  requested_capability text,
  subject_key text,
  target_tenant_id uuid default null,
  operation_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  resolved_tenant_id uuid;
begin
  if target_tenant_id is not null then
    if not app_private.learning_operation_token_is_valid(
      'conversation.answer.record',
      operation_token
    ) then
      return jsonb_build_object(
        'ok', false,
        'code', 'operation_secret_unavailable'
      );
    end if;
    resolved_tenant_id := target_tenant_id;
  else
    select * into caller from app_private.learning_rpc_context();
    if not found then
      return jsonb_build_object(
        'ok', false,
        'code', 'tenant_selection_required'
      );
    end if;
    resolved_tenant_id := caller.tenant_id;
  end if;

  return app_private.provider_call_decision(
    resolved_tenant_id,
    requested_capability,
    subject_key
  );
end;
$$;

-- Post-call metering. This is append-only and idempotent: a retried write with
-- the same key returns the original entry rather than double-charging. It must
-- never be allowed to break answering, so the caller treats every failure here
-- as a log line, not an error.
create or replace function public.learning_record_provider_cost(
  requested_capability text,
  provider_key text,
  model_key text,
  quantity numeric,
  unit text,
  estimated_cost_micro bigint,
  trace_id text,
  idempotency_key text,
  request_id text default null,
  target_conversation_id uuid default null,
  provider_metadata_safe jsonb default '{}'::jsonb,
  target_tenant_id uuid default null,
  operation_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  resolved_tenant_id uuid;
  cost_policy public.tenant_cost_policies%rowtype;
  safe_metadata jsonb;
  existing public.cost_ledger%rowtype;
  created public.cost_ledger%rowtype;
  linked_conversation_id uuid := null;
begin
  if target_tenant_id is not null then
    if not app_private.learning_operation_token_is_valid(
      'conversation.answer.record',
      operation_token
    ) then
      return jsonb_build_object(
        'ok', false,
        'code', 'operation_secret_unavailable'
      );
    end if;
    resolved_tenant_id := target_tenant_id;
  else
    select * into caller from app_private.learning_rpc_context();
    if not found then
      return jsonb_build_object(
        'ok', false,
        'code', 'tenant_selection_required'
      );
    end if;
    resolved_tenant_id := caller.tenant_id;
  end if;

  if requested_capability is null
    or length(btrim(requested_capability)) not between 1 and 100
    or provider_key is null
    or length(btrim(provider_key)) not between 1 and 100
    or (model_key is not null and length(model_key) > 100)
    or quantity is null
    or quantity < 0
    or unit is null
    or length(btrim(unit)) not between 1 and 40
    or estimated_cost_micro is null
    or estimated_cost_micro < 0
    or estimated_cost_micro > 100000000
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  -- Metadata is capped and must be an object. Prompt text, learner messages and
  -- transcripts have no business in the ledger; the bound makes an accidental
  -- paste impossible to store.
  safe_metadata := case
    when provider_metadata_safe is null
      or jsonb_typeof(provider_metadata_safe) <> 'object'
      or length(provider_metadata_safe::text) > 2000
    then '{}'::jsonb
    else provider_metadata_safe
  end;

  select * into existing
  from public.cost_ledger c
  where c.tenant_id = resolved_tenant_id
    and c.idempotency_key = learning_record_provider_cost.idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true,
      'costEntryId', existing.cost_entry_id
    );
  end if;

  if target_conversation_id is not null then
    select c.conversation_id into linked_conversation_id
    from public.conversations c
    where c.tenant_id = resolved_tenant_id
      and c.conversation_id = target_conversation_id;
  end if;

  cost_policy := app_private.tenant_cost_policy(resolved_tenant_id);

  insert into public.cost_ledger (
    tenant_id,
    request_id,
    trace_id,
    conversation_id,
    capability,
    provider_key,
    model_key,
    quantity,
    unit,
    estimated_cost_micro,
    -- One minor unit is 10 000 micro units. Rounding up keeps the human-facing
    -- figure from under-reporting a real charge.
    estimated_cost_minor,
    currency,
    funding_source,
    provider_metadata_safe,
    idempotency_key,
    occurred_at,
    retain_until
  ) values (
    resolved_tenant_id,
    left(coalesce(request_id, trace_id), 200),
    trace_id,
    linked_conversation_id,
    btrim(requested_capability),
    btrim(provider_key),
    nullif(btrim(coalesce(model_key, '')), ''),
    quantity,
    btrim(unit),
    estimated_cost_micro,
    ceil(estimated_cost_micro::numeric / 10000)::bigint,
    cost_policy.currency,
    'platform',
    safe_metadata,
    idempotency_key,
    statement_timestamp(),
    statement_timestamp() + interval '7 years'
  )
  returning * into created;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'costEntryId', created.cost_entry_id,
    'estimatedCostMicro', created.estimated_cost_micro,
    'currency', created.currency
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Platform-owner spend visibility and budget control
-- ---------------------------------------------------------------------------

create or replace function public.platform_admin_cost_overview(
  window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  bounded_days integer := least(greatest(coalesce(window_days, 30), 1), 180);
  now_ts timestamptz := statement_timestamp();
  window_start timestamptz;
  tenants_summary jsonb;
  totals jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  window_start := now_ts - make_interval(days => bounded_days);

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'tenantId', row_data.tenant_id,
          'slug', row_data.slug,
          'displayName', row_data.display_name,
          'status', row_data.status,
          'currency', row_data.currency,
          'enforcement', row_data.enforcement,
          'daySpendMicro', row_data.day_spend,
          'monthSpendMicro', row_data.month_spend,
          'windowSpendMicro', row_data.window_spend,
          'dailyBudgetMicro', row_data.daily_budget_micro,
          'monthlyBudgetMicro', row_data.monthly_budget_micro,
          'monthBudgetUsedPercent', case
            when row_data.monthly_budget_micro = 0 then null
            else round(
              row_data.month_spend * 100.0 / row_data.monthly_budget_micro,
              2
            )
          end,
          'windowCalls', row_data.window_calls,
          'callsToday', row_data.calls_today,
          'denialsToday', row_data.denials_today,
          'lastSpendAt', row_data.last_spend_at,
          'capabilities', row_data.capabilities
        )
        order by row_data.window_spend desc, row_data.display_name
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'tenants', count(*),
      'windowSpendMicro', coalesce(sum(row_data.window_spend), 0),
      'monthSpendMicro', coalesce(sum(row_data.month_spend), 0),
      'daySpendMicro', coalesce(sum(row_data.day_spend), 0),
      'denialsToday', coalesce(sum(row_data.denials_today), 0)
    )
  into tenants_summary, totals
  from (
    select
      t.tenant_id,
      t.slug,
      t.display_name,
      t.status,
      p.currency,
      p.enforcement,
      p.daily_budget_micro,
      p.monthly_budget_micro,
      coalesce(spend.day_spend, 0)::bigint as day_spend,
      coalesce(spend.month_spend, 0)::bigint as month_spend,
      coalesce(spend.window_spend, 0)::bigint as window_spend,
      coalesce(spend.window_calls, 0)::bigint as window_calls,
      spend.last_spend_at,
      coalesce(rates.calls_today, 0)::bigint as calls_today,
      coalesce(rates.denials_today, 0)::bigint as denials_today,
      coalesce(spend.capabilities, '[]'::jsonb) as capabilities
    from public.tenants t
    left join public.tenant_cost_policies p on p.tenant_id = t.tenant_id
    left join lateral (
      select
        sum(c.estimated_cost_micro) filter (
          where c.occurred_at >= date_trunc('day', now_ts)
        ) as day_spend,
        sum(c.estimated_cost_micro) filter (
          where c.occurred_at >= date_trunc('month', now_ts)
        ) as month_spend,
        sum(c.estimated_cost_micro) as window_spend,
        count(*) as window_calls,
        max(c.occurred_at) as last_spend_at,
        jsonb_agg(distinct c.capability) as capabilities
      from public.cost_ledger c
      where c.tenant_id = t.tenant_id
        and c.occurred_at >= window_start
    ) spend on true
    left join lateral (
      select
        count(*) filter (where e.decision = 'allow') as calls_today,
        count(*) filter (where e.decision = 'deny') as denials_today
      from public.provider_rate_events e
      where e.tenant_id = t.tenant_id
        and e.occurred_at >= date_trunc('day', now_ts)
    ) rates on true
    where t.deleted_at is null
  ) row_data;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'windowDays', bounded_days,
    'microUnitsPerMajorUnit', 1000000,
    'generatedAt', now_ts,
    'totals', totals,
    'tenants', tenants_summary,
    'operationSecrets', public.platform_admin_operation_secret_status()
  );
end;
$$;

create or replace function public.platform_admin_set_tenant_cost_policy(
  target_tenant_id uuid,
  daily_budget_micro bigint,
  monthly_budget_micro bigint,
  max_calls_per_minute integer,
  max_calls_per_day integer,
  max_subject_calls_per_minute integer,
  enforcement text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.tenant_cost_policies%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or daily_budget_micro is null or daily_budget_micro < 0
    or monthly_budget_micro is null or monthly_budget_micro < 0
    or monthly_budget_micro < daily_budget_micro
    or max_calls_per_minute is null or max_calls_per_minute not between 1 and 10000
    or max_calls_per_day is null or max_calls_per_day not between 1 and 1000000
    or max_subject_calls_per_minute is null
    or max_subject_calls_per_minute not between 1 and 1000
    or enforcement is null
    or enforcement not in ('enforce', 'monitor')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1
    from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  perform app_private.tenant_cost_policy(target_tenant_id);
  update public.tenant_cost_policies p
  set daily_budget_micro =
        platform_admin_set_tenant_cost_policy.daily_budget_micro,
      monthly_budget_micro =
        platform_admin_set_tenant_cost_policy.monthly_budget_micro,
      max_calls_per_minute =
        platform_admin_set_tenant_cost_policy.max_calls_per_minute,
      max_calls_per_day =
        platform_admin_set_tenant_cost_policy.max_calls_per_day,
      max_subject_calls_per_minute =
        platform_admin_set_tenant_cost_policy.max_subject_calls_per_minute,
      enforcement = platform_admin_set_tenant_cost_policy.enforcement,
      updated_by = auth.uid()
  where p.tenant_id = target_tenant_id
  returning * into updated;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.cost_policy_updated',
    'tenant_cost_policy',
    target_tenant_id::text,
    'allow',
    'Platform administrator updated the provider budget and rate policy.',
    'daily=' || updated.daily_budget_micro::text ||
      ';monthly=' || updated.monthly_budget_micro::text ||
      ';enforcement=' || updated.enforcement
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', updated.tenant_id,
    'currency', updated.currency,
    'dailyBudgetMicro', updated.daily_budget_micro,
    'monthlyBudgetMicro', updated.monthly_budget_micro,
    'maxCallsPerMinute', updated.max_calls_per_minute,
    'maxCallsPerDay', updated.max_calls_per_day,
    'maxSubjectCallsPerMinute', updated.max_subject_calls_per_minute,
    'enforcement', updated.enforcement,
    'recordVersion', updated.record_version
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Voice honours the tenant's configured voice
-- ---------------------------------------------------------------------------

-- `tenant_branding.agent_voice` has been editable and displayed since
-- 20260725120000 and read by nothing. A white-label client chose a voice and
-- heard a different one. This is the cheap, tenant-bound read the voice routes
-- use; it carries no persona text, so it is safe for every member.
create or replace function public.tenant_get_voice_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  branding record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  select b.agent_voice, b.assistant_name
  into branding
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
    and b.status = 'published'
  order by b.version_number desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'voice', nullif(btrim(coalesce(branding.agent_voice, '')), ''),
    'assistantName', nullif(btrim(coalesce(branding.assistant_name, '')), ''),
    'source', case
      when nullif(btrim(coalesce(branding.agent_voice, '')), '') is null
        then 'default'
      else 'tenant'
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Least-privilege grants
-- ---------------------------------------------------------------------------

revoke all on function public.platform_admin_register_operation_secret(
  text, text, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_revoke_operation_secret(
  uuid, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_operation_secret_status()
  from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_cost_overview(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_set_tenant_cost_policy(
  uuid, bigint, bigint, integer, integer, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.learning_operation_capability_health(text)
  from public, anon, authenticated, service_role;
revoke all on function public.learning_reserve_provider_call(
  text, text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.learning_record_provider_cost(
  text, text, text, numeric, text, bigint, text, text, text, uuid, jsonb, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.tenant_get_voice_profile()
  from public, anon, authenticated, service_role;

-- Platform administration is checked inside each function, and only a
-- signed-in user can ever be a platform administrator.
grant execute on function public.platform_admin_register_operation_secret(
  text, text, integer, text
) to authenticated;
grant execute on function public.platform_admin_revoke_operation_secret(
  uuid, text, boolean
) to authenticated;
grant execute on function public.platform_admin_operation_secret_status()
  to authenticated;
grant execute on function public.platform_admin_cost_overview(integer)
  to authenticated;
grant execute on function public.platform_admin_set_tenant_cost_policy(
  uuid, bigint, bigint, integer, integer, integer, text
) to authenticated;

grant execute on function public.learning_operation_capability_health(text)
  to authenticated;
grant execute on function public.tenant_get_voice_profile() to authenticated;

-- The reservation and metering entry points serve both the signed-in console
-- and the trusted server that fronts anonymous widget traffic. The anonymous
-- form is unreachable without a valid operation token, and the token lives only
-- in the application server environment.
grant execute on function public.learning_reserve_provider_call(
  text, text, uuid, text
) to authenticated, anon;
grant execute on function public.learning_record_provider_cost(
  text, text, text, numeric, text, bigint, text, text, text, uuid, jsonb, uuid, text
) to authenticated, anon;

commit;
