-- Capability-level control over a client workspace, plus the one section key
-- the catalogue was missing.
--
-- Two independent additions, deliberately in one migration because the second
-- is a two-line consequence of the first being reviewed at the same time:
--
--   1. `public.tenant_capability_grants` and
--      `public.platform_admin_set_tenant_capability`, mirroring the existing
--      `public.tenant_sections` / `public.platform_admin_set_tenant_section`
--      pattern from 20260725123000. Until now a tenant admin's ability to
--      rename their bot, rewrite the welcome copy, change the voice, choose a
--      model or invite people came entirely from their role membership, with
--      no record a platform administrator could use to restrict ONE client
--      without restricting the role everywhere. That record is what this adds.
--
--   2. `widget` joins the section catalogue. `widget` has been a console
--      PanelKey since the widget panel shipped, but it was never in
--      `app_private.tenant_section_definitions()` and the table's own
--      `check (section_key in (...))` listed six keys, so the widget section
--      could not be flagged per tenant at all.
--
-- Data boundary: unchanged from 20260725123000. Nothing here exposes prompt
-- text, learner conversation content, source or document contents,
-- attachments, or credentials. Capability grants are configuration flags.
--
-- This file is deliberately pure ASCII: the Supabase SQL editor mangles
-- non-ASCII on paste, and a corrupted character inside a $$-quoted body is a
-- silent behaviour change rather than a syntax error.

begin;

-- ---------------------------------------------------------------------------
-- 1. The section catalogue gains `widget`
-- ---------------------------------------------------------------------------

-- Position 6, ahead of settings, so the ordered read matches how the console
-- presents the dock. `default_enabled` is true because the widget section is
-- reachable today for every tenant administrator; a default of false would
-- switch a live surface off for every client the moment this is applied.
create or replace function app_private.tenant_section_definitions()
returns table (
  section_key text,
  default_enabled boolean,
  display_position integer
)
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select *
  from (values
    ('agent'::text, true, 1),
    ('insights'::text, true, 2),
    ('course'::text, true, 3),
    ('people'::text, true, 4),
    ('platform'::text, false, 5),
    ('widget'::text, true, 6),
    ('settings'::text, true, 7)
  ) as definitions(section_key, default_enabled, display_position);
$$;
revoke execute on function app_private.tenant_section_definitions()
  from public, anon, authenticated, service_role;

-- The table's own check constraint was written inline and unnamed
-- (20260725123000 line 49), so its generated name is an implementation
-- detail. Drop by definition rather than by guessed name: leaving the old
-- six-key constraint in place would make every widget write fail with a
-- check violation while the definitions function claimed the key was valid.
do $$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.tenant_sections'::pg_catalog.regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%section_key%'
  loop
    execute pg_catalog.format(
      'alter table public.tenant_sections drop constraint %I',
      existing_constraint
    );
  end loop;
end;
$$;

alter table public.tenant_sections
  add constraint tenant_sections_section_key_check
  check (section_key in (
    'agent', 'insights', 'course', 'people', 'platform', 'widget', 'settings'
  ));

-- `app_private.billing_apply_plan_entitlements` (20260726100000) iterates
-- EVERY definition except 'platform' and switches off any key that is not in
-- the entitled array. Adding 'widget' to the catalogue without adding it here
-- would make the next plan projection dark the widget section for every
-- tenant on the planet. It is core rather than premium because that is the
-- behaviour today: the widget section has never been billing-governed, and a
-- migration is the wrong place to start charging for it.
create or replace function app_private.billing_core_sections()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array['agent', 'course', 'people', 'settings', 'widget']::text[];
$$;
revoke execute on function app_private.billing_core_sections()
  from public, anon, authenticated, service_role;

-- Existing tenants get an explicit widget row so the flag is visible in the
-- panel rather than implied by a default. `source` takes its column default
-- ('unset'), which is what the billing trigger expects from a seed INSERT.
insert into public.tenant_sections (
  tenant_id, section_key, enabled, idempotency_key
)
select
  t.tenant_id,
  'widget',
  true,
  'tenant-section-seed:' || t.tenant_id::text || ':widget'
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id, section_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Canonical capability catalogue
-- ---------------------------------------------------------------------------

-- `model_choice` is the one capability that defaults to OFF. It is the only
-- row here that changes what the platform pays per answer, so a client gets
-- it by an explicit grant rather than by omission. The other four are on by
-- default because a tenant administrator can already do all of them today,
-- and a migration must not quietly take that away.
create or replace function app_private.tenant_capability_definitions()
returns table (
  capability_key text,
  default_enabled boolean,
  display_position integer
)
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select *
  from (values
    ('bot_identity'::text, true, 1),
    ('welcome_message'::text, true, 2),
    ('voice_answer_length'::text, true, 3),
    ('model_choice'::text, false, 4),
    ('invite_members'::text, true, 5)
  ) as definitions(capability_key, default_enabled, display_position);
$$;
revoke execute on function app_private.tenant_capability_definitions()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Per-tenant capability grants
-- ---------------------------------------------------------------------------

create table public.tenant_capability_grants (
  tenant_capability_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  capability_key text not null check (capability_key in (
    'bot_identity', 'welcome_message', 'voice_answer_length',
    'model_choice', 'invite_members'
  )),
  enabled boolean not null default true,
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null
    check (length(idempotency_key) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, tenant_capability_id),
  unique (tenant_id, capability_key),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);
