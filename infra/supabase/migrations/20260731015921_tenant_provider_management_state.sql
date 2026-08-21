-- Safe tenant-facing state for the encrypted OpenAI credential boundary.
-- Credential material remains in Vault and is never returned to authenticated
-- browser roles.

begin;

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
  normalized_credential text := btrim(coalesce(raw_credential, ''));
  normalized_provider text := lower(btrim(coalesce(target_provider, '')));
  normalized_request_id text := btrim(coalesce(request_id, ''));
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or normalized_provider <> 'openai'
    or normalized_request_id !~ '^[A-Za-z0-9:_-]{8,200}$'
    or (
      not clear_credential
      and normalized_credential !~ '^[[:print:]]{20,500}$'
    )
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
  where c.tenant_id = target_tenant_id
  for update;

  if clear_credential then
    if found then
      update app_private.tenant_provider_credentials
      set
        status = 'revoked',
        revoked_at = now(),
        record_version = existing.record_version + 1,
        updated_at = now()
      where tenant_id = target_tenant_id;
      delete from vault.secrets s where s.id = existing.vault_secret_id;
      perform app_private.ingestion_append_audit(
        target_tenant_id,
        caller.identity_role,
        'learning.provider.credential.clear',
        existing.vault_secret_id::text,
        normalized_request_id
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'configured', false,
      'vaultReference', null
    );
  end if;

  if found and existing.status = 'active' then
    secret_id := existing.vault_secret_id;
    perform vault.update_secret(
      secret_id,
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text ||
        ':provider:' || normalized_provider,
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
  elsif found then
    -- Older deployments revoked credential rows without deleting the Vault
    -- entry. Remove that exact tenant-owned secret before recreating the same
    -- unique Vault name, preventing both orphan retention and name conflicts.
    delete from vault.secrets s where s.id = existing.vault_secret_id;
    secret_id := vault.create_secret(
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text ||
        ':provider:' || normalized_provider,
      'Tenant-scoped LearningBot provider credential',
      null::uuid
    );
    update app_private.tenant_provider_credentials
    set
      provider = normalized_provider,
      vault_secret_id = secret_id,
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
      'learningbot:tenant:' || target_tenant_id::text ||
        ':provider:' || normalized_provider,
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

  perform app_private.ingestion_append_audit(
    target_tenant_id,
    caller.identity_role,
    'learning.provider.credential.configure',
    secret_id::text,
    normalized_request_id
  );

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

create or replace function public.learning_provider_credential_state()
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
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select c.provider, c.key_last4, c.status, c.updated_at
  into credential
  from app_private.tenant_provider_credentials c
  where c.tenant_id = caller.tenant_id
    and c.provider = 'openai'
    and c.status = 'active'
    and c.revoked_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'provider', 'openai',
    'tenantConfigured', found,
    'credentialSource', case
      when found then 'tenant_vault'
      else 'platform_managed'
    end,
    'keyLast4', case when found then credential.key_last4 else null end,
    'updatedAt', case when found then credential.updated_at else null end
  );
end;
$$;

revoke execute on function public.learning_provider_credential_state()
  from public, anon, service_role;
grant execute on function public.learning_provider_credential_state()
  to authenticated;

commit;
