-- Run after migrations 0001..0011 on a disposable Supabase database.
-- Verifies AUTH-01 first-owner bootstrap, AUTH-02 metadata isolation,
-- AUTH-03 exact multi-tenant selection, AUTH-04 revocation freshness and
-- AUTH-05 privileged-function/table boundaries. All fixtures roll back.

begin;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1100000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'owner-auth-bridge@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"tenant_id":"ff000000-0000-4000-8000-000000000001","app_role":"owner"}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a2200000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'forged-auth-bridge@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"tenant_id":"ff000000-0000-4000-8000-000000000001","app_role":"owner"}',
    now(),
    now()
  );

-- AUTH-02: user-editable user_metadata cannot establish a tenant or role.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'user_metadata', jsonb_build_object(
      'tenant_id', 'ff000000-0000-4000-8000-000000000001',
      'app_role', 'owner'
    )
  )::text,
  true
);
do $$
begin
  if app_private.current_tenant_id() is not null
    or app_private.current_app_role() <> ''
  then
    raise exception 'AUTH-02 failed: user_metadata established authorization';
  end if;
  if (select count(*) from public.tenants) <> 0 then
    raise exception 'AUTH-02 failed: forged user_metadata exposed a tenant';
  end if;
end $$;
reset role;

-- AUTH-01: the verified auth UID atomically creates exactly one first-owner
-- tenant and remains idempotent even if a retry carries a different slug/name.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb,
    'user_metadata', jsonb_build_object(
      'tenant_id', 'ff000000-0000-4000-8000-000000000001',
      'app_role', 'owner'
    )
  )::text,
  true
);
do $$
declare
  first_result record;
  retry_result record;
begin
  select * into first_result
  from public.auth_bootstrap_tenant_owner(
    'auth-bridge-owner',
    'Auth Bridge Owner',
    'auth-bridge-bootstrap-1',
    'trace-auth-bridge-bootstrap-1'
  );
  if first_result.created is not true
    or first_result.tenant_id is null
    or first_result.membership_id is null
  then
    raise exception 'AUTH-01 failed: first bootstrap did not create an owner';
  end if;

  select * into retry_result
  from public.auth_bootstrap_tenant_owner(
    'must-not-create-second-tenant',
    'Must Not Create Second Tenant',
    'auth-bridge-bootstrap-retry',
    'trace-auth-bridge-bootstrap-retry'
  );
  if retry_result.created is not false
    or retry_result.tenant_id <> first_result.tenant_id
    or retry_result.membership_id <> first_result.membership_id
    or retry_result.selection_version <> first_result.selection_version
  then
    raise exception 'AUTH-01 failed: retry was not idempotent';
  end if;
end $$;
reset role;

do $$
declare
  owner_tenant_id uuid;
  owner_principal_id text;
begin
  select l.principal_id
  into owner_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = 'a1100000-0000-4000-8000-000000000001';
  select m.tenant_id
  into owner_tenant_id
  from public.identity_memberships m
  where m.principal_id = owner_principal_id
    and m.role = 'tenant_owner';

  if (
    select count(*)
    from public.identity_memberships m
    where m.principal_id = owner_principal_id
      and m.role = 'tenant_owner'
  ) <> 1 then
    raise exception 'AUTH-01 failed: bootstrap created multiple owner tenants';
  end if;
  if not exists (
    select 1
    from public.onboarding_workspaces w
    where w.tenant_id = owner_tenant_id
      and w.owner_membership_id in (
        select m.membership_id
        from public.identity_memberships m
        where m.tenant_id = owner_tenant_id
          and m.principal_id = owner_principal_id
          and m.role = 'tenant_owner'
      )
  ) then
    raise exception 'AUTH-01 failed: owner onboarding was not bound';
  end if;
  if (
    select count(*)
    from public.onboarding_steps s
    where s.tenant_id = owner_tenant_id
  ) <> 14 then
    raise exception 'AUTH-01 failed: onboarding steps were not seeded';
  end if;
  if not exists (
    select 1
    from public.identity_audit_events a
    where a.tenant_id = owner_tenant_id
      and a.action = 'auth.tenant_owner.bootstrap'
      and a.outcome = 'allowed'
  ) then
    raise exception 'AUTH-01 failed: bootstrap audit fact is missing';
  end if;
end $$;

-- Create one valid second membership for the owner and one unrelated tenant.
insert into public.tenants (
  tenant_id, slug, display_name, status, settings, idempotency_key
) values
  (
    'a3300000-0000-4000-8000-000000000003',
    'auth-bridge-second',
    'Auth Bridge Second',
    'active',
    '{}'::jsonb,
    'auth-bridge-second-tenant'
  ),
  (
    'a4400000-0000-4000-8000-000000000004',
    'auth-bridge-unrelated',
    'Auth Bridge Unrelated',
    'active',
    '{}'::jsonb,
    'auth-bridge-unrelated-tenant'
  );

insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
)
select
  'auth-bridge-teacher-membership',
  'a3300000-0000-4000-8000-000000000003',
  l.principal_id,
  'teacher',
  'active',
  'manual',
  'auth-bridge-teacher-membership'
from app_private.supabase_auth_principal_links l
where l.auth_user_id = 'a1100000-0000-4000-8000-000000000001';