create index tenant_capability_grants_tenant_enabled_idx
  on public.tenant_capability_grants (tenant_id, capability_key, enabled);
create index tenant_capability_grants_updated_by_idx
  on public.tenant_capability_grants (updated_by)
  where updated_by is not null;

alter table public.tenant_capability_grants enable row level security;
alter table public.tenant_capability_grants force row level security;
revoke all on table public.tenant_capability_grants from anon, authenticated;

-- Same posture as public.tenant_sections: a tenant may read what it has been
-- granted, and only the authorized platform administrator may write, through
-- the definer RPC below. There is deliberately no insert, update or delete
-- policy for authenticated callers.
create policy tenant_capability_grants_select on public.tenant_capability_grants
  for select to authenticated
  using (app_private.can_read_tenant(tenant_id));
create policy tenant_capability_grants_deny_anon
  on public.tenant_capability_grants
  for all to anon
  using (false)
  with check (false);

grant select on public.tenant_capability_grants to authenticated;

create trigger tenant_capability_grants_set_version
before update on public.tenant_capability_grants
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_capability_grants (
  tenant_id, capability_key, enabled, idempotency_key
)
select
  t.tenant_id,
  d.capability_key,
  d.default_enabled,
  'tenant-capability-seed:' || t.tenant_id::text || ':' || d.capability_key
from public.tenants t
cross join app_private.tenant_capability_definitions() d
where t.deleted_at is null
on conflict (tenant_id, capability_key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Tenant-side capability read
-- ---------------------------------------------------------------------------

-- The client's own console reads this to know what it may offer. A missing
-- row means the catalogue default, never "denied": a database on which the
-- seed above has not run must not silently strip a tenant administrator of
-- controls they had yesterday.
create or replace function public.tenant_get_capabilities()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  capabilities jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'capabilityKey', d.capability_key,
        'enabled', coalesce(g.enabled, d.default_enabled),
        'updatedAt', g.updated_at
      )
      order by d.display_position
    ),
    '[]'::jsonb
  )
  into capabilities
  from app_private.tenant_capability_definitions() d
  left join public.tenant_capability_grants g
    on g.tenant_id = caller.tenant_id
   and g.capability_key = d.capability_key
   and g.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'generatedAt', clock_timestamp(),
    'capabilities', capabilities
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Platform-administrator capability read and write
-- ---------------------------------------------------------------------------

-- A separate read rather than another field on
-- public.platform_admin_tenant_detail. That function is applied and working;
-- replacing a 200-line body to append one aggregate is a large diff with a
-- real chance of reverting something, and it would couple the whole client
-- detail panel to whether THIS migration has been hand-applied yet. As its
-- own RPC, a database without it simply leaves the capability card unread
-- while every other part of the client detail keeps working.
create or replace function public.platform_admin_tenant_capabilities(
  target_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  tenant_record record;
  capabilities jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select t.* into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'capabilityKey', d.capability_key,
        'enabled', coalesce(g.enabled, d.default_enabled),
        'updatedAt', g.updated_at
      )
      order by d.display_position
    ),
    '[]'::jsonb
  )
  into capabilities
  from app_private.tenant_capability_definitions() d
  left join public.tenant_capability_grants g
    on g.tenant_id = target_tenant_id
   and g.capability_key = d.capability_key
   and g.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', clock_timestamp(),
    'tenantId', target_tenant_id,
    'capabilities', capabilities
  );
end;
$$;

create or replace function public.platform_admin_set_tenant_capability(
  target_tenant_id uuid,
  target_capability_key text,
  target_enabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  tenant_record record;
  capability_record record;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or target_enabled is null
    or target_capability_key is null
    or not exists (
      select 1
      from app_private.tenant_capability_definitions() d
      where d.capability_key = target_capability_key
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select t.* into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  insert into public.tenant_capability_grants (
    tenant_id, capability_key, enabled, updated_by, idempotency_key
  ) values (
    target_tenant_id,
    target_capability_key,
    target_enabled,
    auth.uid(),
    'tenant-capability:' || target_tenant_id::text || ':'
      || target_capability_key
  )
  on conflict (tenant_id, capability_key) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by
  returning * into capability_record;

  -- The client can always see who changed what inside their own account.
  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.capability.set',
    'tenant_capability',
    target_capability_key,
    'allow',
    case
      when target_enabled then 'capability_granted'
      else 'capability_withheld'
    end,
    capability_record.tenant_capability_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', target_tenant_id,
    'capability', jsonb_build_object(
      'capabilityKey', capability_record.capability_key,
      'enabled', capability_record.enabled,
      'updatedAt', capability_record.updated_at
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Execution boundary
-- ---------------------------------------------------------------------------

revoke execute on function public.tenant_get_capabilities()
  from public, anon, service_role;
revoke execute on function public.platform_admin_tenant_capabilities(uuid)
  from public, anon, service_role;
revoke execute on function public.platform_admin_set_tenant_capability(
  uuid, text, boolean
) from public, anon, service_role;

grant execute on function public.tenant_get_capabilities()
  to authenticated;
grant execute on function public.platform_admin_tenant_capabilities(uuid)
  to authenticated;
grant execute on function public.platform_admin_set_tenant_capability(
  uuid, text, boolean
) to authenticated;

commit;
