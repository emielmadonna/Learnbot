-- Supabase Auth bridge for first-owner bootstrap and refresh-safe tenant
-- selection. Authorization is derived from durable active memberships. JWT
-- app_metadata is refreshed by the optional access-token hook, but is never
-- the source of truth and user_metadata is never consulted.

begin;

create table app_private.supabase_auth_principal_links (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  principal_id text not null unique
    references public.identity_principals(principal_id),
  bootstrap_tenant_id uuid references public.tenants(tenant_id),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null unique check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_user_id, principal_id)
);
create index supabase_auth_principal_links_bootstrap_tenant_idx
  on app_private.supabase_auth_principal_links (bootstrap_tenant_id)
  where bootstrap_tenant_id is not null;

create table app_private.supabase_auth_tenant_selections (
  auth_user_id uuid primary key,
  principal_id text not null,
  tenant_id uuid not null,
  membership_id text not null,
  selection_version bigint not null default 1 check (selection_version > 0),
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (auth_user_id, principal_id)
    references app_private.supabase_auth_principal_links(
      auth_user_id, principal_id
    )
    on delete cascade,
  foreign key (tenant_id, membership_id, principal_id)
    references public.identity_memberships(
      tenant_id, membership_id, principal_id
    )
);
create index supabase_auth_tenant_selections_membership_idx
  on app_private.supabase_auth_tenant_selections (
    tenant_id, membership_id, principal_id
  );

revoke all on table
  app_private.supabase_auth_principal_links,
  app_private.supabase_auth_tenant_selections
from public, anon, authenticated;
grant select, insert, update, delete on table
  app_private.supabase_auth_principal_links,
  app_private.supabase_auth_tenant_selections
to service_role;

