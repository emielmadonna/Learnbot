-- One-time owner claims let an enterprise workspace and its course data be
-- provisioned before the first verified owner signs in. Only a token hash is
-- stored; claims are single-use, expiring, tenant-bound and audited.

begin;

create table app_private.tenant_owner_claims (
  claim_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(tenant_id),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'revoked', 'expired')),
  expires_at timestamptz not null,
  claimed_by_auth_user_id uuid references auth.users(id),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'claimed'
      and claimed_by_auth_user_id is not null
      and claimed_at is not null)
    or
    (status <> 'claimed'
      and claimed_by_auth_user_id is null
      and claimed_at is null)
  )
);
create index tenant_owner_claims_expiry_idx
  on app_private.tenant_owner_claims (status, expires_at)
  where status = 'pending';

revoke all on table app_private.tenant_owner_claims
  from public, anon, authenticated;
grant select, insert, update on table app_private.tenant_owner_claims
  to service_role;

create or replace function public.auth_claim_preprovisioned_tenant_owner(
  requested_slug text,
  claim_token text,
  request_id text,
  trace_id text
)
returns table (
  tenant_id uuid,
  membership_id text,
  principal_id text,
  selection_version bigint,
  claimed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  target_tenant_id uuid;
  linked_principal_id text;
  new_owner_membership_id text;
  current_selection_version bigint;
  claim_record app_private.tenant_owner_claims%rowtype;
  bootstrap_key text;
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
    or claim_token is null
    or length(claim_token) not between 32 and 256
    or request_id is null
    or length(request_id) not between 1 and 200
    or trace_id is null
    or length(trace_id) not between 1 and 200
  then
    raise invalid_parameter_value using message = 'Invalid owner claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_slug, 8019)
  );
  if exists (
    select 1
    from app_private.supabase_auth_principal_links l
    where l.auth_user_id = caller_id
  ) then
    raise object_not_in_prerequisite_state
      using message = 'Auth user is already linked to a principal';
  end if;

  select t.tenant_id
  into target_tenant_id
  from public.tenants t
  where t.slug = requested_slug
    and t.status in ('provisioning', 'active')
    and t.deleted_at is null;
  if target_tenant_id is null then
    raise insufficient_privilege using message = 'Owner claim is invalid';
  end if;

  select c.*
  into claim_record
  from app_private.tenant_owner_claims c
  where c.tenant_id = target_tenant_id
  for update;
  if not found
    or claim_record.status <> 'pending'
    or claim_record.expires_at <= clock_timestamp()
    or claim_record.token_sha256 <> encode(
      extensions.digest(claim_token, 'sha256'),
      'hex'
    )
  then
    raise insufficient_privilege using message = 'Owner claim is invalid';
  end if;
  if exists (
    select 1
    from public.identity_memberships m
    where m.tenant_id = target_tenant_id
      and m.role = 'tenant_owner'
      and m.status = 'active'
      and m.deleted_at is null
  ) then
    raise object_not_in_prerequisite_state
      using message = 'Tenant already has an active owner';
  end if;

  bootstrap_key :=
    'owner-claim:' ||
    encode(
      extensions.digest(
        target_tenant_id::text || chr(31) || caller_id::text || chr(31) ||
        request_id,
        'sha256'
      ),
      'hex'
    );
  linked_principal_id := 'supabase-auth:' || caller_id::text;
  new_owner_membership_id := 'supabase-auth-owner:' || caller_id::text;

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
    target_tenant_id,
    bootstrap_key || ':link'
  );
  insert into public.identity_memberships (
    membership_id, tenant_id, principal_id, role, status, provisioned_by,
    idempotency_key
  ) values (
    new_owner_membership_id,
    target_tenant_id,
    linked_principal_id,
    'tenant_owner',
    'active',
    'host',
    bootstrap_key || ':identity-membership'
  );
  insert into public.profiles (
    tenant_id, user_id, display_name, idempotency_key
  ) values (
    target_tenant_id,
    caller_id,
    'Workspace owner',
    bootstrap_key || ':profile'
  );
  insert into public.memberships (
    tenant_id, user_id, role_key, status, idempotency_key
  ) values (
    target_tenant_id,
    caller_id,
    'owner',
    'active',
    bootstrap_key || ':legacy-membership'
  );

  update public.onboarding_workspaces
  set owner_membership_id = new_owner_membership_id
  where public.onboarding_workspaces.tenant_id = target_tenant_id
    and public.onboarding_workspaces.deleted_at is null;
  if not found then
    raise object_not_in_prerequisite_state
      using message = 'Preprovisioned onboarding is missing';
  end if;

  insert into app_private.supabase_auth_tenant_selections (
    auth_user_id, principal_id, tenant_id, membership_id
  ) values (
    caller_id, linked_principal_id, target_tenant_id, new_owner_membership_id
  )
  returning
    app_private.supabase_auth_tenant_selections.selection_version
  into current_selection_version;

  update app_private.tenant_owner_claims
  set status = 'claimed',
      claimed_by_auth_user_id = caller_id,
      claimed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where claim_id = claim_record.claim_id
    and status = 'pending';
  if not found then
    raise serialization_failure using message = 'Owner claim was already used';
  end if;

  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    target_tenant_id,
    linked_principal_id,
    'auth.tenant_owner.claim',
    'allowed',
    'tenant',
    target_tenant_id::text,
    request_id,
    trace_id,
    jsonb_build_object('auth_binding', 'supabase-auth-owner-claim'),
    bootstrap_key || ':audit'
  );

  tenant_id := target_tenant_id;
  membership_id := new_owner_membership_id;
  principal_id := linked_principal_id;
  selection_version := current_selection_version;
  claimed := true;
  return next;
end;
$$;

revoke execute on function public.auth_claim_preprovisioned_tenant_owner(
  text, text, text, text
) from public, anon, service_role;
grant execute on function public.auth_claim_preprovisioned_tenant_owner(
  text, text, text, text
) to authenticated;

commit;
