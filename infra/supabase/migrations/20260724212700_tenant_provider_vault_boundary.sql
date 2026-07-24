-- Tenant provider credentials stay encrypted in Supabase Vault.
-- Only service-role Edge Functions may call the RPCs in this migration.

begin;

create table app_private.tenant_provider_credentials (
  tenant_id uuid primary key references public.tenants(tenant_id) on delete cascade,
  provider text not null check (provider in ('openai')),
  vault_secret_id uuid not null,
  key_last4 text not null check (key_last4 ~ '^[[:print:]]{4}$'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  record_version bigint not null default 1 check (record_version > 0),
  created_by_principal_id text references public.identity_principals(principal_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null))
);

alter table app_private.tenant_provider_credentials enable row level security;
revoke all on table app_private.tenant_provider_credentials
  from public, anon, authenticated, service_role;

-- Vault's decrypted view must never be queryable through a public database role.
revoke all on table vault.decrypted_secrets
  from public, anon, authenticated;

create or replace function app_private.set_tenant_provider_credential(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  target_provider text,
  raw_credential text,
  clear_credential boolean,
  request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  existing app_private.tenant_provider_credentials%rowtype;
  secret_id uuid;
  normalized_credential text := btrim(raw_credential);
  normalized_provider text := lower(btrim(target_provider));
  normalized_request_id text := btrim(request_id);
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or normalized_provider <> 'openai'
    or normalized_request_id !~ '^[A-Za-z0-9:_-]{8,200}$'
    or (not clear_credential and normalized_credential !~ '^[[:print:]]{20,500}$')
    or (clear_credential and normalized_credential <> '')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  if not found
    or caller.tenant_id <> target_tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into existing
  from app_private.tenant_provider_credentials c
  where c.tenant_id = target_tenant_id;

  if clear_credential then
    if found then
      update app_private.tenant_provider_credentials
      set
        status = 'revoked',
        revoked_at = now(),
        record_version = existing.record_version + 1,
        updated_at = now()
      where tenant_id = target_tenant_id;
    end if;
    return jsonb_build_object(
      'ok', true,
      'configured', false,
      'vaultReference', null
    );
  end if;

  if found then
    secret_id := existing.vault_secret_id;
    perform vault.update_secret(
      secret_id,
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text || ':provider:' || normalized_provider,
      'Tenant-scoped LearningBot provider credential',
      null::uuid
    );
    update app_private.tenant_provider_credentials
    set
      provider = normalized_provider,
      key_last4 = right(normalized_credential, 4),
      status = 'active',
      record_version = existing.record_version + 1,
      updated_at = now(),
      revoked_at = null,
      created_by_principal_id = caller.principal_id
    where tenant_id = target_tenant_id;
  else
    secret_id := vault.create_secret(
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text || ':provider:' || normalized_provider,
      'Tenant-scoped LearningBot provider credential',
      null::uuid
    );
    insert into app_private.tenant_provider_credentials (
      tenant_id, provider, vault_secret_id, key_last4, status,
      created_by_principal_id
    ) values (
      target_tenant_id, normalized_provider, secret_id,
      right(normalized_credential, 4), 'active', caller.principal_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'configured', true,
    'provider', normalized_provider,
    'keyLast4', right(normalized_credential, 4),
    'vaultReference', 'vault://' || secret_id::text
  );
end;
$$;

revoke execute on function app_private.set_tenant_provider_credential(
  uuid, uuid, text, text, boolean, text
) from public, anon, authenticated, service_role;

create or replace function app_private.tenant_provider_credential_for_runtime(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  requested_provider text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  credential record;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or lower(btrim(requested_provider)) <> 'openai'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  if not found or caller.tenant_id <> target_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select
    c.provider,
    c.key_last4,
    d.decrypted_secret
  into credential
  from app_private.tenant_provider_credentials c
  join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.tenant_id = target_tenant_id
    and c.provider = lower(btrim(requested_provider))
    and c.status = 'active'
    and c.revoked_at is null;

  if not found or credential.decrypted_secret is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_credential_not_configured'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'provider', credential.provider,
    'keyLast4', credential.key_last4,
    'credential', credential.decrypted_secret
  );
end;
$$;

revoke execute on function app_private.tenant_provider_credential_for_runtime(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

-- PostgREST exposes public functions, so these wrappers are the only service-role
-- entry points. Neither wrapper is callable by an authenticated browser session.
create or replace function public.learning_provider_set_credential(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  target_provider text,
  raw_credential text,
  clear_credential boolean,
  request_id text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select app_private.set_tenant_provider_credential(
    caller_auth_user_id,
    target_tenant_id,
    target_provider,
    raw_credential,
    clear_credential,
    request_id
  );
$$;

revoke execute on function public.learning_provider_set_credential(
  uuid, uuid, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.learning_provider_set_credential(
  uuid, uuid, text, text, boolean, text
) to service_role;

create or replace function public.learning_provider_runtime_credential(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  requested_provider text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.tenant_provider_credential_for_runtime(
    caller_auth_user_id,
    target_tenant_id,
    requested_provider
  );
$$;

revoke execute on function public.learning_provider_runtime_credential(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.learning_provider_runtime_credential(
  uuid, uuid, text
) to service_role;

commit;
