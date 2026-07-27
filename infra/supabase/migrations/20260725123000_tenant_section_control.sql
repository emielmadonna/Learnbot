-- Platform-owner control over client accounts: per-tenant section flags, an
-- explicit and audited client-workspace entry, account suspension and a
-- bounded per-client detail read.
--
-- Data boundary: nothing added here exposes prompt text, learner conversation
-- content, source or document contents, attachments, or credentials. Platform
-- reads are counts, timestamps and configuration flags only. Entering a client
-- workspace is a real, named, revocable tenant membership -- it never bypasses
-- the tenant's own row level security and never widens a read beyond the one
-- selected tenant.

begin;

-- ---------------------------------------------------------------------------
-- Canonical section catalogue
-- ---------------------------------------------------------------------------

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
    ('settings'::text, true, 6)
  ) as definitions(section_key, default_enabled, display_position);
$$;
revoke execute on function app_private.tenant_section_definitions()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per-tenant section flags
-- ---------------------------------------------------------------------------

create table public.tenant_sections (
  tenant_section_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  section_key text not null check (section_key in (
    'agent', 'insights', 'course', 'people', 'platform', 'settings'
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
  unique (tenant_id, tenant_section_id),
  unique (tenant_id, section_key),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);
create index tenant_sections_tenant_enabled_idx
  on public.tenant_sections (tenant_id, section_key, enabled);
create index tenant_sections_updated_by_idx
  on public.tenant_sections (updated_by)
  where updated_by is not null;

alter table public.tenant_sections enable row level security;
alter table public.tenant_sections force row level security;
revoke all on table public.tenant_sections from anon, authenticated;

-- A tenant may read its own section configuration. Writes are reserved for the
-- authorized platform administrator through the definer RPC below, so there is
-- deliberately no insert, update or delete policy for authenticated callers.
create policy tenant_sections_select on public.tenant_sections
  for select to authenticated
  using (app_private.can_read_tenant(tenant_id));
create policy tenant_sections_deny_anon
  on public.tenant_sections
  for all to anon
  using (false)
  with check (false);

grant select on public.tenant_sections to authenticated;

create trigger tenant_sections_set_version
before update on public.tenant_sections
for each row execute function app_private.set_updated_at_and_version();

-- Sensible defaults for every existing tenant. Client workspaces get the four
-- product sections and their settings; the platform-owner surface stays off.
insert into public.tenant_sections (
  tenant_id, section_key, enabled, idempotency_key
)
select
  t.tenant_id,
  d.section_key,
  d.default_enabled,
  'tenant-section-seed:' || t.tenant_id::text || ':' || d.section_key
from public.tenants t
cross join app_private.tenant_section_definitions() d
where t.deleted_at is null
on conflict (tenant_id, section_key) do nothing;

-- ---------------------------------------------------------------------------
-- Audited platform-administrator actions
-- ---------------------------------------------------------------------------

-- Every privileged platform action lands in the target tenant's own immutable
-- audit ledger, so the client can always see who acted inside their account.
create or replace function app_private.platform_admin_write_audit(
  target_tenant_id uuid,
  audit_action text,
  audit_resource_type text,
  audit_resource_id text,
  audit_decision text,
  audit_reason text,
  audit_change_ref text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  written_audit_id uuid;
begin
  if target_tenant_id is null
    or not exists (
      select 1 from public.tenants t where t.tenant_id = target_tenant_id
    )
  then
    return null;
  end if;

  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, change_ref, request_id,
    trace_id, idempotency_key, occurred_at, retain_until
  ) values (
    target_tenant_id,
    auth.uid(),
    'system',
    'platform_admin',
    audit_action,
    audit_resource_type,
    audit_resource_id,
    audit_decision,
    audit_reason,
    audit_change_ref,
    'platform-admin:' || pg_catalog.gen_random_uuid()::text,
    'platform-admin-trace:' || pg_catalog.gen_random_uuid()::text,
    'platform-admin-audit:' || pg_catalog.gen_random_uuid()::text,
    now(),
    now() + interval '7 years'
  )
  returning audit_id into written_audit_id;

  return written_audit_id;
end;
$$;
revoke execute on function app_private.platform_admin_write_audit(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tenant-side section read
-- ---------------------------------------------------------------------------

create or replace function public.tenant_get_sections()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  sections jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sectionKey', d.section_key,
        'enabled', coalesce(s.enabled, d.default_enabled),
        'updatedAt', s.updated_at
      )
      order by d.display_position
    ),
    '[]'::jsonb
  )
  into sections
  from app_private.tenant_section_definitions() d
  left join public.tenant_sections s
    on s.tenant_id = caller.tenant_id
   and s.section_key = d.section_key
   and s.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'generatedAt', clock_timestamp(),
    'sections', sections
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform-administrator section control
-- ---------------------------------------------------------------------------