-- AUTH-03: selection requires the exact active principal+tenant membership.
-- A denied cross-tenant attempt is audited and cannot change the selection.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', jsonb_build_object(
      'learningbot_tenant_id',
      'ff000000-0000-4000-8000-000000000001',
      'learningbot_app_role', 'owner',
      'learningbot_membership_id', 'stale-owner-membership',
      'learningbot_selection_version', 1
    )
  )::text,
  true
);
do $$
declare
  selected_result record;
  selected_retry record;
  denied_result record;
  context_result record;
begin
  select * into selected_result
  from public.auth_select_tenant(
    'a3300000-0000-4000-8000-000000000003',
    'auth-select-second',
    'trace-auth-select-second'
  );
  if selected_result.selected is not true
    or selected_result.identity_role <> 'teacher'
    or selected_result.app_role <> 'client_viewer'
  then
    raise exception 'AUTH-03 failed: exact second membership was not selected';
  end if;
  select * into selected_retry
  from public.auth_select_tenant(
    'a3300000-0000-4000-8000-000000000003',
    'auth-select-second',
    'trace-auth-select-second'
  );
  if selected_retry.selection_version <> selected_result.selection_version then
    raise exception 'AUTH-03 failed: selection retry changed its version';
  end if;
  if app_private.current_tenant_id()
      <> 'a3300000-0000-4000-8000-000000000003'
    or app_private.current_app_role() <> 'client_viewer'
  then
    raise exception 'AUTH-03 failed: stale claims won over durable selection';
  end if;

  select * into context_result
  from public.auth_current_tenant_context();
  if context_result.claims_refresh_required is not true then
    raise exception 'AUTH-03 failed: stale claims did not request refresh';
  end if;

  select * into denied_result
  from public.auth_select_tenant(
    'a4400000-0000-4000-8000-000000000004',
    'auth-select-forbidden',
    'trace-auth-select-forbidden'
  );
  if denied_result.selected is not false
    or denied_result.reason <> 'membership_not_active'
    or app_private.current_tenant_id()
      <> 'a3300000-0000-4000-8000-000000000003'
  then
    raise exception 'AUTH-03 failed: cross-tenant selection changed context';
  end if;

  if (select count(*) from public.tenants) <> 1
    or not exists (
      select 1
      from public.tenants t
      where t.tenant_id = 'a3300000-0000-4000-8000-000000000003'
    )
  then
    raise exception 'AUTH-03 failed: RLS exposed a non-selected tenant';
  end if;
end $$;
reset role;

do $$
begin
  if not exists (
    select 1
    from public.identity_audit_events a
    where a.tenant_id = 'a4400000-0000-4000-8000-000000000004'
      and a.action = 'auth.tenant.select'
      and a.outcome = 'denied'
      and a.safe_metadata ->> 'reason' = 'membership_not_active'
  ) then
    raise exception 'AUTH-03 failed: denied selection was not audited';
  end if;
end $$;

-- AUTH-04: revocation takes effect in the database immediately, even while
-- the access token still carries the former tenant and role.
update public.identity_memberships
set status = 'revoked',
    deleted_at = now()
where tenant_id = 'a3300000-0000-4000-8000-000000000003'
  and membership_id = 'auth-bridge-teacher-membership';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', jsonb_build_object(
      'learningbot_tenant_id',
      'a3300000-0000-4000-8000-000000000003',
      'learningbot_app_role', 'client_viewer',
      'learningbot_membership_id', 'auth-bridge-teacher-membership',
      'learningbot_selection_version', 3
    )
  )::text,
  true
);
do $$
declare
  context_result record;
begin
  select * into context_result
  from public.auth_current_tenant_context();
  if context_result.selected is not false
    or app_private.current_tenant_id() is not null
    or app_private.current_app_role() <> ''
    or (select count(*) from public.tenants) <> 0
  then
    raise exception 'AUTH-04 failed: revoked membership retained access';
  end if;

end $$;
reset role;

do $$
declare
  hook_result jsonb;
begin
  select public.learningbot_custom_access_token_hook(
    jsonb_build_object(
      'user_id', 'a1100000-0000-4000-8000-000000000001',
      'claims', app_private.jwt_claims()
    )
  ) into hook_result;
  if hook_result -> 'claims' -> 'app_metadata'
      ? 'learningbot_tenant_id'
  then
    raise exception 'AUTH-04 failed: hook retained revoked tenant claim';
  end if;
end $$;

-- AUTH-05: private mappings and every SECURITY DEFINER bridge entrypoint are
-- unavailable to PUBLIC/anon; authenticated can execute only the UID-bound RPCs.
do $$
begin
  if exists (
    select 1
    from information_schema.routine_privileges p
    where p.specific_schema = 'public'
      and p.routine_name in (
        'auth_bootstrap_tenant_owner',
        'auth_list_tenant_memberships',
        'auth_select_tenant',
        'auth_current_tenant_context',
        'learningbot_custom_access_token_hook'
      )
      and p.grantee = 'PUBLIC'
      and p.privilege_type = 'EXECUTE'
  )
    or has_function_privilege(
      'anon',
      'public.auth_select_tenant(uuid,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.learningbot_custom_access_token_hook(jsonb)',
      'EXECUTE'
    )
  then
    raise exception 'AUTH-05 failed: PUBLIC can execute a definer function';
  end if;
end $$;

set local role authenticated;
do $$
begin
  begin
    perform count(*)
    from app_private.supabase_auth_principal_links;
    raise exception 'AUTH-05 failed: authenticated read private links';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.learningbot_custom_access_token_hook('{}'::jsonb);
    raise exception 'AUTH-05 failed: authenticated executed auth hook';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
