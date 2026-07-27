-- Make managed-account creation observable and retry-safe at the boundary.
-- Auth credentials are still created and removed by the Edge Function; this
-- RPC never stores or returns a password.

begin;

create or replace function public.admin_list_access_accounts()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  accounts jsonb;
  usage jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'authUserId', a.auth_user_id,
    'email', a.email_normalized,
    'role', m.role,
    'status', m.status,
    'mustChangePassword', a.must_change_password,
    'createdAt', a.created_at,
    'passwordChangedAt', a.password_changed_at
  ) order by a.created_at), '[]'::jsonb)
  into accounts
  from app_private.user_access_accounts a
  join public.identity_memberships m
    on m.tenant_id = a.tenant_id
   and m.membership_id = a.membership_id
   and m.principal_id = a.principal_id
  where a.tenant_id = caller.tenant_id;

  select jsonb_build_object(
    'last30Days',
    coalesce((
      select jsonb_object_agg(event_name, event_count)
      from (
        select event_name, count(*)::bigint as event_count
        from public.learning_usage_events
        where tenant_id = caller.tenant_id
          and occurred_at >= clock_timestamp() - interval '30 days'
        group by event_name
      ) counts
    ), '{}'::jsonb),
    'activeLearners',
    coalesce((
      select count(distinct principal_id)
      from public.learning_usage_events
      where tenant_id = caller.tenant_id
        and occurred_at >= clock_timestamp() - interval '30 days'
        and (
          event_name like 'learning.%'
          or event_name like 'conversation.%'
          or event_name like 'voice.%'
        )
    ), 0)
  )
  into usage;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'accounts', accounts,
    'usage', coalesce(usage, '{"last30Days":{},"activeLearners":0}'::jsonb)
  );
end;
$$;

create or replace function public.admin_provision_auth_user(
  caller_auth_user_id uuid,
  target_auth_user_id uuid,
  target_email text,
  target_display_name text,
  target_identity_role text,
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  target_tenant_id uuid;
  target_principal_id text;
  target_membership_id text;
  legacy_role text;
  stage text := 'validate';
  normalized_email text := lower(btrim(target_email));
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_auth_user_id is null
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(btrim(coalesce(target_display_name, ''))) not between 1 and 160
    or target_identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher', 'student'
    )
    or requested_idempotency_key is null
    or length(requested_idempotency_key) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  stage := 'resolve_caller';
  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if caller.identity_role = 'tenant_admin'
    and target_identity_role = 'tenant_owner'
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  stage := 'verify_auth_user';
  if not exists (
    select 1 from auth.users u
    where u.id = target_auth_user_id
      and lower(u.email) = normalized_email
      and u.deleted_at is null
      and u.email_confirmed_at is not null
  )
    or exists (
      select 1 from app_private.supabase_auth_principal_links l
      where l.auth_user_id = target_auth_user_id
    )
  then
    return jsonb_build_object('ok', false, 'code', 'auth_user_unavailable');
  end if;

  target_tenant_id := caller.tenant_id;
  target_principal_id := 'supabase-auth:' || target_auth_user_id::text;
  target_membership_id :=
    'supabase-auth-' || replace(target_identity_role, '_', '-') || ':' ||
    target_auth_user_id::text;
  legacy_role := case target_identity_role
    when 'tenant_owner' then 'owner'
    when 'tenant_admin' then 'client_admin'
    when 'creator' then 'client_viewer'
    when 'teacher' then 'client_viewer'
    else 'student'
  end;

  stage := 'identity_principal';
  insert into public.identity_principals (
    principal_id, principal_kind, authentication_method, issuer, subject,
    idempotency_key
  ) values (
    target_principal_id, 'human', 'host_signed', 'supabase-auth',
    target_auth_user_id::text, requested_idempotency_key || ':principal'
  );

  stage := 'auth_link';
  insert into app_private.supabase_auth_principal_links (
    auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
  ) values (
    target_auth_user_id, target_principal_id, target_tenant_id,
    requested_idempotency_key || ':link'
  );

  stage := 'identity_membership';
  insert into public.identity_memberships (
    membership_id, tenant_id, principal_id, role, status, provisioned_by,
    idempotency_key
  ) values (
    target_membership_id, target_tenant_id, target_principal_id,
    target_identity_role, 'active', 'manual',
    requested_idempotency_key || ':membership'
  );

  stage := 'profile';
  insert into public.profiles (
    tenant_id, user_id, display_name, metadata, idempotency_key
  ) values (
    target_tenant_id, target_auth_user_id, btrim(target_display_name),
    jsonb_build_object('managedAccess', true),
    requested_idempotency_key || ':profile'
  );

  stage := 'legacy_membership';
  insert into public.memberships (
    tenant_id, user_id, role_key, status, granted_by, idempotency_key
  ) values (
    target_tenant_id, target_auth_user_id, legacy_role, 'active',
    caller_auth_user_id, requested_idempotency_key || ':legacy-membership'
  );

  stage := 'tenant_selection';
  insert into app_private.supabase_auth_tenant_selections (
    auth_user_id, principal_id, tenant_id, membership_id
  ) values (
    target_auth_user_id, target_principal_id, target_tenant_id,
    target_membership_id
  );

  stage := 'managed_account';
  insert into app_private.user_access_accounts (
    auth_user_id, tenant_id, principal_id, membership_id, email_normalized,
    must_change_password, created_by_principal_id
  ) values (
    target_auth_user_id, target_tenant_id, target_principal_id,
    target_membership_id, normalized_email, true, caller.principal_id
  );

  stage := 'audit';
  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    target_tenant_id, caller.principal_id, 'auth.account.provision',
    'allowed', 'auth_user', target_auth_user_id::text,
    requested_idempotency_key, requested_idempotency_key,
    jsonb_build_object('role', target_identity_role),
    requested_idempotency_key
  );

  return jsonb_build_object(
    'ok', true,
    'authUserId', target_auth_user_id,
    'tenantId', target_tenant_id,
    'role', target_identity_role,
    'mustChangePassword', true
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', false, 'code', 'database_conflict', 'stage', stage
    );
  when foreign_key_violation then
    return jsonb_build_object(
      'ok', false, 'code', 'database_reference_failed', 'stage', stage
    );
  when check_violation then
    return jsonb_build_object(
      'ok', false, 'code', 'database_validation_failed', 'stage', stage
    );
  when others then
    return jsonb_build_object(
      'ok', false, 'code', 'database_provisioning_failed', 'stage', stage,
      'sqlstate', SQLSTATE
    );
end;
$$;

revoke execute on function public.admin_provision_auth_user(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_provision_auth_user(
  uuid, uuid, text, text, text, text
) to service_role;

commit;
