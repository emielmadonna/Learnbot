-- Billing, margins and Stripe entitlement (PLAN.md S10).
--
-- Two revenue lines land here:
--
--   A. Subscription -> entitlement. A Stripe subscription state change SETS
--      public.tenant_sections. A platform administrator keeps a manual
--      override (comping an account, debugging a client), and that override
--      is tracked as a distinct `source` on the row -- never silently
--      indistinguishable from a paid entitlement.
--
--   B. Usage -> margin. A per-tenant margin policy (multiplier, fixed
--      markup, floor) turns `public.cost_ledger`'s true provider cost into a
--      billable amount, reported to Stripe as metered usage.
--
-- Non-negotiables enforced here, not just in the UI:
--
--   1. A creator never sees raw provider cost -- only their price. True cost,
--      margin and billed amount live behind platform-admin-gated RPCs only
--      (`platform_admin_*`). `tenant_get_billing_summary` -- the one surface
--      a creator can reach -- returns plan, status and billed total, and
--      nothing else.
--   2. We never touch card data. Nothing here accepts a card number, CVC or
--      expiry. Every Stripe interaction is hosted Checkout, the hosted
--      Billing Portal, or server-to-server webhook/API calls.
--   3. Webhooks are verified and deduped. `billing_webhook_ingest` requires a
--      valid operation token (the same mechanism gating the answer and
--      embedding worker paths) and a unique `public.billing_stripe_events`
--      row per Stripe event id -- a retried delivery is a no-op.
--   4. Usage reporting is idempotent. `public.billing_usage_reports` carries
--      `unique (tenant_id, cost_entry_id)`: a `cost_ledger` row can be
--      reported at most once, ever, enforced by the database, not the
--      caller's care.
--   5. Billing failure never stops learning. `agent`, `course`, `people` and
--      `settings` are the protected "core" sections -- no subscription
--      state, dunning stage or webhook failure ever disables them. Only the
--      premium section (`insights`) is plan-governed.
--   6. Dunning is a sequence: a failed payment opens a grace window
--      (`dunning_stage = 'grace'`, `grace_period_ends_at` set) during which
--      nothing changes but the creator's own billing summary names the
--      deadline; only after the window elapses does the sweep advance the
--      tenant to `dark`, which is the one moment premium sections go dark.
--   7. Tax is Stripe Tax's job. Nothing here computes VAT.

begin;

-- ---------------------------------------------------------------------------
-- 1. A new operation-secret capability for the two trusted-server paths that
--    have no user session: the Stripe webhook, and the scheduled usage
--    report / dunning sweep. Same mechanism as `knowledge.embedding.worker`
--    and `telemetry.outbox.drain` -- a server-held secret, verified inside
--    the definer RPC, never reachable from `authenticated`.
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
      'billing.operations'
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
    'billing.operations'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Per-tenant margin policy. Platform-admin only, in every direction:
--    force RLS, no grants to anon or authenticated, and a deny-all policy so
--    even a future PostgREST exposure cannot read it. The only door in is a
--    SECURITY DEFINER function owned by a role with BYPASSRLS, exactly the
--    pattern `tenant_cost_policies` already established.
-- ---------------------------------------------------------------------------