create or replace function app_private.supabase_auth_context_for_user(
  target_auth_user_id uuid
)
returns table (
  tenant_id uuid,
  membership_id text,
  principal_id text,
  identity_role text,
  app_role text,
  selection_version bigint
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    s.tenant_id,
    s.membership_id,
    s.principal_id,
    m.role,
    case m.role
      when 'tenant_owner' then 'owner'
      when 'tenant_admin' then 'client_admin'
      when 'creator' then 'client_viewer'
      when 'teacher' then 'client_viewer'
      when 'student' then 'student'
      when 'service' then 'system_worker'
      else ''
    end,
    s.selection_version
  from app_private.supabase_auth_tenant_selections s
  join public.identity_memberships m
    on m.tenant_id = s.tenant_id
   and m.membership_id = s.membership_id
   and m.principal_id = s.principal_id
  join public.tenants t
    on t.tenant_id = s.tenant_id
  where target_auth_user_id is not null
    and s.auth_user_id = target_auth_user_id
    and m.status = 'active'
    and m.deleted_at is null
    and t.status in ('provisioning', 'active')
    and t.deleted_at is null;
$$;
revoke execute on function
  app_private.supabase_auth_context_for_user(uuid)
from public, anon, authenticated, service_role;

-- Linked Supabase users always use the durable selected membership. Existing
-- trusted, non-Supabase host/service identities retain the original custom
-- claim path. Stale JWT claims therefore cannot preserve access after a
-- membership is suspended, revoked or switched.
create or replace function app_private.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with caller as (
    select auth.uid() as auth_user_id
  ),
  linked as (
    select exists (
      select 1
      from app_private.supabase_auth_principal_links l, caller c
      where l.auth_user_id = c.auth_user_id
    ) as is_linked
  ),
  durable_context as (
    select c.tenant_id
    from caller u
    cross join lateral
      app_private.supabase_auth_context_for_user(u.auth_user_id) c
  ),
  trusted_claim as (
    select coalesce(
      app_private.jwt_claims()
        -> 'app_metadata' ->> 'learningbot_tenant_id',
      app_private.jwt_claims() ->> 'tenant_id'
    ) as tenant_claim
  )
  select case
    when (select is_linked from linked)
      then (select tenant_id from durable_context limit 1)
    when (select tenant_claim from trusted_claim)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (select tenant_claim from trusted_claim)::uuid
    else null
  end;
$$;

create or replace function app_private.current_app_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with caller as (
    select auth.uid() as auth_user_id
  ),
  linked as (
    select exists (
      select 1
      from app_private.supabase_auth_principal_links l, caller c
      where l.auth_user_id = c.auth_user_id
    ) as is_linked
  ),
  durable_context as (
    select c.app_role
    from caller u
    cross join lateral
      app_private.supabase_auth_context_for_user(u.auth_user_id) c
  )
  select case
    when (select is_linked from linked)
      then coalesce((select app_role from durable_context limit 1), '')
    else coalesce(
      app_private.jwt_claims()
        -> 'app_metadata' ->> 'learningbot_app_role',
      app_private.jwt_claims() ->> 'app_role',
      ''
    )
  end;
$$;

revoke execute on function app_private.current_tenant_id()
  from public, anon;
revoke execute on function app_private.current_app_role()
  from public, anon;
grant execute on function app_private.current_tenant_id()
  to authenticated;
grant execute on function app_private.current_app_role()
  to authenticated;

create or replace function public.auth_bootstrap_tenant_owner(
  requested_slug text,
  requested_display_name text,
  request_id text,
  trace_id text,
  requested_region text default null,
  requested_assistant_name text default 'Estie',
  requested_primary_color text default '#635BFF',
  requested_accent_color text default '#00A88F'
)
returns table (
  tenant_id uuid,
  membership_id text,
  principal_id text,
  selection_version bigint,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  linked_principal_id text;
  owner_membership_id text;
  owner_tenant_id uuid;
  current_selection_version bigint;
  bootstrap_key text;
  step_key text;
begin
  if caller_id is null
    or coalesce(
      (app_private.jwt_claims() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise insufficient_privilege
      using message = 'A non-anonymous authenticated user is required';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = caller_id
      and coalesce(u.email_confirmed_at, u.phone_confirmed_at) is not null
      and u.deleted_at is null
  ) then
    raise insufficient_privilege
      using message = 'A verified active auth user is required';
  end if;
  if requested_slug is null
    or requested_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
  then
    raise invalid_parameter_value using message = 'Invalid tenant slug';
  end if;
  if requested_display_name is null
    or length(btrim(requested_display_name)) not between 1 and 160
  then
    raise invalid_parameter_value using message = 'Invalid tenant name';
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
  then
    raise invalid_parameter_value
      using message = 'request_id and trace_id are required';
  end if;
  if requested_assistant_name is null
    or length(btrim(requested_assistant_name)) not between 1 and 80
    or requested_primary_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_accent_color !~ '^#[0-9A-Fa-f]{6}$'
  then
    raise invalid_parameter_value using message = 'Invalid branding seed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller_id::text, 8011)
  );

  select l.principal_id, l.bootstrap_tenant_id
  into linked_principal_id, owner_tenant_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_id;

  if linked_principal_id is not null then
    select m.membership_id
    into owner_membership_id
    from public.identity_memberships m
    where m.principal_id = linked_principal_id
      and m.tenant_id = owner_tenant_id
      and m.role = 'tenant_owner'
      and m.status = 'active'
      and m.deleted_at is null
    order by m.created_at, m.tenant_id
    limit 1;
    if owner_tenant_id is null or owner_membership_id is null then
      raise object_not_in_prerequisite_state
        using message = 'Auth user is linked without an active owner membership';
    end if;

    insert into app_private.supabase_auth_tenant_selections (
      auth_user_id, principal_id, tenant_id, membership_id
    ) values (
      caller_id, linked_principal_id, owner_tenant_id, owner_membership_id
    )
    on conflict (auth_user_id) do update
      set principal_id = excluded.principal_id,
          tenant_id = excluded.tenant_id,
          membership_id = excluded.membership_id,
          selection_version = case
            when (
              app_private.supabase_auth_tenant_selections.principal_id,
              app_private.supabase_auth_tenant_selections.tenant_id,
              app_private.supabase_auth_tenant_selections.membership_id
            ) is distinct from (
              excluded.principal_id,
              excluded.tenant_id,
              excluded.membership_id
            )
            then
              app_private.supabase_auth_tenant_selections.selection_version + 1
            else app_private.supabase_auth_tenant_selections.selection_version
          end,
          selected_at = case
            when (
              app_private.supabase_auth_tenant_selections.principal_id,
              app_private.supabase_auth_tenant_selections.tenant_id,
              app_private.supabase_auth_tenant_selections.membership_id
            ) is distinct from (
              excluded.principal_id,
              excluded.tenant_id,
              excluded.membership_id
            )
            then now()
            else app_private.supabase_auth_tenant_selections.selected_at
          end,
          updated_at = case
            when (
              app_private.supabase_auth_tenant_selections.principal_id,
              app_private.supabase_auth_tenant_selections.tenant_id,
              app_private.supabase_auth_tenant_selections.membership_id
            ) is distinct from (
              excluded.principal_id,
              excluded.tenant_id,
              excluded.membership_id
            )
            then now()
            else app_private.supabase_auth_tenant_selections.updated_at
          end
    returning
      app_private.supabase_auth_tenant_selections.selection_version
    into current_selection_version;

    tenant_id := owner_tenant_id;
    membership_id := owner_membership_id;
    principal_id := linked_principal_id;
    selection_version := current_selection_version;
    created := false;
    return next;
    return;
  end if;

  bootstrap_key :=
    'auth-bootstrap:' ||
    encode(
      extensions.digest(
        caller_id::text || chr(31) || request_id,
        'sha256'
      ),
      'hex'
    );
  owner_tenant_id := gen_random_uuid();
  linked_principal_id := 'supabase-auth:' || caller_id::text;
  owner_membership_id := 'supabase-auth-owner:' || caller_id::text;

  insert into public.tenants (
    tenant_id, slug, display_name, status, region, settings, idempotency_key
  ) values (
    owner_tenant_id,
    requested_slug,
    btrim(requested_display_name),
    'provisioning',
    nullif(btrim(requested_region), ''),
    jsonb_build_object(
      'planId', 'unconfirmed',
      'locale', 'en-US',
      'timeZone', 'UTC',
      'featureFlags', '{}'::jsonb,
      'limits', '{}'::jsonb,
      'policyVersion', 'unconfirmed'
    ),
    bootstrap_key
  );

  insert into public.roles (
    tenant_id, role_key, display_name, capabilities, idempotency_key
  )
  select
    owner_tenant_id,
    role_seed.role_key,
    role_seed.display_name,
    role_seed.capabilities,
    bootstrap_key || ':role:' || role_seed.role_key
  from (
    values
      ('owner', 'Owner', array['tenant.*']::text[]),
      ('client_admin', 'Client administrator', array['tenant.manage']::text[]),
      ('client_viewer', 'Client viewer', array['tenant.read']::text[]),
      ('student', 'Student', array['learning.read']::text[]),
      ('system_worker', 'System worker', array['system.execute']::text[])
  ) as role_seed(role_key, display_name, capabilities);

  insert into public.identity_principals (
    principal_id, principal_kind, authentication_method, issuer, subject,
    idempotency_key
  ) values (
    linked_principal_id,
    'human',
    'host_signed',
    'supabase-auth',
    caller_id::text,
    bootstrap_key || ':principal'
  );

  insert into app_private.supabase_auth_principal_links (
    auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
  ) values (
    caller_id,
    linked_principal_id,
    owner_tenant_id,
    bootstrap_key || ':link'
  );

  insert into public.identity_memberships (
    membership_id, tenant_id, principal_id, role, status, provisioned_by,
    idempotency_key
  ) values (
    owner_membership_id,
    owner_tenant_id,
    linked_principal_id,
    'tenant_owner',
    'active',
    'host',
    bootstrap_key || ':identity-membership'
  );

  insert into public.profiles (
    tenant_id, user_id, display_name, idempotency_key
  ) values (
    owner_tenant_id,
    caller_id,
    btrim(requested_display_name) || ' owner',
    bootstrap_key || ':profile'
  );
  insert into public.memberships (
    tenant_id, user_id, role_key, status, idempotency_key
  ) values (
    owner_tenant_id,
    caller_id,
    'owner',
    'active',
    bootstrap_key || ':legacy-membership'
  );

  insert into public.tenant_branding (
    tenant_id, status, version_number, assistant_name, primary_color,
    accent_color, surface_color, text_color, welcome_message,
    idempotency_key
  ) values (
    owner_tenant_id,
    'draft',
    1,
    btrim(requested_assistant_name),
    upper(requested_primary_color),
    upper(requested_accent_color),
    '#F7F8FC',
    '#101828',
    'How can I help you learn today?',
    bootstrap_key || ':branding'
  );

  insert into public.onboarding_workspaces (
    tenant_id, status, circle_plan, expected_identity_mode,
    owner_membership_id, idempotency_key
  ) values (
    owner_tenant_id,
    'in_progress',
    'unconfirmed',
    'unconfirmed',
    owner_membership_id,
    bootstrap_key || ':onboarding'
  );

  foreach step_key in array array[
    'tenant_profile',
    'identity_mode',
    'provider_funding',
    'source_ingestion',
    'assistant_voice_guide',
    'diagram_review',
    'context_mapping',
    'widget_branding',
    'privacy_consent',
    'recording_policy',
    'retention_policy',
    'playground_qa',
    'install_verification',
    'client_handoff'
  ]
  loop
    insert into public.onboarding_steps (
      tenant_id, onboarding_id, step_key, status, required, evidence_ref,
      completed_by_principal_id, completed_at, idempotency_key
    )
    select
      owner_tenant_id,
      w.onboarding_id,
      step_key,
      case when step_key = 'tenant_profile' then 'complete'
        else 'not_started'
      end,
      true,
      case when step_key = 'tenant_profile'
        then 'auth-bootstrap:' || request_id
        else null
      end,
      case when step_key = 'tenant_profile'
        then linked_principal_id
        else null
      end,
      case when step_key = 'tenant_profile'
        then now()
        else null
      end,
      bootstrap_key || ':step:' || step_key
    from public.onboarding_workspaces w
    where w.tenant_id = owner_tenant_id;
  end loop;

  insert into app_private.supabase_auth_tenant_selections (
    auth_user_id, principal_id, tenant_id, membership_id
  ) values (
    caller_id, linked_principal_id, owner_tenant_id, owner_membership_id
  )
  returning
    app_private.supabase_auth_tenant_selections.selection_version
  into current_selection_version;

  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    owner_tenant_id,
    linked_principal_id,
    'auth.tenant_owner.bootstrap',
    'allowed',
    'tenant',
    owner_tenant_id::text,
    request_id,
    trace_id,
    jsonb_build_object('auth_binding', 'supabase-auth'),
    bootstrap_key || ':audit'
  );

  tenant_id := owner_tenant_id;
  membership_id := owner_membership_id;
  principal_id := linked_principal_id;
  selection_version := current_selection_version;
  created := true;
  return next;
end;
$$;

create or replace function public.auth_list_tenant_memberships()
returns table (
  tenant_id uuid,
  tenant_slug text,
  tenant_display_name text,
  membership_id text,
  identity_role text,
  selected boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    m.tenant_id,
    t.slug,
    t.display_name,
    m.membership_id,
    m.role,
    coalesce(s.tenant_id = m.tenant_id, false)
  from app_private.supabase_auth_principal_links l
  join public.identity_memberships m
    on m.principal_id = l.principal_id
  join public.tenants t
    on t.tenant_id = m.tenant_id
  left join app_private.supabase_auth_tenant_selections s
    on s.auth_user_id = l.auth_user_id
   and s.principal_id = l.principal_id
   and s.tenant_id = m.tenant_id
   and s.membership_id = m.membership_id
  where l.auth_user_id = auth.uid()
    and m.status = 'active'
    and m.deleted_at is null
    and t.status in ('provisioning', 'active')
    and t.deleted_at is null
  order by t.display_name, t.tenant_id;
$$;

create or replace function public.auth_select_tenant(
  target_tenant_id uuid,
  request_id text,
  trace_id text
)
returns table (
  selected boolean,
  tenant_id uuid,
  membership_id text,
  identity_role text,
  app_role text,
  selection_version bigint,
  reason text
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  linked_principal_id text;
  active_membership_id text;
  active_identity_role text;
  mapped_app_role text;
  new_selection_version bigint;
begin
  if caller_id is null
    or coalesce(
      (app_private.jwt_claims() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise insufficient_privilege
      using message = 'A non-anonymous authenticated user is required';
  end if;
  if target_tenant_id is null
    or request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
  then
    raise invalid_parameter_value using message = 'Invalid selection request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller_id::text, 8011)
  );
  select l.principal_id
  into linked_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_id;
  if linked_principal_id is null then
    raise object_not_in_prerequisite_state
      using message = 'Auth user has not been bootstrapped';
  end if;

  select
    m.membership_id,
    m.role,
    case m.role
      when 'tenant_owner' then 'owner'
      when 'tenant_admin' then 'client_admin'
      when 'creator' then 'client_viewer'
      when 'teacher' then 'client_viewer'
      when 'student' then 'student'
      when 'service' then 'system_worker'
      else ''
    end
  into active_membership_id, active_identity_role, mapped_app_role
  from public.identity_memberships m
  join public.tenants t on t.tenant_id = m.tenant_id
  where m.tenant_id = target_tenant_id
    and m.principal_id = linked_principal_id
    and m.status = 'active'
    and m.deleted_at is null
    and t.status in ('provisioning', 'active')
    and t.deleted_at is null;

  if active_membership_id is null then
    if exists (
      select 1
      from public.tenants t
      where t.tenant_id = target_tenant_id
    ) then
      insert into public.identity_audit_events (
        tenant_id, actor_principal_id, action, outcome, resource_type,
        resource_id, request_id, trace_id, safe_metadata, idempotency_key
      ) values (
        target_tenant_id,
        linked_principal_id,
        'auth.tenant.select',
        'denied',
        'tenant',
        target_tenant_id::text,
        request_id,
        trace_id,
        jsonb_build_object('reason', 'membership_not_active'),
        'auth-select-denied:' ||
          encode(
            extensions.digest(
              caller_id::text || chr(31) || request_id,
              'sha256'
            ),
            'hex'
          )
      )
      on conflict (tenant_id, idempotency_key) do nothing;
    end if;
    selected := false;
    tenant_id := null;
    membership_id := null;
    identity_role := null;
    app_role := null;
    selection_version := null;
    reason := 'membership_not_active';
    return next;
    return;
  end if;

  insert into app_private.supabase_auth_tenant_selections (
    auth_user_id, principal_id, tenant_id, membership_id
  ) values (
    caller_id, linked_principal_id, target_tenant_id, active_membership_id
  )
  on conflict (auth_user_id) do update
    set principal_id = excluded.principal_id,
        tenant_id = excluded.tenant_id,
        membership_id = excluded.membership_id,
        selection_version = case
          when (
            app_private.supabase_auth_tenant_selections.principal_id,
            app_private.supabase_auth_tenant_selections.tenant_id,
            app_private.supabase_auth_tenant_selections.membership_id
          ) is distinct from (
            excluded.principal_id,
            excluded.tenant_id,
            excluded.membership_id
          )
          then
            app_private.supabase_auth_tenant_selections.selection_version + 1
          else app_private.supabase_auth_tenant_selections.selection_version
        end,
        selected_at = case
          when (
            app_private.supabase_auth_tenant_selections.principal_id,
            app_private.supabase_auth_tenant_selections.tenant_id,
            app_private.supabase_auth_tenant_selections.membership_id
          ) is distinct from (
            excluded.principal_id,
            excluded.tenant_id,
            excluded.membership_id
          )
          then now()
          else app_private.supabase_auth_tenant_selections.selected_at
        end,
        updated_at = case
          when (
            app_private.supabase_auth_tenant_selections.principal_id,
            app_private.supabase_auth_tenant_selections.tenant_id,
            app_private.supabase_auth_tenant_selections.membership_id
          ) is distinct from (
            excluded.principal_id,
            excluded.tenant_id,
            excluded.membership_id
          )
          then now()
          else app_private.supabase_auth_tenant_selections.updated_at
        end
  returning
    app_private.supabase_auth_tenant_selections.selection_version
  into new_selection_version;

  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    target_tenant_id,
    linked_principal_id,
    'auth.tenant.select',
    'allowed',
    'tenant',
    target_tenant_id::text,
    request_id,
    trace_id,
    jsonb_build_object(
      'membership_id', active_membership_id,
      'identity_role', active_identity_role
    ),
    'auth-select-allowed:' ||
      encode(
        extensions.digest(
          caller_id::text || chr(31) || request_id,
          'sha256'
        ),
        'hex'
      )
  )
  on conflict (tenant_id, idempotency_key) do nothing;

  selected := true;
  tenant_id := target_tenant_id;
  membership_id := active_membership_id;
  identity_role := active_identity_role;
  app_role := mapped_app_role;
  selection_version := new_selection_version;
  reason := 'selected';
  return next;
end;
$$;

create or replace function public.auth_current_tenant_context()
returns table (
  selected boolean,
  tenant_id uuid,
  membership_id text,
  principal_id text,
  identity_role text,
  app_role text,
  selection_version bigint,
  claims_refresh_required boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with durable as (
    select *
    from app_private.supabase_auth_context_for_user(auth.uid())
  ),
  claim_values as (
    select
      app_private.jwt_claims()
        -> 'app_metadata' ->> 'learningbot_tenant_id'
        as claim_tenant_id,
      app_private.jwt_claims()
        -> 'app_metadata' ->> 'learningbot_app_role'
        as claim_app_role,
      app_private.jwt_claims()
        -> 'app_metadata' ->> 'learningbot_membership_id'
        as claim_membership_id,
      app_private.jwt_claims()
        -> 'app_metadata' ->> 'learningbot_selection_version'
        as claim_selection_version
  )
  select
    durable.tenant_id is not null,
    durable.tenant_id,
    durable.membership_id,
    durable.principal_id,
    durable.identity_role,
    durable.app_role,
    durable.selection_version,
    durable.tenant_id is not null and (
      claim_values.claim_tenant_id is distinct from durable.tenant_id::text
      or claim_values.claim_app_role is distinct from durable.app_role
      or claim_values.claim_membership_id
        is distinct from durable.membership_id
      or claim_values.claim_selection_version
        is distinct from durable.selection_version::text
    )
  from (select true) anchor
  left join durable on true
  cross join claim_values;
$$;

-- Configure this function as the Supabase Auth Custom Access Token hook.
-- It copies only database-verified tenant context into app_metadata and removes
-- stale LearningBot claims when no active selection exists.
create or replace function public.learningbot_custom_access_token_hook(
  event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  hook_user_id uuid;
  claims jsonb;
  safe_app_metadata jsonb;
  durable record;
begin
  if event is null
    or event ->> 'user_id' is null
    or event -> 'claims' is null
  then
    raise invalid_parameter_value using message = 'Invalid auth hook event';
  end if;
  hook_user_id := (event ->> 'user_id')::uuid;
  claims := event -> 'claims';
  safe_app_metadata := case
    when jsonb_typeof(claims -> 'app_metadata') = 'object'
      then claims -> 'app_metadata'
    else '{}'::jsonb
  end;
  safe_app_metadata :=
    safe_app_metadata
      - 'learningbot_tenant_id'
      - 'learningbot_app_role'
      - 'learningbot_membership_id'
      - 'learningbot_selection_version';

  select * into durable
  from app_private.supabase_auth_context_for_user(hook_user_id)
  limit 1;
  if found then
    safe_app_metadata := safe_app_metadata
      || jsonb_build_object(
        'learningbot_tenant_id', durable.tenant_id::text,
        'learningbot_app_role', durable.app_role,
        'learningbot_membership_id', durable.membership_id,
        'learningbot_selection_version', durable.selection_version
      );
  end if;

  claims :=
    claims
      - 'tenant_id'
      - 'app_role'
      - 'membership_id'
      - 'tenant_selection_version';
  claims := jsonb_set(
    claims,
    array['app_metadata'],
    safe_app_metadata,
    true
  );
  return jsonb_set(event, array['claims'], claims, true);
end;
$$;

revoke execute on function public.auth_bootstrap_tenant_owner(
  text, text, text, text, text, text, text, text
) from public, anon;
revoke execute on function public.auth_list_tenant_memberships()
  from public, anon;
revoke execute on function public.auth_select_tenant(uuid, text, text)
  from public, anon;
revoke execute on function public.auth_current_tenant_context()
  from public, anon;
revoke execute on function public.learningbot_custom_access_token_hook(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.auth_bootstrap_tenant_owner(
  text, text, text, text, text, text, text, text
) to authenticated;
grant execute on function public.auth_list_tenant_memberships()
  to authenticated;
grant execute on function public.auth_select_tenant(uuid, text, text)
  to authenticated;
grant execute on function public.auth_current_tenant_context()
  to authenticated;
grant execute on function public.learningbot_custom_access_token_hook(jsonb)
  to supabase_auth_admin;

commit;
