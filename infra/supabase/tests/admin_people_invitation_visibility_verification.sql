-- Catalog-level verification for the tenant-scoped People read model.
-- Run after all migrations. The transaction leaves no durable test state.

begin;

do $$
declare
  function_source text;
begin
  if not has_function_privilege(
    'authenticated',
    'public.admin_list_access_accounts()',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.admin_list_access_accounts()',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.admin_list_access_accounts()',
    'EXECUTE'
  ) then
    raise exception 'People read-model grants are not least-privilege';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.admin_list_access_accounts()'::regprocedure
  ) into function_source;

  if position('app_private.learning_rpc_context()' in function_source) = 0
    or position(
      'caller.identity_role not in (''tenant_owner'', ''tenant_admin'')'
      in function_source
    ) = 0
    or position('m.tenant_id = caller.tenant_id' in function_source) = 0
    or position('d.tenant_id = caller.tenant_id' in function_source) = 0
    or position('i.status = ''pending''' in function_source) = 0
    or position('i.expires_at > clock_timestamp()' in function_source) = 0
  then
    raise exception 'People read model is not role-gated and tenant-bound';
  end if;

  if position('provider_error_code' in function_source) > 0
    or position('provider_error_message' in function_source) > 0
    or position('''invitationId''' in function_source) > 0
  then
    raise exception 'People read model exposes invitation-provider internals';
  end if;
end;
$$;

rollback;