create table public.tenant_margin_policies (
  tenant_id uuid primary key references public.tenants(tenant_id),
  -- Multiplier applied to true cost. Not floored at 1: an admin comping or
  -- discounting a friendly account below cost is a legitimate business call,
  -- not a bug this constraint should block.
  margin_multiplier numeric(10, 4) not null default 1.5
    check (margin_multiplier >= 0),
  fixed_markup_micro bigint not null default 0
    check (fixed_markup_micro >= 0),
  floor_micro bigint not null default 0
    check (floor_micro >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_margin_policies enable row level security;
alter table public.tenant_margin_policies force row level security;
revoke all on table public.tenant_margin_policies from anon, authenticated;

-- Deliberately no select policy for `authenticated`, not even the owning
-- tenant's own admin. PLAN.md S10.2 treats margin as a security boundary:
-- true cost, margin and billed amount are platform-admin-only, full stop.
drop policy if exists tenant_margin_policies_deny_all
  on public.tenant_margin_policies;
create policy tenant_margin_policies_deny_all on public.tenant_margin_policies
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger tenant_margin_policies_set_version
before update on public.tenant_margin_policies
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_margin_policies (tenant_id)
select t.tenant_id
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id) do nothing;

create or replace function app_private.tenant_margin_policy(
  target_tenant_id uuid
)
returns public.tenant_margin_policies
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.tenant_margin_policies%rowtype;
begin
  select * into policy
  from public.tenant_margin_policies p
  where p.tenant_id = target_tenant_id;
  if found then
    return policy;
  end if;
  insert into public.tenant_margin_policies (tenant_id)
  values (target_tenant_id)
  on conflict (tenant_id) do nothing;
  select * into policy
  from public.tenant_margin_policies p
  where p.tenant_id = target_tenant_id;
  return policy;
end;
$$;
revoke execute on function app_private.tenant_margin_policy(uuid)
  from public, anon, authenticated, service_role;

-- Billable amount = greatest(cost * multiplier + fixed markup, floor). Plain
-- scalar arguments rather than the row type, on purpose: this is called both
-- from VOLATILE, get-or-create contexts and from STABLE overview reads that
-- must not call anything that could write, and scalars keep it usable from
-- both without a volatility mismatch.
create or replace function app_private.billing_apply_margin(
  cost_micro bigint,
  margin_multiplier numeric,
  fixed_markup_micro bigint,
  floor_micro bigint
)
returns bigint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select greatest(
    round(
      coalesce(cost_micro, 0) * coalesce(margin_multiplier, 1)
    )::bigint + coalesce(fixed_markup_micro, 0),
    coalesce(floor_micro, 0)
  );
$$;
revoke execute on function app_private.billing_apply_margin(
  bigint, numeric, bigint, bigint
) from public, anon, authenticated, service_role;

-- `cost_ledger` accumulates in micro units (millionths of a major currency
-- unit); Stripe's classic usage-record quantity is reported in whole minor
-- units (cents) against a metered price configured at $0.01/unit. 10,000
-- micro units make one minor unit (1,000,000 micro / 100 minor per major).
create or replace function app_private.billing_micro_to_minor(
  value_micro bigint
)
returns bigint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select round(coalesce(value_micro, 0) / 10000.0)::bigint;
$$;
revoke execute on function app_private.billing_micro_to_minor(bigint)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Subscription state. Also platform/system only via RPC -- a tenant
--    reads its own plan and status through `tenant_get_billing_summary`
--    below, never this table directly.
-- ---------------------------------------------------------------------------

create table public.tenant_subscriptions (
  tenant_id uuid primary key references public.tenants(tenant_id),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  -- The subscription item bound to the metered usage price, captured from
  -- `customer.subscription.*` webhooks. Usage reporting requires this.
  stripe_metered_item_id text,
  plan text not null default 'unconfirmed'
    check (plan in ('unconfirmed', 'starter', 'growth', 'enterprise')),
  -- Mirrors the section-level `source` column below at the subscription
  -- level: 'stripe' means the last write came from a verified webhook,
  -- 'manual' means a platform administrator comped or corrected it by hand.
  plan_source text not null default 'manual'
    check (plan_source in ('manual', 'stripe')),
  subscription_status text not null default 'none'
    check (subscription_status in (
      'none', 'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )),
  -- The dunning sequence: none -> grace (payment failed, window open,
  -- nothing disabled yet) -> dark (window elapsed, premium sections
  -- suppressed). Never touches the core sections at any stage.
  dunning_stage text not null default 'none'
    check (dunning_stage in ('none', 'grace', 'dark')),
  grace_period_days integer not null default 7
    check (grace_period_days between 1 and 60),
  grace_period_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_stripe_event_id text,
  last_stripe_event_at timestamptz,
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_customer_id),
  unique (stripe_subscription_id)
);

alter table public.tenant_subscriptions enable row level security;
alter table public.tenant_subscriptions force row level security;
revoke all on table public.tenant_subscriptions from anon, authenticated;
drop policy if exists tenant_subscriptions_deny_all
  on public.tenant_subscriptions;
create policy tenant_subscriptions_deny_all on public.tenant_subscriptions
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger tenant_subscriptions_set_version
before update on public.tenant_subscriptions
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_subscriptions (tenant_id)
select t.tenant_id
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id) do nothing;

create or replace function app_private.tenant_subscription_row(
  target_tenant_id uuid
)
returns public.tenant_subscriptions
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  row_data public.tenant_subscriptions%rowtype;
begin
  select * into row_data
  from public.tenant_subscriptions s
  where s.tenant_id = target_tenant_id;
  if found then
    return row_data;
  end if;
  insert into public.tenant_subscriptions (tenant_id)
  values (target_tenant_id)
  on conflict (tenant_id) do nothing;
  select * into row_data
  from public.tenant_subscriptions s
  where s.tenant_id = target_tenant_id;
  return row_data;
end;
$$;
revoke execute on function app_private.tenant_subscription_row(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Section entitlement projection. `agent`, `course`, `people` and
--    `settings` are never touched by billing -- a Stripe outage or an
--    unresolved dunning stage must never cut a student off mid-lesson.
--    `platform` is never touched either: it is the platform-owner console,
--    unrelated to what a client pays for. Only `insights` is plan-governed.
-- ---------------------------------------------------------------------------

create or replace function app_private.billing_core_sections()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array['agent', 'course', 'people', 'settings']::text[];
$$;
revoke execute on function app_private.billing_core_sections()
  from public, anon, authenticated, service_role;

create or replace function app_private.billing_premium_sections_for_plan(
  plan_key text
)
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case lower(btrim(coalesce(plan_key, '')))
    when 'growth' then array['insights']::text[]
    when 'enterprise' then array['insights']::text[]
    else array[]::text[]
  end;
$$;
revoke execute on function app_private.billing_premium_sections_for_plan(text)
  from public, anon, authenticated, service_role;

-- `source` records who is currently steering a section: 'unset' is the
-- programmatic default from initial tenant provisioning (nobody has ever
-- projected a plan or manually toggled it yet); 'subscription' means the
-- last write came from `billing_apply_plan_entitlements`; 'manual_override'
-- means a platform administrator explicitly flipped it and no subscription
-- projection may touch it again until the override is cleared. This is an
-- ADD COLUMN on an existing table, not an edit to the migration that created
-- it -- `platform_admin_set_tenant_section` (20260725123000) is untouched
-- and, because its own INSERT/UPDATE never names this column, its writes
-- fall through to the trigger below exactly as intended.
alter table public.tenant_sections
  add column if not exists source text not null default 'unset';
alter table public.tenant_sections
  drop constraint if exists tenant_sections_source_check;
alter table public.tenant_sections
  add constraint tenant_sections_source_check
  check (source in ('unset', 'subscription', 'manual_override'));

-- Fires on UPDATE only: the seed and provisioning INSERTs (already committed
-- migrations, and `platform_admin_create_tenant`'s per-tenant seed) take the
-- column default and are left alone. Every subsequent UPDATE -- whether from
-- the pre-existing `platform_admin_set_tenant_section` RPC or from a fresh
-- INSERT ... ON CONFLICT DO UPDATE here -- is stamped 'manual_override'
-- unless the writer explicitly marks itself as the subscription projection
-- via a transaction-local flag, which is exactly what
-- `billing_apply_plan_entitlements` and the override-clearing RPC below do.
create or replace function app_private.tenant_sections_stamp_override_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if coalesce(
    current_setting('learningbot.billing_entitlement_projection', true),
    ''
  ) = 'true' then
    new.source := 'subscription';
  else
    new.source := 'manual_override';
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_sections_stamp_override_source
  on public.tenant_sections;
create trigger tenant_sections_stamp_override_source
before update on public.tenant_sections
for each row execute function app_private.tenant_sections_stamp_override_source();

-- Projects a plan (core sections always on, premium sections per plan,
-- unless `suppress_premium` -- the "sections go dark" dunning step) onto
-- `tenant_sections`. Rows currently `manual_override` are left untouched:
-- the WHERE clause on the upsert means the trigger above never even fires
-- for them, so an admin's explicit choice survives every future projection.
create or replace function app_private.billing_apply_plan_entitlements(
  target_tenant_id uuid,
  plan_key text,
  suppress_premium boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  entitled text[];
  definition record;
  desired boolean;
begin
  entitled := app_private.billing_core_sections();
  if not coalesce(suppress_premium, false) then
    entitled := entitled
      || app_private.billing_premium_sections_for_plan(plan_key);
  end if;

  perform set_config('learningbot.billing_entitlement_projection', 'true', true);

  for definition in
    select d.section_key
    from app_private.tenant_section_definitions() d
    where d.section_key <> 'platform'
  loop
    desired := definition.section_key = any (entitled);
    insert into public.tenant_sections (
      tenant_id, section_key, enabled, source, idempotency_key
    ) values (
      target_tenant_id,
      definition.section_key,
      desired,
      'subscription',
      'tenant-section:' || target_tenant_id::text || ':' || definition.section_key
    )
    on conflict (tenant_id, section_key) do update
      set enabled = excluded.enabled
      where public.tenant_sections.source <> 'manual_override';
  end loop;

  perform set_config('learningbot.billing_entitlement_projection', 'false', true);
end;
$$;
revoke execute on function app_private.billing_apply_plan_entitlements(
  uuid, text, boolean
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Stripe event dedupe. `stripe_event_id primary key` is the whole
--    guarantee: a retried delivery hits a unique violation and the ingest
--    RPC turns that into a clean "already handled" reply.
-- ---------------------------------------------------------------------------

create table public.billing_stripe_events (
  stripe_event_id text primary key check (length(stripe_event_id) between 1 and 255),
  event_type text not null check (length(event_type) between 1 and 100),
  tenant_id uuid references public.tenants(tenant_id),
  status text not null default 'processed'
    check (status in ('processed', 'ignored', 'failed')),
  detail text,
  processed_at timestamptz not null default now()
);
create index billing_stripe_events_tenant_idx
  on public.billing_stripe_events (tenant_id, processed_at desc);

alter table public.billing_stripe_events enable row level security;
alter table public.billing_stripe_events force row level security;
revoke all on table public.billing_stripe_events from anon, authenticated;
drop policy if exists billing_stripe_events_deny_all
  on public.billing_stripe_events;
create policy billing_stripe_events_deny_all on public.billing_stripe_events
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger billing_stripe_events_reject_update
before update on public.billing_stripe_events
for each row execute function app_private.reject_mutation();
create trigger billing_stripe_events_reject_delete
before delete on public.billing_stripe_events
for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------
-- 6. Usage-report ledger. `unique (tenant_id, cost_entry_id)` is the
--    idempotency guarantee for non-negotiable #4: a `cost_ledger` row can be
--    committed here at most once, ever, enforced by the database.
-- ---------------------------------------------------------------------------

create table public.billing_usage_reports (
  usage_report_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  cost_entry_id uuid not null,
  stripe_subscription_item_id text not null,
  stripe_usage_record_id text,
  capability text not null,
  provider_key text not null,
  model_key text,
  cost_micro bigint not null check (cost_micro >= 0),
  billed_micro bigint not null check (billed_micro >= 0),
  billed_minor_units bigint not null check (billed_minor_units >= 0),
  margin_multiplier numeric(10, 4) not null,
  fixed_markup_micro bigint not null default 0,
  floor_micro bigint not null default 0,
  reported_at timestamptz not null default now(),
  foreign key (tenant_id, cost_entry_id)
    references public.cost_ledger(tenant_id, cost_entry_id),
  unique (tenant_id, cost_entry_id)
);
create index billing_usage_reports_tenant_idx
  on public.billing_usage_reports (tenant_id, reported_at desc);

alter table public.billing_usage_reports enable row level security;
alter table public.billing_usage_reports force row level security;
revoke all on table public.billing_usage_reports from anon, authenticated;
drop policy if exists billing_usage_reports_deny_all
  on public.billing_usage_reports;
create policy billing_usage_reports_deny_all on public.billing_usage_reports
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger billing_usage_reports_reject_update
before update on public.billing_usage_reports
for each row execute function app_private.reject_mutation();
create trigger billing_usage_reports_reject_delete
before delete on public.billing_usage_reports
for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------
-- 7. Trusted-server RPCs. No user session reaches these: authority is the
--    `billing.stripe.webhook` / `billing.operations` operation token, the
--    same mechanism gating the embedding worker and telemetry drain. They
--    are granted to `anon` and `service_role` only, below, and revoked from
--    `authenticated` -- a signed-in browser cannot reach them at all.
-- ---------------------------------------------------------------------------

-- Verifies the signature-checked, deduped Stripe event and applies it.
-- Idempotent on `stripe_event_id` (non-negotiable #3): a retried delivery
-- hits the primary key on `billing_stripe_events` and returns `replayed`
-- instead of re-applying anything.
create or replace function public.billing_webhook_ingest(
  operation_token text,
  stripe_event_id text,
  event_type text,
  target_tenant_id uuid default null,
  stripe_customer_id text default null,
  stripe_subscription_id text default null,
  stripe_price_id text default null,
  stripe_metered_item_id text default null,
  plan_key text default null,
  subscription_status text default null,
  current_period_end timestamptz default null,
  cancel_at_period_end boolean default null,
  -- 'payment_failed' | 'payment_succeeded' | null (no dunning signal).
  dunning_signal text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  resolved_tenant_id uuid;
  existing public.tenant_subscriptions%rowtype;
  updated public.tenant_subscriptions%rowtype;
  effective_plan text;
  effective_status text;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.stripe.webhook', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;
  if stripe_event_id is null or length(btrim(stripe_event_id)) = 0
    or event_type is null or length(btrim(event_type)) = 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  begin
    insert into public.billing_stripe_events (
      stripe_event_id, event_type, tenant_id
    ) values (
      btrim(stripe_event_id), btrim(event_type), target_tenant_id
    );
  exception
    when unique_violation then
      return jsonb_build_object(
        'ok', true, 'dataMode', 'durable', 'replayed', true
      );
  end;

  -- Resolve the tenant: `checkout.session.completed` carries an explicit
  -- `client_reference_id`; every later event for the same customer or
  -- subscription is resolved from what that first event already recorded.
  resolved_tenant_id := target_tenant_id;
  if resolved_tenant_id is null then
    select s.tenant_id into resolved_tenant_id
    from public.tenant_subscriptions s
    where (
        stripe_subscription_id is not null
        and s.stripe_subscription_id = stripe_subscription_id
      )
      or (
        stripe_customer_id is not null
        and s.stripe_customer_id = stripe_customer_id
      )
    limit 1;
  end if;

  if resolved_tenant_id is not null then
    update public.billing_stripe_events
    set tenant_id = resolved_tenant_id
    where stripe_event_id = btrim(stripe_event_id);
  end if;

  if resolved_tenant_id is null then
    update public.billing_stripe_events
    set status = 'ignored', detail = 'tenant_unresolved'
    where stripe_event_id = btrim(stripe_event_id);
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'ignored', true,
      'reason', 'tenant_unresolved'
    );
  end if;

  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = resolved_tenant_id and t.deleted_at is null
  ) then
    update public.billing_stripe_events
    set status = 'ignored', detail = 'tenant_not_found'
    where stripe_event_id = btrim(stripe_event_id);
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'ignored', true,
      'reason', 'tenant_not_found'
    );
  end if;

  existing := app_private.tenant_subscription_row(resolved_tenant_id);

  effective_plan := nullif(btrim(coalesce(plan_key, '')), '');
  if effective_plan is null
    or effective_plan not in ('unconfirmed', 'starter', 'growth', 'enterprise')
  then
    effective_plan := existing.plan;
  end if;
  effective_status := nullif(btrim(coalesce(subscription_status, '')), '');
  if effective_status is null
    or effective_status not in (
      'none', 'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )
  then
    effective_status := existing.subscription_status;
  end if;

  update public.tenant_subscriptions s
  set stripe_customer_id =
        coalesce(billing_webhook_ingest.stripe_customer_id, s.stripe_customer_id),
      stripe_subscription_id = coalesce(
        billing_webhook_ingest.stripe_subscription_id, s.stripe_subscription_id
      ),
      stripe_price_id =
        coalesce(billing_webhook_ingest.stripe_price_id, s.stripe_price_id),
      stripe_metered_item_id = coalesce(
        billing_webhook_ingest.stripe_metered_item_id, s.stripe_metered_item_id
      ),
      plan = effective_plan,
      plan_source = 'stripe',
      subscription_status = effective_status,
      current_period_end = coalesce(
        billing_webhook_ingest.current_period_end, s.current_period_end
      ),
      cancel_at_period_end = coalesce(
        billing_webhook_ingest.cancel_at_period_end, s.cancel_at_period_end
      ),
      dunning_stage = case
        when dunning_signal = 'payment_failed' then 'grace'
        when dunning_signal = 'payment_succeeded' then 'none'
        when effective_status = 'active' then 'none'
        else s.dunning_stage
      end,
      grace_period_ends_at = case
        when dunning_signal = 'payment_failed'
          then statement_timestamp() + make_interval(days => s.grace_period_days)
        when dunning_signal = 'payment_succeeded' then null
        when effective_status = 'active' then null
        else s.grace_period_ends_at
      end,
      last_stripe_event_id = btrim(stripe_event_id),
      last_stripe_event_at = statement_timestamp(),
      updated_by = null
  where s.tenant_id = resolved_tenant_id
  returning * into updated;

  -- Core sections are never in play here. Only the premium section follows
  -- the plan, and only a dunning stage that has actually reached `dark`
  -- suppresses it -- a grace period alone changes nothing but the tenant's
  -- own billing summary (non-negotiables #5 and #6).
  perform app_private.billing_apply_plan_entitlements(
    resolved_tenant_id,
    updated.plan,
    updated.dunning_stage = 'dark'
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'tenantId', resolved_tenant_id,
    'plan', updated.plan,
    'subscriptionStatus', updated.subscription_status,
    'dunningStage', updated.dunning_stage
  );
end;
$$;

-- Claims a bounded batch of `cost_ledger` rows that have never been reported
-- (anti-joined against `billing_usage_reports`) for tenants with a metered
-- subscription item on file, and returns the billable amount for each under
-- the tenant's current margin policy. Nothing is marked reported here --
-- only `billing_commit_usage_report`, after the caller's Stripe API call has
-- actually succeeded, writes the row that makes re-claiming it impossible.
create or replace function public.billing_claim_unreported_usage(
  operation_token text,
  batch_limit integer default 200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  bounded_limit integer := least(greatest(coalesce(batch_limit, 200), 1), 1000);
  items jsonb;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.operations', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;

  select coalesce(jsonb_agg(claimed.entry order by claimed.occurred_at), '[]'::jsonb)
  into items
  from (
    select
      jsonb_build_object(
        'tenantId', c.tenant_id,
        'costEntryId', c.cost_entry_id,
        'capability', c.capability,
        'providerKey', c.provider_key,
        'modelKey', c.model_key,
        'costMicro', c.estimated_cost_micro,
        'occurredAt', c.occurred_at,
        'stripeCustomerId', s.stripe_customer_id,
        'stripeSubscriptionItemId', s.stripe_metered_item_id,
        'marginMultiplier', m.margin_multiplier,
        'fixedMarkupMicro', m.fixed_markup_micro,
        'floorMicro', m.floor_micro,
        'billedMicro', app_private.billing_apply_margin(
          c.estimated_cost_micro,
          m.margin_multiplier,
          m.fixed_markup_micro,
          m.floor_micro
        ),
        'billedMinorUnits', app_private.billing_micro_to_minor(
          app_private.billing_apply_margin(
            c.estimated_cost_micro,
            m.margin_multiplier,
            m.fixed_markup_micro,
            m.floor_micro
          )
        )
      ) as entry,
      c.occurred_at
    from public.cost_ledger c
    join public.tenant_subscriptions s on s.tenant_id = c.tenant_id
    cross join lateral (
      select * from app_private.tenant_margin_policy(c.tenant_id)
    ) m
    where s.stripe_metered_item_id is not null
      and s.subscription_status in ('active', 'trialing', 'past_due')
      -- A short settle window: never report a row before it is safely final.
      and c.occurred_at <= statement_timestamp() - interval '5 minutes'
      and not exists (
        select 1
        from public.billing_usage_reports r
        where r.tenant_id = c.tenant_id
          and r.cost_entry_id = c.cost_entry_id
      )
    order by c.occurred_at
    limit bounded_limit
  ) claimed;

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'items', items);
end;
$$;

-- Commits one successfully reported row. `on conflict (tenant_id,
-- cost_entry_id) do nothing` plus checking whether a row actually inserted
-- is what makes a concurrent or retried commit safe: a duplicate call
-- reports `replayed: true` rather than a spurious failure, and never inserts
-- a second row for the same ledger entry (non-negotiable #4).
create or replace function public.billing_commit_usage_report(
  operation_token text,
  target_tenant_id uuid,
  cost_entry_id uuid,
  stripe_subscription_item_id text,
  stripe_usage_record_id text,
  cost_micro bigint,
  billed_micro bigint,
  billed_minor_units bigint,
  margin_multiplier numeric,
  fixed_markup_micro bigint,
  floor_micro bigint,
  capability text,
  provider_key text,
  model_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  inserted public.billing_usage_reports%rowtype;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.operations', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;
  if target_tenant_id is null
    or cost_entry_id is null
    or stripe_subscription_item_id is null
    or length(btrim(stripe_subscription_item_id)) = 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  insert into public.billing_usage_reports (
    tenant_id, cost_entry_id, stripe_subscription_item_id,
    stripe_usage_record_id, capability, provider_key, model_key,
    cost_micro, billed_micro, billed_minor_units,
    margin_multiplier, fixed_markup_micro, floor_micro
  ) values (
    target_tenant_id, cost_entry_id, btrim(stripe_subscription_item_id),
    nullif(btrim(coalesce(stripe_usage_record_id, '')), ''),
    coalesce(nullif(btrim(coalesce(capability, '')), ''), 'unknown'),
    coalesce(nullif(btrim(coalesce(provider_key, '')), ''), 'stripe'),
    nullif(btrim(coalesce(model_key, '')), ''),
    greatest(coalesce(cost_micro, 0), 0),
    greatest(coalesce(billed_micro, 0), 0),
    greatest(coalesce(billed_minor_units, 0), 0),
    coalesce(margin_multiplier, 1),
    greatest(coalesce(fixed_markup_micro, 0), 0),
    greatest(coalesce(floor_micro, 0), 0)
  )
  on conflict (tenant_id, cost_entry_id) do nothing
  returning * into inserted;

  if inserted.usage_report_id is null then
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'recorded', false, 'replayed', true
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'recorded', true,
    'replayed', false,
    'usageReportId', inserted.usage_report_id
  );
end;
$$;

-- Advances any subscription whose grace window has elapsed from `grace` to
-- `dark`, suppressing the premium section. This is the one place "sections
-- go dark" actually happens -- never inside the webhook ingest itself, so a
-- failed payment is never a one-step cutoff.
create or replace function public.billing_advance_dunning(
  operation_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  advanced_tenant record;
  advanced_count integer := 0;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.operations', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;

  for advanced_tenant in
    select s.tenant_id, s.plan
    from public.tenant_subscriptions s
    where s.dunning_stage = 'grace'
      and s.grace_period_ends_at is not null
      and s.grace_period_ends_at <= statement_timestamp()
    for update
  loop
    update public.tenant_subscriptions s
    set dunning_stage = 'dark'
    where s.tenant_id = advanced_tenant.tenant_id;

    perform app_private.billing_apply_plan_entitlements(
      advanced_tenant.tenant_id, advanced_tenant.plan, true
    );

    advanced_count := advanced_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'advanced', advanced_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Platform-administrator RPCs. Every one starts with the same
--    `platform_admin_is_authorized()` check the rest of the platform control
--    plane uses, and every write lands in the target tenant's own audit
--    ledger via `app_private.platform_admin_write_audit`.
-- ---------------------------------------------------------------------------

create or replace function public.platform_admin_set_tenant_margin_policy(
  target_tenant_id uuid,
  margin_multiplier numeric,
  fixed_markup_micro bigint,
  floor_micro bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.tenant_margin_policies%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or margin_multiplier is null
    or margin_multiplier < 0 or margin_multiplier > 100
    or fixed_markup_micro is null or fixed_markup_micro < 0
    or floor_micro is null or floor_micro < 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  perform app_private.tenant_margin_policy(target_tenant_id);
  update public.tenant_margin_policies p
  set margin_multiplier =
        platform_admin_set_tenant_margin_policy.margin_multiplier,
      fixed_markup_micro =
        platform_admin_set_tenant_margin_policy.fixed_markup_micro,
      floor_micro = platform_admin_set_tenant_margin_policy.floor_micro,
      updated_by = auth.uid()
  where p.tenant_id = target_tenant_id
  returning * into updated;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.margin_policy_updated',
    'tenant_margin_policy',
    target_tenant_id::text,
    'allow',
    'Platform administrator updated the billing margin policy.',
    'multiplier=' || updated.margin_multiplier::text ||
      ';fixed=' || updated.fixed_markup_micro::text ||
      ';floor=' || updated.floor_micro::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', updated.tenant_id,
    'marginMultiplier', updated.margin_multiplier,
    'fixedMarkupMicro', updated.fixed_markup_micro,
    'floorMicro', updated.floor_micro,
    'currency', updated.currency,
    'recordVersion', updated.record_version
  );
end;
$$;

-- The manual comp/debug lever PLAN.md S10.1 requires alongside the Stripe
-- projection. Always restores full plan entitlement (never leaves a tenant
-- mid-dunning): comping an account is never the moment sections go dark.
create or replace function public.platform_admin_set_tenant_subscription(
  target_tenant_id uuid,
  plan text,
  subscription_status text,
  note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.tenant_subscriptions%rowtype;
  normalized_note text := nullif(btrim(coalesce(note, '')), '');
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or plan is null
    or plan not in ('unconfirmed', 'starter', 'growth', 'enterprise')
    or subscription_status is null
    or subscription_status not in (
      'none', 'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  perform app_private.tenant_subscription_row(target_tenant_id);
  update public.tenant_subscriptions s
  set plan = platform_admin_set_tenant_subscription.plan,
      plan_source = 'manual',
      subscription_status =
        platform_admin_set_tenant_subscription.subscription_status,
      dunning_stage = 'none',
      grace_period_ends_at = null,
      updated_by = auth.uid()
  where s.tenant_id = target_tenant_id
  returning * into updated;

  perform app_private.billing_apply_plan_entitlements(
    target_tenant_id, updated.plan, false
  );

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.subscription_set',
    'tenant_subscription',
    target_tenant_id::text,
    'allow',
    coalesce(
      normalized_note,
      'Platform administrator manually set the subscription state.'
    ),
    'plan=' || updated.plan || ';status=' || updated.subscription_status
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', updated.tenant_id,
    'plan', updated.plan,
    'planSource', updated.plan_source,
    'subscriptionStatus', updated.subscription_status,
    'dunningStage', updated.dunning_stage
  );
end;
$$;

-- Returns a single section to plan control. The section's `enabled` value is
-- recomputed from the tenant's current plan (and current dunning stage) at
-- the moment of the call, and the write is stamped 'subscription', not left
-- at whatever a stale plan snapshot would imply.
create or replace function public.platform_admin_clear_tenant_section_override(
  target_tenant_id uuid,
  target_section_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  subscription public.tenant_subscriptions%rowtype;
  entitled text[];
  desired boolean;
  section_record public.tenant_sections%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or target_section_key is null
    or target_section_key = 'platform'
    or not exists (
      select 1 from app_private.tenant_section_definitions() d
      where d.section_key = target_section_key
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  subscription := app_private.tenant_subscription_row(target_tenant_id);

  entitled := app_private.billing_core_sections();
  if subscription.dunning_stage <> 'dark' then
    entitled := entitled
      || app_private.billing_premium_sections_for_plan(subscription.plan);
  end if;
  desired := target_section_key = any (entitled);

  perform set_config('learningbot.billing_entitlement_projection', 'true', true);
  update public.tenant_sections
  set enabled = desired
  where tenant_id = target_tenant_id
    and section_key = target_section_key
  returning * into section_record;
  perform set_config('learningbot.billing_entitlement_projection', 'false', true);

  if not found then
    return jsonb_build_object('ok', false, 'code', 'section_not_found');
  end if;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.section_override_cleared',
    'tenant_section',
    target_section_key,
    'allow',
    'Platform administrator returned this section to plan control.',
    section_record.tenant_section_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', target_tenant_id,
    'section', jsonb_build_object(
      'sectionKey', section_record.section_key,
      'enabled', section_record.enabled,
      'source', section_record.source,
      'updatedAt', section_record.updated_at
    )
  );
end;
$$;

-- Per-account true spend, margin, billed amount, plan, subscription state,
-- budget headroom and model tier -- PLAN.md S10.4, in one bounded read.
-- Deliberately STABLE and side-effect free: it reads `tenant_subscriptions`
-- and `tenant_margin_policies` with LEFT JOIN + COALESCE defaults rather
-- than the get-or-create helpers, so an overview read can never itself write.
create or replace function public.platform_admin_billing_overview(
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
          'plan', row_data.plan,
          'planSource', row_data.plan_source,
          'subscriptionStatus', row_data.subscription_status,
          'dunningStage', row_data.dunning_stage,
          'gracePeriodEndsAt', row_data.grace_period_ends_at,
          'modelTier', row_data.model_tier,
          'currency', row_data.currency,
          'windowTrueCostMicro', row_data.window_true_cost,
          'windowBilledMicro', row_data.window_billed,
          'windowUnreportedMicro', row_data.window_unreported,
          'marginMultiplier', row_data.margin_multiplier,
          'fixedMarkupMicro', row_data.fixed_markup_micro,
          'floorMicro', row_data.floor_micro,
          'dailyBudgetMicro', row_data.daily_budget_micro,
          'monthlyBudgetMicro', row_data.monthly_budget_micro,
          'monthSpendMicro', row_data.month_spend,
          'monthBudgetHeadroomMicro', greatest(
            coalesce(row_data.monthly_budget_micro, 0) - row_data.month_spend, 0
          ),
          'hasStripeCustomer', row_data.stripe_customer_id is not null,
          'hasStripeSubscription', row_data.stripe_subscription_id is not null
        )
        order by row_data.window_true_cost desc, row_data.display_name
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'tenants', count(*),
      'windowTrueCostMicro', coalesce(sum(row_data.window_true_cost), 0),
      'windowBilledMicro', coalesce(sum(row_data.window_billed), 0),
      'windowUnreportedMicro', coalesce(sum(row_data.window_unreported), 0)
    )
  into tenants_summary, totals
  from (
    select
      t.tenant_id,
      t.slug,
      t.display_name,
      t.status,
      coalesce(sub.plan, 'unconfirmed') as plan,
      coalesce(sub.plan_source, 'manual') as plan_source,
      coalesce(sub.subscription_status, 'none') as subscription_status,
      coalesce(sub.dunning_stage, 'none') as dunning_stage,
      sub.grace_period_ends_at,
      sub.stripe_customer_id,
      sub.stripe_subscription_id,
      coalesce(mp.margin_multiplier, 1.5) as margin_multiplier,
      coalesce(mp.fixed_markup_micro, 0) as fixed_markup_micro,
      coalesce(mp.floor_micro, 0) as floor_micro,
      coalesce(mp.currency, 'USD') as currency,
      cp.daily_budget_micro,
      cp.monthly_budget_micro,
      coalesce(spend.month_spend, 0)::bigint as month_spend,
      coalesce(spend.window_true_cost, 0)::bigint as window_true_cost,
      coalesce(billed.window_billed, 0)::bigint as window_billed,
      coalesce(unreported.window_unreported, 0)::bigint as window_unreported,
      model_tier.model_tier
    from public.tenants t
    left join public.tenant_cost_policies cp on cp.tenant_id = t.tenant_id
    left join public.tenant_subscriptions sub on sub.tenant_id = t.tenant_id
    left join public.tenant_margin_policies mp on mp.tenant_id = t.tenant_id
    left join lateral (
      select
        sum(c.estimated_cost_micro) filter (
          where c.occurred_at >= date_trunc('month', now_ts)
        ) as month_spend,
        sum(c.estimated_cost_micro) as window_true_cost
      from public.cost_ledger c
      where c.tenant_id = t.tenant_id
        and c.occurred_at >= window_start
    ) spend on true
    left join lateral (
      select sum(r.billed_micro) as window_billed
      from public.billing_usage_reports r
      where r.tenant_id = t.tenant_id
        and r.reported_at >= window_start
    ) billed on true
    left join lateral (
      select sum(
        app_private.billing_apply_margin(
          c.estimated_cost_micro,
          coalesce(mp.margin_multiplier, 1.5),
          coalesce(mp.fixed_markup_micro, 0),
          coalesce(mp.floor_micro, 0)
        )
      ) as window_unreported
      from public.cost_ledger c
      where c.tenant_id = t.tenant_id
        and c.occurred_at >= window_start
        and not exists (
          select 1 from public.billing_usage_reports r
          where r.tenant_id = c.tenant_id and r.cost_entry_id = c.cost_entry_id
        )
    ) unreported on true
    left join lateral (
      select b.agent_model as model_tier
      from public.tenant_branding b
      where b.tenant_id = t.tenant_id
        and b.status = 'published'
        and b.deleted_at is null
      order by b.version_number desc
      limit 1
    ) model_tier on true
    where t.deleted_at is null
  ) row_data;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'windowDays', bounded_days,
    'microUnitsPerMajorUnit', 1000000,
    'generatedAt', now_ts,
    'totals', totals,
    'tenants', tenants_summary
  );
end;
$$;

-- Deep, single-tenant billing detail: true cost, margin, billed amount,
-- subscription identifiers, recent usage reports and section source
-- (subscription vs. manual override). Platform-admin only, same as above.
create or replace function public.platform_admin_tenant_billing_detail(
  target_tenant_id uuid,
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
  tenant_record record;
  sub record;
  mp record;
  cp record;
  spend record;
  sections jsonb;
  recent_reports jsonb;
  model_tier text;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  window_start := now_ts - make_interval(days => bounded_days);

  select t.* into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id and t.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  select * into sub
  from public.tenant_subscriptions s
  where s.tenant_id = target_tenant_id;
  select * into mp
  from public.tenant_margin_policies p
  where p.tenant_id = target_tenant_id;
  select * into cp
  from public.tenant_cost_policies c
  where c.tenant_id = target_tenant_id;

  select
    sum(c.estimated_cost_micro) filter (
      where c.occurred_at >= date_trunc('day', now_ts)
    ) as day_spend,
    sum(c.estimated_cost_micro) filter (
      where c.occurred_at >= date_trunc('month', now_ts)
    ) as month_spend,
    sum(c.estimated_cost_micro) as window_true_cost,
    count(*) as window_calls
  into spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= window_start;

  select b.agent_model into model_tier
  from public.tenant_branding b
  where b.tenant_id = target_tenant_id
    and b.status = 'published'
    and b.deleted_at is null
  order by b.version_number desc
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sectionKey', d.section_key,
        'enabled', coalesce(ts.enabled, d.default_enabled),
        'source', coalesce(ts.source, 'unset'),
        'updatedAt', ts.updated_at
      )
      order by d.display_position
    ),
    '[]'::jsonb
  )
  into sections
  from app_private.tenant_section_definitions() d
  left join public.tenant_sections ts
    on ts.tenant_id = target_tenant_id
   and ts.section_key = d.section_key
   and ts.deleted_at is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'costEntryId', r.cost_entry_id,
        'capability', r.capability,
        'modelKey', r.model_key,
        'costMicro', r.cost_micro,
        'billedMicro', r.billed_micro,
        'reportedAt', r.reported_at
      )
      order by r.reported_at desc
    ),
    '[]'::jsonb
  )
  into recent_reports
  from (
    select *
    from public.billing_usage_reports br
    where br.tenant_id = target_tenant_id
    order by br.reported_at desc
    limit 20
  ) r;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', now_ts,
    'windowDays', bounded_days,
    'tenant', jsonb_build_object(
      'tenantId', tenant_record.tenant_id,
      'slug', tenant_record.slug,
      'displayName', tenant_record.display_name,
      'status', tenant_record.status
    ),
    'subscription', jsonb_build_object(
      'plan', coalesce(sub.plan, 'unconfirmed'),
      'planSource', coalesce(sub.plan_source, 'manual'),
      'subscriptionStatus', coalesce(sub.subscription_status, 'none'),
      'dunningStage', coalesce(sub.dunning_stage, 'none'),
      'gracePeriodEndsAt', sub.grace_period_ends_at,
      'currentPeriodEnd', sub.current_period_end,
      'cancelAtPeriodEnd', coalesce(sub.cancel_at_period_end, false),
      'stripeCustomerId', sub.stripe_customer_id,
      'stripeSubscriptionId', sub.stripe_subscription_id,
      'stripePriceId', sub.stripe_price_id,
      'hasMeteredItem', sub.stripe_metered_item_id is not null,
      'lastStripeEventAt', sub.last_stripe_event_at
    ),
    'margin', jsonb_build_object(
      'marginMultiplier', coalesce(mp.margin_multiplier, 1.5),
      'fixedMarkupMicro', coalesce(mp.fixed_markup_micro, 0),
      'floorMicro', coalesce(mp.floor_micro, 0),
      'currency', coalesce(mp.currency, 'USD')
    ),
    'budget', jsonb_build_object(
      'dailyBudgetMicro', cp.daily_budget_micro,
      'monthlyBudgetMicro', cp.monthly_budget_micro,
      'daySpendMicro', coalesce(spend.day_spend, 0),
      'monthSpendMicro', coalesce(spend.month_spend, 0)
    ),
    'usage', jsonb_build_object(
      'windowTrueCostMicro', coalesce(spend.window_true_cost, 0),
      'windowCalls', coalesce(spend.window_calls, 0),
      'recentReports', recent_reports
    ),
    'modelTier', model_tier,
    'sections', sections
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The one surface a creator can reach. Plan, status, dunning stage and
--    their own billed total -- never cost, never margin (non-negotiable #1).
-- ---------------------------------------------------------------------------

create or replace function public.tenant_get_billing_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  sub record;
  billed_window bigint;
  window_start timestamptz := date_trunc('month', statement_timestamp());
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into sub
  from public.tenant_subscriptions s
  where s.tenant_id = caller.tenant_id;

  select coalesce(sum(r.billed_micro), 0) into billed_window
  from public.billing_usage_reports r
  where r.tenant_id = caller.tenant_id
    and r.reported_at >= window_start;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'plan', coalesce(sub.plan, 'unconfirmed'),
    'subscriptionStatus', coalesce(sub.subscription_status, 'none'),
    'dunningStage', coalesce(sub.dunning_stage, 'none'),
    'gracePeriodEndsAt', sub.grace_period_ends_at,
    'currentPeriodEnd', sub.current_period_end,
    'cancelAtPeriodEnd', coalesce(sub.cancel_at_period_end, false),
    'monthToDateBilledMicro', billed_window,
    'message', case coalesce(sub.dunning_stage, 'none')
      when 'grace' then
        'A recent payment failed. Update billing before ' ||
          to_char(sub.grace_period_ends_at, 'YYYY-MM-DD') ||
          ' to keep every section active.'
      when 'dark' then
        'Payment is still failing. Premium sections are paused until billing is resolved.'
      else null
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Least-privilege grants.
-- ---------------------------------------------------------------------------

revoke all on function public.billing_webhook_ingest(
  text, text, text, uuid, text, text, text, text, text, text, timestamptz,
  boolean, text
) from public, anon, authenticated, service_role;
revoke all on function public.billing_claim_unreported_usage(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.billing_commit_usage_report(
  text, uuid, uuid, text, text, bigint, bigint, bigint, numeric, bigint,
  bigint, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.billing_advance_dunning(text)
  from public, anon, authenticated, service_role;

-- Trusted-server worker paths: the operation token is the authority, not a
-- Supabase session, so these are granted to `anon` (the trusted server calls
-- with the publishable key and no signed-in user) and `service_role`, and
-- never to `authenticated` -- a signed-in browser cannot reach them.
grant execute on function public.billing_webhook_ingest(
  text, text, text, uuid, text, text, text, text, text, text, timestamptz,
  boolean, text
) to anon, service_role;
grant execute on function public.billing_claim_unreported_usage(text, integer)
  to anon, service_role;
grant execute on function public.billing_commit_usage_report(
  text, uuid, uuid, text, text, bigint, bigint, bigint, numeric, bigint,
  bigint, text, text, text
) to anon, service_role;
grant execute on function public.billing_advance_dunning(text)
  to anon, service_role;

revoke all on function public.platform_admin_set_tenant_margin_policy(
  uuid, numeric, bigint, bigint
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_set_tenant_subscription(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_clear_tenant_section_override(
  uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_billing_overview(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_tenant_billing_detail(
  uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.tenant_get_billing_summary()
  from public, anon, authenticated, service_role;

-- Authorization is checked inside each function, and only a signed-in user
-- can ever be a platform administrator or a tenant admin.
grant execute on function public.platform_admin_set_tenant_margin_policy(
  uuid, numeric, bigint, bigint
) to authenticated;
grant execute on function public.platform_admin_set_tenant_subscription(
  uuid, text, text, text
) to authenticated;
grant execute on function public.platform_admin_clear_tenant_section_override(
  uuid, text
) to authenticated;
grant execute on function public.platform_admin_billing_overview(integer)
  to authenticated;
grant execute on function public.platform_admin_tenant_billing_detail(
  uuid, integer
) to authenticated;
grant execute on function public.tenant_get_billing_summary()
  to authenticated;

commit;
