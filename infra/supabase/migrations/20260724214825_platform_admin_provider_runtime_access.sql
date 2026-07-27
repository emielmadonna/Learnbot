-- Platform administrators may test a selected client workspace without being
-- granted a client membership. This remains a server-only Vault boundary.

begin;

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
  platform_access boolean := false;
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

  select exists (
    select 1
    from app_private.platform_administrators a
    where a.auth_user_id = caller_auth_user_id
      and a.status = 'active'
  ) into platform_access;

  if (not found or caller.tenant_id <> target_tenant_id) and not platform_access then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select c.provider, c.key_last4, d.decrypted_secret
  into credential
  from app_private.tenant_provider_credentials c
  join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.tenant_id = target_tenant_id
    and c.provider = lower(btrim(requested_provider))
    and c.status = 'active'
    and c.revoked_at is null;

  if not found or credential.decrypted_secret is null then
    return jsonb_build_object('ok', false, 'code', 'tenant_credential_not_configured');
  end if;

  return jsonb_build_object(
    'ok', true,
    'provider', credential.provider,
    'keyLast4', credential.key_last4,
    'credential', credential.decrypted_secret
  );
end;
$$;

commit;
