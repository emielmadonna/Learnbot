-- Server-sent Supabase Auth invitations with a durable, auditable delivery
-- lifecycle. Platform administrators are authorized independently of tenant
-- membership; tenant owners and administrators remain tenant-scoped.

begin;

create table app_private.auth_invitation_deliveries (
  delivery_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  invitation_id text not null,
  email_normalized text not null
    check (
      email_normalized = lower(btrim(email_normalized))
      and length(email_normalized) between 3 and 320
    ),
  display_name text not null check (length(btrim(display_name)) between 1 and 160),
  role text not null check (role in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher', 'student'
  )),
  provider text not null default 'supabase_auth'
    check (provider = 'supabase_auth'),
  status text not null default 'prepared'
    check (status in (
      'prepared', 'provider_sending', 'provider_created', 'sent',
      'provider_failed', 'provisioning_failed', 'accepted', 'expired',
      'revoked'
    )),
  provider_auth_user_id uuid references auth.users(id) on delete set null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_error_code text
    check (provider_error_code is null or length(provider_error_code) <= 160),
  provider_error_message text
    check (provider_error_message is null or length(provider_error_message) <= 500),
  initiated_by_auth_user_id uuid references auth.users(id) on delete set null,
  initiated_by_principal_id text
    check (
      initiated_by_principal_id is null
      or length(initiated_by_principal_id) between 1 and 512
    ),
  provider_attempt_count integer not null default 0
    check (provider_attempt_count >= 0),
  attempted_at timestamptz,
  provider_recorded_at timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  idempotency_key text not null unique
    check (length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (tenant_id, invitation_id)
    references public.identity_invitations(tenant_id, invitation_id),
  -- Auth user deletion intentionally clears provider_auth_user_id. Durable
  -- delivery/audit facts must never make Auth offboarding impossible.
  check (
    (status in ('sent', 'accepted') and sent_at is not null)
    or status not in ('sent', 'accepted')
  ),
  check ((status = 'accepted' and accepted_at is not null) or status <> 'accepted')
);

create index auth_invitation_deliveries_tenant_idx
  on app_private.auth_invitation_deliveries (tenant_id, created_at desc);
create index auth_invitation_deliveries_auth_user_idx
  on app_private.auth_invitation_deliveries (provider_auth_user_id)
  where provider_auth_user_id is not null;

create table app_private.auth_invitation_delivery_events (
  event_id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null
    references app_private.auth_invitation_deliveries(delivery_id),
  tenant_id uuid not null references public.tenants(tenant_id),
  status text not null check (status in (
    'prepared', 'provider_sending', 'provider_created', 'sent',
    'provider_failed', 'provisioning_failed', 'accepted', 'expired',
    'revoked'
  )),
  provider_error_code text
    check (provider_error_code is null or length(provider_error_code) <= 160),
  provider_error_message text
    check (provider_error_message is null or length(provider_error_message) <= 500),
  -- Immutable audit rows retain the actor UUID as a historical snapshot.
  -- A foreign key would make Auth deletion invoke an UPDATE that the
  -- append-only trigger correctly rejects.
  actor_auth_user_id uuid,
  occurred_at timestamptz not null default clock_timestamp()
);

create trigger auth_invitation_delivery_events_reject_update
before update on app_private.auth_invitation_delivery_events
for each row execute function app_private.reject_mutation();
create trigger auth_invitation_delivery_events_reject_delete
before delete on app_private.auth_invitation_delivery_events
for each row execute function app_private.reject_mutation();

alter table app_private.auth_invitation_deliveries enable row level security;
alter table app_private.auth_invitation_deliveries force row level security;
alter table app_private.auth_invitation_delivery_events enable row level security;
alter table app_private.auth_invitation_delivery_events force row level security;

create policy auth_invitation_deliveries_deny_authenticated
  on app_private.auth_invitation_deliveries
  for all to authenticated using (false) with check (false);
create policy auth_invitation_delivery_events_deny_authenticated
  on app_private.auth_invitation_delivery_events
  for all to authenticated using (false) with check (false);

revoke all on table
  app_private.auth_invitation_deliveries,
  app_private.auth_invitation_delivery_events
from public, anon, authenticated;
grant select, insert, update on table app_private.auth_invitation_deliveries
  to service_role;
grant select, insert on table app_private.auth_invitation_delivery_events
  to service_role;