create or replace function public.platform_admin_set_tenant_section(
  target_tenant_id uuid,
  target_section_key text,
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
  section_record record;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or target_enabled is null
    or target_section_key is null
    or not exists (
      select 1
      from app_private.tenant_section_definitions() d
      where d.section_key = target_section_key
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

  insert into public.tenant_sections (
    tenant_id, section_key, enabled, updated_by, idempotency_key
  ) values (
    target_tenant_id,
    target_section_key,
    target_enabled,
    auth.uid(),
    'tenant-section:' || target_tenant_id::text || ':' || target_section_key
  )
  on conflict (tenant_id, section_key) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by
  returning * into section_record;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.section.set',
    'tenant_section',
    target_section_key,
    'allow',
    case when target_enabled then 'section_enabled' else 'section_disabled' end,
    section_record.tenant_section_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', target_tenant_id,
    'section', jsonb_build_object(
      'sectionKey', section_record.section_key,
      'enabled', section_record.enabled,
      'updatedAt', section_record.updated_at
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Explicit, audited client-workspace entry
-- ---------------------------------------------------------------------------

-- Entry is recorded durably so it can be reviewed and reversed. The session row
-- carries the previous selection, which lets exit restore the administrator's
-- own workspace instead of leaving a dangling context.
create table app_private.platform_admin_tenant_sessions (
  session_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  principal_id text not null
    references public.identity_principals(principal_id),
  tenant_id uuid not null references public.tenants(tenant_id),
  membership_id text not null,
  previous_tenant_id uuid references public.tenants(tenant_id),
  previous_membership_id text,
  status text not null default 'active'
    check (status in ('active', 'exited')),
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, membership_id, principal_id)
    references public.identity_memberships(
      tenant_id, membership_id, principal_id
    ),
  check (
    (status = 'active' and exited_at is null)
    or (status = 'exited' and exited_at is not null)
  )
);
create unique index platform_admin_tenant_sessions_active_uq
  on app_private.platform_admin_tenant_sessions (auth_user_id)
  where status = 'active';
create index platform_admin_tenant_sessions_tenant_idx
  on app_private.platform_admin_tenant_sessions (tenant_id, entered_at desc);

alter table app_private.platform_admin_tenant_sessions
  enable row level security;
alter table app_private.platform_admin_tenant_sessions
  force row level security;
revoke all on table app_private.platform_admin_tenant_sessions
  from public, anon, authenticated;
grant select, insert, update
  on table app_private.platform_admin_tenant_sessions
  to service_role;

create policy platform_admin_tenant_sessions_no_direct_access
  on app_private.platform_admin_tenant_sessions
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.platform_admin_enter_tenant(
  target_tenant_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  linked_principal_id text;
  tenant_record record;
  existing_membership record;
  active_session record;
  created_session record;
  managed_membership_id text;
  restored_tenant_id uuid;
  restored_membership_id text;
  new_selection_version bigint;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller_id::text, 8021)
  );

  select l.principal_id
  into linked_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_id;
  if linked_principal_id is null then
    return jsonb_build_object('ok', false, 'code', 'principal_not_linked');
  end if;

  -- A suspended or deleted account cannot be entered. The platform owner must
  -- reactivate it first, which is itself audited.
  select t.* into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null
    and t.status in ('provisioning', 'active');
  if not found then
    perform app_private.platform_admin_write_audit(
      target_tenant_id,
      'platform.tenant.enter',
      'tenant',
      target_tenant_id::text,
      'deny',
      'tenant_unavailable',
      null
    );
    return jsonb_build_object('ok', false, 'code', 'tenant_unavailable');
  end if;

  managed_membership_id := 'platform-admin:' || caller_id::text;

  select m.* into existing_membership
  from public.identity_memberships m
  where m.tenant_id = target_tenant_id
    and m.principal_id = linked_principal_id;

  if not found then
    insert into public.identity_memberships (
      membership_id, tenant_id, principal_id, role, status,
      provisioned_by, idempotency_key
    ) values (
      managed_membership_id,
      target_tenant_id,
      linked_principal_id,
      'tenant_admin',
      'active',
      'host',
      'platform-admin-entry:' || caller_id::text
    );
  elsif existing_membership.membership_id = managed_membership_id then
    update public.identity_memberships m
    set status = 'active',
        deleted_at = null,
        updated_at = now(),
        record_version = m.record_version + 1
    where m.tenant_id = target_tenant_id
      and m.membership_id = managed_membership_id;
  elsif existing_membership.status = 'active'
    and existing_membership.deleted_at is null then
    -- The administrator is already a genuine member of this client. Reuse that
    -- membership instead of granting a second, broader one.
    managed_membership_id := existing_membership.membership_id;
  else
    perform app_private.platform_admin_write_audit(
      target_tenant_id,
      'platform.tenant.enter',
      'tenant',
      target_tenant_id::text,
      'deny',
      'membership_conflict',
      null
    );
    return jsonb_build_object('ok', false, 'code', 'membership_conflict');
  end if;

  select s.* into active_session
  from app_private.platform_admin_tenant_sessions s
  where s.auth_user_id = caller_id
    and s.status = 'active';

  if found then
    restored_tenant_id := active_session.previous_tenant_id;
    restored_membership_id := active_session.previous_membership_id;
    update app_private.platform_admin_tenant_sessions s
    set status = 'exited',
        exited_at = now(),
        updated_at = now()
    where s.session_id = active_session.session_id;
    perform app_private.platform_admin_write_audit(
      active_session.tenant_id,
      'platform.tenant.exit',
      'tenant',
      active_session.tenant_id::text,
      'allow',
      'superseded_by_new_entry',
      active_session.session_id::text
    );
  else
    select s.tenant_id, s.membership_id
    into restored_tenant_id, restored_membership_id
    from app_private.supabase_auth_tenant_selections s
    where s.auth_user_id = caller_id;
  end if;

  -- Never record the tenant being entered as the tenant to return to.
  if restored_tenant_id = target_tenant_id then
    restored_tenant_id := null;
    restored_membership_id := null;
  end if;

  insert into app_private.supabase_auth_tenant_selections (
    auth_user_id, principal_id, tenant_id, membership_id
  ) values (
    caller_id, linked_principal_id, target_tenant_id, managed_membership_id
  )
  on conflict (auth_user_id) do update
    set principal_id = excluded.principal_id,
        tenant_id = excluded.tenant_id,
        membership_id = excluded.membership_id,
        selection_version =
          app_private.supabase_auth_tenant_selections.selection_version + 1,
        selected_at = now(),
        updated_at = now()
  returning
    app_private.supabase_auth_tenant_selections.selection_version
  into new_selection_version;

  insert into app_private.platform_admin_tenant_sessions (
    auth_user_id, principal_id, tenant_id, membership_id,
    previous_tenant_id, previous_membership_id
  ) values (
    caller_id,
    linked_principal_id,
    target_tenant_id,
    managed_membership_id,
    restored_tenant_id,
    restored_membership_id
  )
  returning * into created_session;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.enter',
    'tenant',
    target_tenant_id::text,
    'allow',
    'platform_admin_entered_client_workspace',
    created_session.session_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'sessionId', created_session.session_id,
    'tenantId', tenant_record.tenant_id,
    'slug', tenant_record.slug,
    'displayName', tenant_record.display_name,
    'status', tenant_record.status,
    'membershipId', managed_membership_id,
    'identityRole', 'tenant_admin',
    'selectionVersion', new_selection_version,
    'enteredAt', created_session.entered_at,
    'claimsRefreshRequired', true
  );
