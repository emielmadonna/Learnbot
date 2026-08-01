-- Server-only provider context for anonymous embedded and hosted assistants.
-- The public Edge endpoint still needs the widget key, allowed Origin and the
-- rotating conversation operation token. Only service_role may execute this
-- resolver or receive provider credential material.

begin;

create or replace function public.learning_widget_provider_runtime_credential(
  widget_key text,
  origin text,
  operation_token text,
  requested_provider text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  credential record;
  normalized_provider text := lower(btrim(coalesce(requested_provider, '')));
begin
  if auth.role() <> 'service_role'
    or normalized_provider <> 'openai'
    or not app_private.learning_operation_token_is_valid(
      'conversation.answer.record',
      operation_token
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select
    c.provider,
    c.key_last4,
    d.decrypted_secret
  into credential
  from app_private.tenant_provider_credentials c
  join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.tenant_id = resolved.tenant_id
    and c.provider = normalized_provider
    and c.status = 'active'
    and c.revoked_at is null;

  return jsonb_build_object(
    'ok', true,
    'tenantId', resolved.tenant_id,
    'provider', normalized_provider,
    'credential',
      case when found then credential.decrypted_secret else null end,
    'keyLast4',
      case when found then credential.key_last4 else null end,
    'credentialSource',
      case when found then 'tenant_vault' else 'platform_managed' end
  );
end;
$$;

revoke execute on function public.learning_widget_provider_runtime_credential(
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.learning_widget_provider_runtime_credential(
  text, text, text, text
) to service_role;

commit;