create or replace function public.admin_prepare_auth_invitation(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
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
  caller_principal_id text;
  caller_is_platform boolean := false;
  caller_has_tenant_context boolean := false;
  normalized_email text := lower(btrim(target_email));
  normalized_name text := btrim(target_display_name);
  normalized_request text := btrim(coalesce(requested_idempotency_key, ''));
  request_fingerprint text;
  invitation_identifier text;
  delivery app_private.auth_invitation_deliveries%rowtype;
  prior_delivery app_private.auth_invitation_deliveries%rowtype;
  terminal_status text;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(normalized_name) not between 1 and 160
    or target_identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher', 'student'
    )
    or normalized_request !~ '^[A-Za-z0-9:_-]{8,200}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if not exists (
    select 1
    from auth.users u
    where u.id = caller_auth_user_id
      and u.deleted_at is null
      and coalesce(u.email_confirmed_at, u.phone_confirmed_at) is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  caller_is_platform := exists (
    select 1
    from app_private.platform_administrators a
    where a.auth_user_id = caller_auth_user_id
      and a.status = 'active'
  );
  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  caller_has_tenant_context := found;
  select l.principal_id into caller_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_auth_user_id;

  if not caller_is_platform then
    if not caller_has_tenant_context
      or caller.tenant_id <> target_tenant_id
      or caller.identity_role not in ('tenant_owner', 'tenant_admin')
      or (
        caller.identity_role = 'tenant_admin'
        and target_identity_role = 'tenant_owner'
      )
    then
      return jsonb_build_object('ok', false, 'code', 'access_denied');
    end if;
  end if;

  if caller_is_platform
    and target_identity_role = 'tenant_owner'
    and exists (
      select 1
      from auth.users u
      where u.id = caller_auth_user_id
        and lower(u.email) = normalized_email
    )
  then
    return jsonb_build_object(
      'ok', false, 'code', 'owner_identity_conflict'
    );
  end if;

  if not exists (
    select 1
    from public.tenants t
    where t.tenant_id = target_tenant_id
      and t.status in ('provisioning', 'active')
      and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(normalized_request, 20260731)
  );

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        caller_auth_user_id::text,
        target_tenant_id::text,
        normalized_email,
        normalized_name,
        target_identity_role
      ),
      'sha256'
    ),
    'hex'
  );

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.idempotency_key = normalized_request
  for update;
  if found then
    if delivery.request_fingerprint <> request_fingerprint then
      return jsonb_build_object(
        'ok', false, 'code', 'idempotency_conflict'
      );
    end if;

    if delivery.status not in ('accepted', 'expired', 'revoked')
      and exists (
        select 1
        from public.identity_invitations i
        where i.tenant_id = delivery.tenant_id
          and i.invitation_id = delivery.invitation_id
          and i.status = 'pending'
          and i.expires_at <= clock_timestamp()
      )
    then
      update public.identity_invitations i
      set status = 'expired',
          record_version = i.record_version + 1,
          updated_at = clock_timestamp()
      where i.tenant_id = delivery.tenant_id
        and i.invitation_id = delivery.invitation_id
        and i.status = 'pending';
      update app_private.auth_invitation_deliveries d
      set status = 'expired', updated_at = clock_timestamp()
      where d.delivery_id = delivery.delivery_id
      returning * into delivery;
      insert into app_private.auth_invitation_delivery_events (
        delivery_id, tenant_id, status, actor_auth_user_id
      ) values (
        delivery.delivery_id, delivery.tenant_id, 'expired',
        caller_auth_user_id
      );
    end if;

    return jsonb_build_object(
      'ok', true,
      'deliveryId', delivery.delivery_id,
      'invitationId', delivery.invitation_id,
      'tenantId', delivery.tenant_id,
      'email', delivery.email_normalized,
      'displayName', delivery.display_name,
      'role', delivery.role,
      'status', delivery.status,
      'providerAuthUserId', delivery.provider_auth_user_id,
      'idempotentReplay', true
    );
  end if;

  if exists (
    select 1
    from app_private.user_access_accounts a
    where a.email_normalized = normalized_email
  ) then
    return jsonb_build_object('ok', false, 'code', 'account_exists');
  end if;

  -- A new key for the same tenant/email is an explicit resend. Retire every
  -- earlier unaccepted delivery before creating a fresh provider token. No
  -- membership exists yet, so this is safe even after a previous link expired.
  for prior_delivery in
    select d.*
    from app_private.auth_invitation_deliveries d
    where d.tenant_id = target_tenant_id
      and d.email_normalized = normalized_email
      and d.status not in ('accepted', 'expired', 'revoked')
    for update
  loop
    select case
      when i.expires_at <= clock_timestamp() then 'expired'
      else 'revoked'
    end
    into terminal_status
    from public.identity_invitations i
    where i.tenant_id = prior_delivery.tenant_id
      and i.invitation_id = prior_delivery.invitation_id;

    terminal_status := coalesce(terminal_status, 'revoked');
    update public.identity_invitations i
    set status = terminal_status,
        record_version = i.record_version + 1,
        updated_at = clock_timestamp()
    where i.tenant_id = prior_delivery.tenant_id
      and i.invitation_id = prior_delivery.invitation_id
      and i.status = 'pending';
    update app_private.auth_invitation_deliveries d
    set status = terminal_status, updated_at = clock_timestamp()
    where d.delivery_id = prior_delivery.delivery_id;
    insert into app_private.auth_invitation_delivery_events (
      delivery_id, tenant_id, status, actor_auth_user_id
    ) values (
      prior_delivery.delivery_id, prior_delivery.tenant_id, terminal_status,
      caller_auth_user_id
    );
  end loop;

  invitation_identifier := 'auth-invite:' || gen_random_uuid()::text;
  insert into public.identity_invitations (
    invitation_id, tenant_id, email_normalized, role, status, expires_at,
    idempotency_key
  ) values (
    invitation_identifier,
    target_tenant_id,
    normalized_email,
    target_identity_role,
    'pending',
    clock_timestamp() + interval '1 hour',
    normalized_request || ':identity-invitation'
  );

  insert into app_private.auth_invitation_deliveries (
    tenant_id, invitation_id, email_normalized, display_name, role,
    request_fingerprint, initiated_by_auth_user_id,
    initiated_by_principal_id, idempotency_key
  ) values (
    target_tenant_id,
    invitation_identifier,
    normalized_email,
    normalized_name,
    target_identity_role,
    request_fingerprint,
    caller_auth_user_id,
    caller_principal_id,
    normalized_request
  )
  returning * into delivery;

  insert into app_private.auth_invitation_delivery_events (
    delivery_id, tenant_id, status, actor_auth_user_id
  ) values (
    delivery.delivery_id, target_tenant_id, 'prepared', caller_auth_user_id
  );

  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    target_tenant_id,
    caller_principal_id,
    'auth.invitation.prepare',
    'allowed',
    'identity_invitation',
    invitation_identifier,
    normalized_request,
    normalized_request,
    jsonb_build_object(
      'role', target_identity_role,
      'provider', 'supabase_auth',
      'platformAuthorized', caller_is_platform
    ),
    normalized_request || ':audit'
  );

  return jsonb_build_object(
    'ok', true,
    'deliveryId', delivery.delivery_id,
    'invitationId', invitation_identifier,
    'tenantId', target_tenant_id,
    'email', normalized_email,
    'displayName', normalized_name,
    'role', target_identity_role,
    'status', 'prepared',
    'idempotentReplay', false
  );