end;
$$;

create or replace function public.platform_admin_exit_tenant()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  active_session record;
  managed_membership_id text;
  restored boolean := false;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller_id::text, 8021)
  );

  select s.* into active_session
  from app_private.platform_admin_tenant_sessions s
  where s.auth_user_id = caller_id
    and s.status = 'active';
  if not found then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'exited', false,
      'tenantId', null
    );
  end if;

  managed_membership_id := 'platform-admin:' || caller_id::text;

  if active_session.previous_tenant_id is not null
    and active_session.previous_membership_id is not null
    and exists (
      select 1
      from public.identity_memberships m
      where m.tenant_id = active_session.previous_tenant_id
        and m.membership_id = active_session.previous_membership_id
        and m.principal_id = active_session.principal_id
        and m.status = 'active'
        and m.deleted_at is null
    )
  then
    update app_private.supabase_auth_tenant_selections s
    set tenant_id = active_session.previous_tenant_id,
        membership_id = active_session.previous_membership_id,
        selection_version = s.selection_version + 1,
        selected_at = now(),
        updated_at = now()
    where s.auth_user_id = caller_id;
    restored := true;
  else
    delete from app_private.supabase_auth_tenant_selections s
    where s.auth_user_id = caller_id;
  end if;

  -- The elevated membership is only granted for the duration of the visit.
  if active_session.membership_id = managed_membership_id then
    update public.identity_memberships m
    set status = 'suspended',
        updated_at = now(),
        record_version = m.record_version + 1
    where m.tenant_id = active_session.tenant_id
      and m.membership_id = managed_membership_id;
  end if;

  update app_private.platform_admin_tenant_sessions s
  set status = 'exited',
      exited_at = now(),
      updated_at = now()
  where s.session_id = active_session.session_id;

  perform app_private.platform_admin_write_audit(
    active_session.tenant_id,
    'platform.tenant.exit',
    'tenant',
    active_session.tenant_id::text,
    'allow',
    'platform_admin_left_client_workspace',
    active_session.session_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'exited', true,
    'tenantId', active_session.tenant_id,
    'restoredPreviousTenant', restored,
    'previousTenantId', active_session.previous_tenant_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Account lifecycle
-- ---------------------------------------------------------------------------

-- Suspension needs no new enforcement point. Every linked session resolves its
-- tenant through app_private.supabase_auth_context_for_user, which already
-- requires tenants.status in ('provisioning', 'active'); a suspended tenant
-- therefore yields a null app_private.current_tenant_id() and every RLS policy
-- denies. public.auth_select_tenant refuses reselection for the same reason.
create or replace function public.platform_admin_set_tenant_status(
  target_tenant_id uuid,
  target_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  tenant_record record;
  updated_tenant record;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or target_status is null
    or target_status not in ('active', 'suspended')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select t.* into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  if tenant_record.status = target_status then
    perform app_private.platform_admin_write_audit(
      target_tenant_id,
      'platform.tenant.status.set',
      'tenant',
      target_tenant_id::text,
      'not_applicable',
      'status_unchanged',
      target_status
    );
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'tenantId', target_tenant_id,
      'previousStatus', tenant_record.status,
      'status', tenant_record.status,
      'changed', false
    );
  end if;

  update public.tenants t
  set status = target_status
  where t.tenant_id = target_tenant_id
  returning t.* into updated_tenant;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.status.set',
    'tenant',
    target_tenant_id::text,
    'allow',
    case
      when target_status = 'suspended' then 'tenant_suspended'
      else 'tenant_activated'
    end,
    target_status
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', target_tenant_id,
    'previousStatus', tenant_record.status,
    'status', updated_tenant.status,
    'changed', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-client detail
-- ---------------------------------------------------------------------------

create or replace function public.platform_admin_tenant_detail(
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
  sections jsonb;
  counts jsonb;
  readiness jsonb;
  last_activity timestamptz;
  session_state jsonb;
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
        'sectionKey', d.section_key,
        'enabled', coalesce(s.enabled, d.default_enabled),
        'updatedAt', s.updated_at
      )
      order by d.display_position
    ),
    '[]'::jsonb
  )
  into sections
  from app_private.tenant_section_definitions() d
  left join public.tenant_sections s
    on s.tenant_id = target_tenant_id
   and s.section_key = d.section_key
   and s.deleted_at is null;

  select jsonb_build_object(
    'members', coalesce(member_counts.total, 0),
    'admins', coalesce(member_counts.admins, 0),
    'courses', coalesce(course_counts.total, 0),
    'publishedCourses', coalesce(course_counts.published, 0),
    'sources', coalesce(source_counts.total, 0),
    'knowledgeChunks', coalesce(chunk_counts.total, 0),
    'conversations', coalesce(conversation_counts.total, 0)
  )
  into counts
  from (select 1) anchor
  left join lateral (
    select
      count(*)::bigint as total,
      count(*) filter (
        where m.role in ('tenant_owner', 'tenant_admin')
      )::bigint as admins
    from public.identity_memberships m
    where m.tenant_id = target_tenant_id
      and m.status = 'active'
      and m.deleted_at is null
  ) member_counts on true
  left join lateral (
    select
      count(*)::bigint as total,
      count(*) filter (where c.status = 'published')::bigint as published
    from public.courses c
    where c.tenant_id = target_tenant_id
      and c.deleted_at is null
  ) course_counts on true
  left join lateral (
    select count(*)::bigint as total
    from public.learning_sources s
    where s.tenant_id = target_tenant_id
      and s.deleted_at is null
  ) source_counts on true
  left join lateral (
    select count(*)::bigint as total
    from public.learning_chunks c
    where c.tenant_id = target_tenant_id
      and c.deleted_at is null
  ) chunk_counts on true
  left join lateral (
    select count(*)::bigint as total
    from public.conversations c
    where c.tenant_id = target_tenant_id
      and c.deleted_at is null
  ) conversation_counts on true;

  select greatest(
    tenant_record.updated_at,
    coalesce((
      select max(c.updated_at)
      from public.courses c
      where c.tenant_id = target_tenant_id
        and c.deleted_at is null
    ), tenant_record.updated_at),
    coalesce((
      select max(e.occurred_at)
      from public.learning_usage_events e
      where e.tenant_id = target_tenant_id
    ), tenant_record.updated_at),
    coalesce((
      select max(p.last_activity_at)
      from public.lesson_progress p
      where p.tenant_id = target_tenant_id
        and p.deleted_at is null
    ), tenant_record.updated_at)
  )
  into last_activity;

  select jsonb_build_object(
    'onboardingStatus', coalesce(w.status, 'not_started'),
    'launchedAt', w.launched_at,
    'hasBranding', exists (
      select 1
      from public.tenant_branding b
      where b.tenant_id = target_tenant_id
        and b.status = 'published'
        and b.deleted_at is null
    ),
    'hasPublishedCourse', exists (
      select 1
      from public.courses c
      where c.tenant_id = target_tenant_id
        and c.status = 'published'
        and c.deleted_at is null
    ),
    'hasKnowledge', exists (
      select 1
      from public.learning_chunks c
      where c.tenant_id = target_tenant_id
        and c.deleted_at is null
    ),
    'hasActiveMembers', exists (
      select 1
      from public.identity_memberships m
      where m.tenant_id = target_tenant_id
        and m.status = 'active'
        and m.deleted_at is null
    )
  )
  into readiness
  from (select 1) anchor
  left join public.onboarding_workspaces w
    on w.tenant_id = target_tenant_id
   and w.deleted_at is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sessionId', s.session_id,
        'enteredAt', s.entered_at,
        'isCaller', s.auth_user_id = auth.uid()
      )
      order by s.entered_at desc
    ),
    '[]'::jsonb
  )
  into session_state
  from app_private.platform_admin_tenant_sessions s
  where s.tenant_id = target_tenant_id
    and s.status = 'active';

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', clock_timestamp(),
    'tenant', jsonb_build_object(
      'tenantId', tenant_record.tenant_id,
      'slug', tenant_record.slug,
      'displayName', tenant_record.display_name,
      'status', tenant_record.status,
      'region', tenant_record.region,
      'assistantName', coalesce((
        select b.assistant_name
        from public.tenant_branding b
        where b.tenant_id = target_tenant_id
          and b.status = 'published'
          and b.deleted_at is null
        order by b.version_number desc
        limit 1
      ), 'LearningBot'),
      'createdAt', tenant_record.created_at,
      'updatedAt', tenant_record.updated_at
    ),
    'sections', sections,
    'counts', counts,
    'readiness', readiness,
    'lastActivityAt', last_activity,
    'activePlatformSessions', session_state
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution boundary
-- ---------------------------------------------------------------------------

revoke execute on function public.tenant_get_sections()
  from public, anon, service_role;
revoke execute on function public.platform_admin_set_tenant_section(
  uuid, text, boolean
) from public, anon, service_role;
revoke execute on function public.platform_admin_enter_tenant(uuid)
  from public, anon, service_role;
revoke execute on function public.platform_admin_exit_tenant()
  from public, anon, service_role;
revoke execute on function public.platform_admin_set_tenant_status(uuid, text)
  from public, anon, service_role;
revoke execute on function public.platform_admin_tenant_detail(uuid)
  from public, anon, service_role;

grant execute on function public.tenant_get_sections()
  to authenticated;
grant execute on function public.platform_admin_set_tenant_section(
  uuid, text, boolean
) to authenticated;
grant execute on function public.platform_admin_enter_tenant(uuid)
  to authenticated;
grant execute on function public.platform_admin_exit_tenant()
  to authenticated;
grant execute on function public.platform_admin_set_tenant_status(uuid, text)
  to authenticated;
grant execute on function public.platform_admin_tenant_detail(uuid)
  to authenticated;

commit;