end;
$$;

create or replace function public.admin_begin_auth_invitation_provider_attempt(
  caller_auth_user_id uuid,
  target_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  delivery app_private.auth_invitation_deliveries%rowtype;
  caller record;
  caller_is_platform boolean := false;
  caller_has_tenant_context boolean := false;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_delivery_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.delivery_id = target_delivery_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  end if;
  if delivery.initiated_by_auth_user_id is distinct from caller_auth_user_id then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  caller_is_platform := exists (
    select 1
    from app_private.platform_administrators a
    where a.auth_user_id = caller_auth_user_id
      and a.status = 'active'
  );
  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  caller_has_tenant_context := found;
  if not caller_is_platform and (
    not caller_has_tenant_context
    or caller.tenant_id <> delivery.tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
    or (
      caller.identity_role = 'tenant_admin'
      and delivery.role = 'tenant_owner'
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if delivery.status = 'accepted' then
    return jsonb_build_object(
      'ok', true, 'status', 'accepted',
      'providerAuthUserId', delivery.provider_auth_user_id
    );
  end if;
  if delivery.status in ('expired', 'revoked') then
    return jsonb_build_object(
      'ok', false, 'code', 'invitation_' || delivery.status
    );
  end if;
  if exists (
    select 1
    from public.identity_invitations i
    where i.tenant_id = delivery.tenant_id
      and i.invitation_id = delivery.invitation_id
      and (
        i.status in ('expired', 'revoked')
        or (i.status = 'pending' and i.expires_at <= clock_timestamp())
      )
  ) then
    update public.identity_invitations i
    set status = case
          when i.status = 'pending' then 'expired'
          else i.status
        end,
        record_version = case
          when i.status = 'pending' then i.record_version + 1
          else i.record_version
        end,
        updated_at = clock_timestamp()
    where i.tenant_id = delivery.tenant_id
      and i.invitation_id = delivery.invitation_id;
    update app_private.auth_invitation_deliveries d
    set status = 'expired', updated_at = clock_timestamp()
    where d.delivery_id = delivery.delivery_id;
    insert into app_private.auth_invitation_delivery_events (
      delivery_id, tenant_id, status, actor_auth_user_id
    ) values (
      delivery.delivery_id, delivery.tenant_id, 'expired',
      caller_auth_user_id
    );
    return jsonb_build_object(
      'ok', false, 'code', 'invitation_expired'
    );
  end if;

  if delivery.status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'status', 'sent',
      'providerAuthUserId', delivery.provider_auth_user_id,
      'idempotentReplay', true
    );
  end if;
  if delivery.status = 'provider_created' then
    return jsonb_build_object(
      'ok', true,
      'status', 'provider_created',
      'providerAuthUserId', delivery.provider_auth_user_id,
      'idempotentReplay', true
    );
  end if;
  if delivery.status not in (
    'prepared', 'provider_sending', 'provider_failed', 'provisioning_failed'
  ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;

  update app_private.auth_invitation_deliveries d
  set status = case
        when d.provider_auth_user_id is not null then 'provider_created'
        else 'provider_sending'
      end,
      provider_attempt_count = d.provider_attempt_count + 1,
      provider_error_code = null,
      provider_error_message = null,
      attempted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where d.delivery_id = delivery.delivery_id
  returning * into delivery;

  insert into app_private.auth_invitation_delivery_events (
    delivery_id, tenant_id, status, actor_auth_user_id
  ) values (
    delivery.delivery_id, delivery.tenant_id, delivery.status,
    caller_auth_user_id
  );

  return jsonb_build_object(
    'ok', true,
    'deliveryId', delivery.delivery_id,
    'invitationId', delivery.invitation_id,
    'tenantId', delivery.tenant_id,
    'email', delivery.email_normalized,
    'displayName', delivery.display_name,
    'role', delivery.role,
    'status', delivery.status,
    'providerAuthUserId', delivery.provider_auth_user_id,
    'attemptCount', delivery.provider_attempt_count
  );
end;
$$;

create or replace function public.admin_resolve_auth_invitation_provider_user(
  caller_auth_user_id uuid,
  target_delivery_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  delivery app_private.auth_invitation_deliveries%rowtype;
  candidate record;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_delivery_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.delivery_id = target_delivery_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  end if;
  if delivery.initiated_by_auth_user_id is distinct from caller_auth_user_id
    or delivery.status <> 'provider_sending'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;

  select
    u.id,
    u.email_confirmed_at is not null as email_confirmed
  into candidate
  from auth.users u
  where lower(u.email) = delivery.email_normalized
    and u.deleted_at is null
    and not exists (
      select 1
      from app_private.supabase_auth_principal_links l
      where l.auth_user_id = u.id
    )
    and not exists (
      select 1
      from app_private.user_access_accounts a
      where a.auth_user_id = u.id
    )
  order by
    (
      u.raw_user_meta_data ->> 'invitation_id' = delivery.invitation_id
    ) desc,
    u.created_at desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'found', found,
    'authUserId', case when found then candidate.id else null end,
    'emailConfirmed',
      case when found then candidate.email_confirmed else false end
  );
end;
$$;

create or replace function public.admin_record_auth_invitation_provider_user(
  caller_auth_user_id uuid,
  target_delivery_id uuid,
  target_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  delivery app_private.auth_invitation_deliveries%rowtype;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_delivery_id is null
    or target_auth_user_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.delivery_id = target_delivery_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  end if;
  if delivery.initiated_by_auth_user_id is distinct from caller_auth_user_id then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if delivery.status = 'provider_created'
    and delivery.provider_auth_user_id = target_auth_user_id
  then
    return jsonb_build_object(
      'ok', true, 'status', 'provider_created', 'idempotentReplay', true
    );
  end if;
  if delivery.status <> 'provider_sending' then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = target_auth_user_id
      and lower(u.email) = delivery.email_normalized
      and u.deleted_at is null
  )
    or exists (
      select 1
      from app_private.supabase_auth_principal_links l
      where l.auth_user_id = target_auth_user_id
    )
    or exists (
      select 1
      from app_private.user_access_accounts a
      where a.auth_user_id = target_auth_user_id
    )
  then
    return jsonb_build_object('ok', false, 'code', 'auth_user_unavailable');
  end if;

  update app_private.auth_invitation_deliveries d
  set status = 'provider_created',
      provider_auth_user_id = target_auth_user_id,
      provider_recorded_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where d.delivery_id = delivery.delivery_id;
  insert into app_private.auth_invitation_delivery_events (
    delivery_id, tenant_id, status, actor_auth_user_id
  ) values (
    delivery.delivery_id, delivery.tenant_id, 'provider_created',
    caller_auth_user_id
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'provider_created',
    'authUserId', target_auth_user_id,
    'idempotentReplay', false
  );
end;
$$;

create or replace function public.admin_record_auth_invitation_failure(
  target_delivery_id uuid,
  target_status text,
  target_error_code text,
  target_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  delivery app_private.auth_invitation_deliveries%rowtype;
  safe_code text := left(nullif(btrim(coalesce(target_error_code, '')), ''), 160);
  safe_message text := left(nullif(btrim(coalesce(target_error_message, '')), ''), 500);
begin
  if auth.role() <> 'service_role'
    or target_delivery_id is null
    or target_status not in ('provider_failed', 'provisioning_failed')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.delivery_id = target_delivery_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  end if;
  if delivery.status = target_status then
    return jsonb_build_object(
      'ok', true, 'deliveryId', delivery.delivery_id,
      'status', target_status, 'idempotentReplay', true
    );
  end if;
  if delivery.status not in (
    'prepared', 'provider_sending', 'provider_created'
  ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;
  if target_status = 'provisioning_failed'
    and delivery.provider_auth_user_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;

  update app_private.auth_invitation_deliveries d
  set status = target_status,
      provider_error_code = safe_code,
      provider_error_message = safe_message,
      attempted_at = coalesce(d.attempted_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where d.delivery_id = target_delivery_id
  returning * into delivery;

  insert into app_private.auth_invitation_delivery_events (
    delivery_id, tenant_id, status, provider_error_code, provider_error_message,
    actor_auth_user_id
  ) values (
    delivery.delivery_id,
    delivery.tenant_id,
    target_status,
    safe_code,
    safe_message,
    delivery.initiated_by_auth_user_id
  );
  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    delivery.tenant_id,
    delivery.initiated_by_principal_id,
    'auth.invitation.failure',
    'denied',
    'identity_invitation',
    delivery.invitation_id,
    delivery.idempotency_key,
    delivery.idempotency_key,
    jsonb_strip_nulls(jsonb_build_object(
      'deliveryStatus', target_status,
      'providerErrorCode', safe_code
    )),
    delivery.idempotency_key || ':failure-audit:' || target_status
  ) on conflict (tenant_id, idempotency_key) do nothing;

  return jsonb_build_object(
    'ok', true,
    'deliveryId', delivery.delivery_id,
    'status', target_status,
    'resumable', true
  );
end;
$$;

create or replace function public.admin_revoke_auth_invitation(
  caller_auth_user_id uuid,
  target_delivery_id uuid,
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  delivery app_private.auth_invitation_deliveries%rowtype;
  caller record;
  caller_principal_id text;
  caller_is_platform boolean := false;
  caller_has_tenant_context boolean := false;
  normalized_request text := btrim(coalesce(requested_idempotency_key, ''));
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_delivery_id is null
    or normalized_request !~ '^[A-Za-z0-9:_-]{8,200}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.delivery_id = target_delivery_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  end if;
  if delivery.status = 'accepted' then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;
  if delivery.status = 'revoked' then
    return jsonb_build_object(
      'ok', true, 'status', 'revoked', 'idempotentReplay', true
    );
  end if;

  caller_is_platform := exists (
    select 1
    from app_private.platform_administrators a
    where a.auth_user_id = caller_auth_user_id
      and a.status = 'active'
  );
  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  caller_has_tenant_context := found;
  select l.principal_id into caller_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_auth_user_id;
  if not caller_is_platform and (
    not caller_has_tenant_context
    or caller.tenant_id <> delivery.tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
    or (
      caller.identity_role = 'tenant_admin'
      and delivery.role = 'tenant_owner'
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  update public.identity_invitations i
  set status = 'revoked',
      record_version = i.record_version + 1,
      updated_at = clock_timestamp()
  where i.tenant_id = delivery.tenant_id
    and i.invitation_id = delivery.invitation_id
    and i.status = 'pending';
  update app_private.auth_invitation_deliveries d
  set status = 'revoked', updated_at = clock_timestamp()
  where d.delivery_id = delivery.delivery_id;
  insert into app_private.auth_invitation_delivery_events (
    delivery_id, tenant_id, status, actor_auth_user_id
  ) values (
    delivery.delivery_id, delivery.tenant_id, 'revoked',
    caller_auth_user_id
  );
  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    delivery.tenant_id,
    caller_principal_id,
    'auth.invitation.revoke',
    'allowed',
    'identity_invitation',
    delivery.invitation_id,
    normalized_request,
    normalized_request,
    jsonb_build_object('platformAuthorized', caller_is_platform),
    normalized_request
  ) on conflict (tenant_id, idempotency_key) do nothing;

  return jsonb_build_object(
    'ok', true, 'deliveryId', delivery.delivery_id, 'status', 'revoked'
  );
end;
$$;

-- Provider completion records confirmed email delivery only. Tenant
-- principals, memberships, selections, and owner claims are created later in
-- auth_complete_password_change, after the recipient proves control of email.
create or replace function public.admin_complete_auth_invitation(
  caller_auth_user_id uuid,
  target_delivery_id uuid,
  target_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  delivery app_private.auth_invitation_deliveries%rowtype;
  caller record;
  caller_principal_id text;
  caller_is_platform boolean := false;
  caller_has_tenant_context boolean := false;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_delivery_id is null
    or target_auth_user_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.delivery_id = target_delivery_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_not_found');
  end if;
  if delivery.initiated_by_auth_user_id is distinct from caller_auth_user_id then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if delivery.status = 'accepted'
    and delivery.provider_auth_user_id = target_auth_user_id
  then
    return jsonb_build_object(
      'ok', true,
      'authUserId', target_auth_user_id,
      'tenantId', delivery.tenant_id,
      'role', delivery.role,
      'deliveryStatus', 'accepted',
      'idempotentReplay', true
    );
  end if;
  if delivery.status = 'sent'
    and delivery.provider_auth_user_id = target_auth_user_id
  then
    return jsonb_build_object(
      'ok', true,
      'authUserId', target_auth_user_id,
      'tenantId', delivery.tenant_id,
      'role', delivery.role,
      'deliveryStatus', 'sent',
      'idempotentReplay', true
    );
  end if;
  if delivery.status <> 'provider_created'
    or delivery.provider_auth_user_id is distinct from target_auth_user_id
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;

  caller_is_platform := exists (
    select 1
    from app_private.platform_administrators a
    where a.auth_user_id = caller_auth_user_id
      and a.status = 'active'
  );
  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  caller_has_tenant_context := found;
  select l.principal_id into caller_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_auth_user_id;
  if not caller_is_platform and (
    not caller_has_tenant_context
    or caller.tenant_id <> delivery.tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
    or (
      caller.identity_role = 'tenant_admin'
      and delivery.role = 'tenant_owner'
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if not exists (
    select 1
    from auth.users u
    where u.id = target_auth_user_id
      and lower(u.email) = delivery.email_normalized
      and u.deleted_at is null
  )
    or exists (
      select 1
      from app_private.supabase_auth_principal_links l
      where l.auth_user_id = target_auth_user_id
    )
    or exists (
      select 1
      from app_private.user_access_accounts a
      where a.auth_user_id = target_auth_user_id
    )
  then
    return jsonb_build_object('ok', false, 'code', 'auth_user_unavailable');
  end if;

  update public.identity_invitations i
  set expires_at = clock_timestamp() + interval '1 hour',
      record_version = i.record_version + 1,
      updated_at = clock_timestamp()
  where i.tenant_id = delivery.tenant_id
    and i.invitation_id = delivery.invitation_id
    and i.status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_state');
  end if;

  update app_private.auth_invitation_deliveries d
  set status = 'sent',
      sent_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where d.delivery_id = delivery.delivery_id;
  insert into app_private.auth_invitation_delivery_events (
    delivery_id, tenant_id, status, actor_auth_user_id
  ) values (
    delivery.delivery_id, delivery.tenant_id, 'sent', caller_auth_user_id
  );
  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    delivery.tenant_id,
    caller_principal_id,
    'auth.invitation.sent',
    'allowed',
    'identity_invitation',
    delivery.invitation_id,
    delivery.idempotency_key,
    delivery.idempotency_key,
    jsonb_build_object(
      'role', delivery.role,
      'provider', delivery.provider,
      'platformAuthorized', caller_is_platform,
      'privilegeActivated', false
    ),
    delivery.idempotency_key || ':sent-audit'
  ) on conflict (tenant_id, idempotency_key) do nothing;

  return jsonb_build_object(
    'ok', true,
    'authUserId', target_auth_user_id,
    'tenantId', delivery.tenant_id,
    'role', delivery.role,
    'deliveryStatus', 'sent',
    'idempotentReplay', false
  );
end;
$$;

-- Pending invited users must see the password-completion screen, but this
-- state is deliberately separate from active access_account_context and does
-- not create a tenant context or authorize any tenant row.
create or replace function public.auth_current_access_state()
returns table (
  managed boolean,
  must_change_password boolean,
  email_normalized text,
  identity_role text,
  credential_version bigint
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with active_account as (
    select
      true as managed,
      c.must_change_password,
      c.email_normalized,
      c.identity_role,
      c.credential_version,
      1 as priority
    from app_private.access_account_context(auth.uid()) c
  ),
  pending_invitation as (
    select
      true as managed,
      true as must_change_password,
      d.email_normalized,
      d.role as identity_role,
      null::bigint as credential_version,
      2 as priority
    from app_private.auth_invitation_deliveries d
    join public.identity_invitations i
      on i.tenant_id = d.tenant_id
     and i.invitation_id = d.invitation_id
    where d.provider_auth_user_id = auth.uid()
      and d.status in ('provider_created', 'sent')
      and i.status = 'pending'
      and i.expires_at > statement_timestamp()
    order by coalesce(d.sent_at, d.provider_recorded_at, d.created_at) desc
    limit 1
  ),
  resolved as (
    select * from active_account
    union all
    select * from pending_invitation
    where not exists (select 1 from active_account)
    union all
    select
      false, false, null::text, null::text, null::bigint, 3
    where auth.uid() is not null
      and not exists (select 1 from active_account)
      and not exists (select 1 from pending_invitation)
  )
  select
    r.managed,
    r.must_change_password,
    r.email_normalized,
    r.identity_role,
    r.credential_version
  from resolved r
  order by r.priority
  limit 1;
$$;

create or replace function public.auth_complete_password_change(
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  normalized_request text := btrim(coalesce(requested_idempotency_key, ''));
  account app_private.user_access_accounts%rowtype;
  delivery app_private.auth_invitation_deliveries%rowtype;
  invitation public.identity_invitations%rowtype;
  target_principal_id text;
  target_membership_id text;
  legacy_role text;
  resulting_credential_version bigint;
begin
  if caller_id is null
    or normalized_request !~ '^[A-Za-z0-9:_-]{8,200}$'
  then
    raise insufficient_privilege using message = 'Authenticated user required';
  end if;

  select d.* into delivery
  from app_private.auth_invitation_deliveries d
  where d.provider_auth_user_id = caller_id
    and d.status in ('provider_created', 'sent', 'accepted')
  order by
    case d.status when 'accepted' then 2 else 1 end,
    coalesce(d.sent_at, d.provider_recorded_at, d.created_at) desc
  limit 1
  for update;

  if found then
    if delivery.status = 'accepted' then
      select a.* into account
      from app_private.user_access_accounts a
      where a.auth_user_id = caller_id
      for update;
      if not found then
        return jsonb_build_object('ok', false, 'code', 'account_not_managed');
      end if;
      return jsonb_build_object(
        'ok', true,
        'mustChangePassword', account.must_change_password,
        'credentialVersion', account.credential_version,
        'invitationAccepted', true,
        'idempotentReplay', true
      );
    end if;

    select i.* into invitation
    from public.identity_invitations i
    where i.tenant_id = delivery.tenant_id
      and i.invitation_id = delivery.invitation_id
    for update;
    if not found
      or invitation.status <> 'pending'
    then
      return jsonb_build_object('ok', false, 'code', 'invalid_state');
    end if;
    if invitation.expires_at <= clock_timestamp() then
      update public.identity_invitations i
      set status = 'expired',
          record_version = i.record_version + 1,
          updated_at = clock_timestamp()
      where i.tenant_id = invitation.tenant_id
        and i.invitation_id = invitation.invitation_id
        and i.status = 'pending';
      update app_private.auth_invitation_deliveries d
      set status = 'expired', updated_at = clock_timestamp()
      where d.delivery_id = delivery.delivery_id;
      insert into app_private.auth_invitation_delivery_events (
        delivery_id, tenant_id, status, actor_auth_user_id
      ) values (
        delivery.delivery_id, delivery.tenant_id, 'expired', caller_id
      );
      return jsonb_build_object(
        'ok', false, 'code', 'invitation_expired', 'resendRequired', true
      );
    end if;

    if not exists (
      select 1
      from auth.users u
      where u.id = caller_id
        and lower(u.email) = delivery.email_normalized
        and u.deleted_at is null
        and u.email_confirmed_at is not null
        -- The invite link proves mailbox control, but only a stored Auth
        -- password hash proves the required password step completed.
        and nullif(u.encrypted_password, '') is not null
    )
      or exists (
        select 1
        from app_private.supabase_auth_principal_links l
        where l.auth_user_id = caller_id
      )
      or exists (
        select 1
        from app_private.user_access_accounts a
        where a.auth_user_id = caller_id
      )
    then
      return jsonb_build_object('ok', false, 'code', 'auth_user_unavailable');
    end if;

    target_principal_id := 'supabase-auth:' || caller_id::text;
    target_membership_id :=
      'supabase-auth-' || replace(delivery.role, '_', '-') || ':' ||
      caller_id::text;
    legacy_role := case delivery.role
      when 'tenant_owner' then 'owner'
      when 'tenant_admin' then 'client_admin'
      when 'creator' then 'client_viewer'
      when 'teacher' then 'client_viewer'
      else 'student'
    end;

    insert into public.identity_principals (
      principal_id, principal_kind, authentication_method, issuer, subject,
      idempotency_key
    ) values (
      target_principal_id,
      'human',
      'host_signed',
      'supabase-auth',
      caller_id::text,
      delivery.idempotency_key || ':principal'
    );
    insert into app_private.supabase_auth_principal_links (
      auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
    ) values (
      caller_id,
      target_principal_id,
      delivery.tenant_id,
      delivery.idempotency_key || ':link'
    );
    insert into public.identity_memberships (
      membership_id, tenant_id, principal_id, role, status, provisioned_by,
      idempotency_key
    ) values (
      target_membership_id,
      delivery.tenant_id,
      target_principal_id,
      delivery.role,
      'active',
      'invitation',
      delivery.idempotency_key || ':membership'
    );
    insert into public.profiles (
      tenant_id, user_id, display_name, metadata, idempotency_key
    ) values (
      delivery.tenant_id,
      caller_id,
      delivery.display_name,
      jsonb_build_object('managedAccess', true, 'invited', true),
      delivery.idempotency_key || ':profile'
    );
    insert into public.memberships (
      tenant_id, user_id, role_key, status, granted_by, idempotency_key
    ) values (
      delivery.tenant_id,
      caller_id,
      legacy_role,
      'active',
      delivery.initiated_by_auth_user_id,
      delivery.idempotency_key || ':legacy-membership'
    );
    insert into app_private.supabase_auth_tenant_selections (
      auth_user_id, principal_id, tenant_id, membership_id
    ) values (
      caller_id,
      target_principal_id,
      delivery.tenant_id,
      target_membership_id
    );
    insert into app_private.user_access_accounts (
      auth_user_id, tenant_id, principal_id, membership_id, email_normalized,
      must_change_password, credential_version, created_by_principal_id,
      password_changed_at
    ) values (
      caller_id,
      delivery.tenant_id,
      target_principal_id,
      target_membership_id,
      delivery.email_normalized,
      false,
      1,
      delivery.initiated_by_principal_id,
      clock_timestamp()
    )
    returning * into account;

    update public.identity_invitations i
    set status = 'accepted',
        accepted_by_principal_id = target_principal_id,
        accepted_at = clock_timestamp(),
        record_version = i.record_version + 1,
        updated_at = clock_timestamp()
    where i.tenant_id = delivery.tenant_id
      and i.invitation_id = delivery.invitation_id
      and i.status = 'pending';
    insert into public.identity_invitation_acceptances (
      tenant_id, invitation_id, principal_id, membership_id, idempotency_key
    ) values (
      delivery.tenant_id,
      delivery.invitation_id,
      target_principal_id,
      target_membership_id,
      'auth-invitation-accepted:' || delivery.delivery_id::text
    );
    update app_private.auth_invitation_deliveries d
    set status = 'accepted',
        sent_at = coalesce(d.sent_at, d.provider_recorded_at, clock_timestamp()),
        accepted_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where d.delivery_id = delivery.delivery_id;
    insert into app_private.auth_invitation_delivery_events (
      delivery_id, tenant_id, status, actor_auth_user_id
    ) values (
      delivery.delivery_id, delivery.tenant_id, 'accepted', caller_id
    );

    if delivery.role = 'tenant_owner' then
      update public.onboarding_workspaces
      set owner_membership_id = target_membership_id,
          updated_at = clock_timestamp()
      where tenant_id = delivery.tenant_id
        and deleted_at is null;
      update app_private.tenant_owner_claims
      set status = 'revoked', updated_at = clock_timestamp()
      where tenant_id = delivery.tenant_id
        and status = 'pending';
    end if;

    insert into public.identity_audit_events (
      tenant_id, actor_principal_id, action, outcome, resource_type,
      resource_id, request_id, trace_id, safe_metadata, idempotency_key
    ) values (
      delivery.tenant_id,
      target_principal_id,
      'auth.invitation.accept',
      'allowed',
      'identity_invitation',
      delivery.invitation_id,
      normalized_request,
      normalized_request,
      jsonb_build_object(
        'role', delivery.role,
        'privilegeActivated', true
      ),
      delivery.idempotency_key || ':accept-audit'
    ) on conflict (tenant_id, idempotency_key) do nothing;
    insert into public.identity_audit_events (
      tenant_id, actor_principal_id, action, outcome, resource_type,
      resource_id, request_id, trace_id, safe_metadata, idempotency_key
    ) values (
      delivery.tenant_id,
      target_principal_id,
      'auth.password.change',
      'allowed',
      'auth_user',
      caller_id::text,
      normalized_request,
      normalized_request,
      jsonb_build_object(
        'managedCredential', true,
        'invitationAccepted', true
      ),
      normalized_request
    ) on conflict (tenant_id, idempotency_key) do nothing;

    return jsonb_build_object(
      'ok', true,
      'mustChangePassword', false,
      'credentialVersion', account.credential_version,
      'invitationAccepted', true,
      'idempotentReplay', false
    );
  end if;

  -- Preserve the existing managed-account password rotation behavior for
  -- accounts provisioned before provider-backed invitations.
  select a.* into account
  from app_private.user_access_accounts a
  where a.auth_user_id = caller_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'account_not_managed');
  end if;

  resulting_credential_version := account.credential_version;
  if account.must_change_password then
    update app_private.user_access_accounts a
    set must_change_password = false,
        password_changed_at = clock_timestamp(),
        credential_version = a.credential_version + 1,
        updated_at = clock_timestamp()
    where a.auth_user_id = caller_id
    returning a.credential_version into resulting_credential_version;

    insert into public.identity_audit_events (
      tenant_id, actor_principal_id, action, outcome, resource_type,
      resource_id, request_id, trace_id, safe_metadata, idempotency_key
    ) values (
      account.tenant_id,
      account.principal_id,
      'auth.password.change',
      'allowed',
      'auth_user',
      caller_id::text,
      normalized_request,
      normalized_request,
      jsonb_build_object(
        'managedCredential', true,
        'invitationAccepted', false
      ),
      normalized_request
    ) on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'mustChangePassword', false,
    'credentialVersion', resulting_credential_version,
    'invitationAccepted', false
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'account_exists');
  when others then
    return jsonb_build_object(
      'ok', false, 'code', 'database_error', 'sqlstate', SQLSTATE
    );
end;
$$;

revoke execute on function public.admin_prepare_auth_invitation(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_prepare_auth_invitation(
  uuid, uuid, text, text, text, text
) to service_role;
revoke execute on function
  public.admin_begin_auth_invitation_provider_attempt(uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.admin_begin_auth_invitation_provider_attempt(uuid, uuid)
to service_role;
revoke execute on function
  public.admin_resolve_auth_invitation_provider_user(uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.admin_resolve_auth_invitation_provider_user(uuid, uuid)
to service_role;
revoke execute on function
  public.admin_record_auth_invitation_provider_user(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.admin_record_auth_invitation_provider_user(uuid, uuid, uuid)
to service_role;
revoke execute on function public.admin_record_auth_invitation_failure(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_record_auth_invitation_failure(
  uuid, text, text, text
) to service_role;
revoke execute on function public.admin_revoke_auth_invitation(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.admin_revoke_auth_invitation(
  uuid, uuid, text
) to service_role;
revoke execute on function public.admin_complete_auth_invitation(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.admin_complete_auth_invitation(
  uuid, uuid, uuid
) to service_role;

revoke execute on function public.auth_complete_password_change(text)
  from public, anon, service_role;
grant execute on function public.auth_complete_password_change(text)
  to authenticated;
revoke execute on function public.auth_current_access_state()
  from public, anon, service_role;
grant execute on function public.auth_current_access_state()
  to authenticated;

commit;
