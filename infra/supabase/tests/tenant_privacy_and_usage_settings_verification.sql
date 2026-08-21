-- Catalog-level verification for tenant privacy/data and plan/usage settings.
-- Run after all migrations. The transaction leaves no durable test state.

begin;

do $$
declare
  policy_rls boolean;
  policy_forced boolean;
  function_source text;
begin
  select c.relrowsecurity, c.relforcerowsecurity
  into policy_rls, policy_forced
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'tenant_data_policies';

  if coalesce(policy_rls, false) is not true
    or coalesce(policy_forced, false) is not true
  then
    raise exception 'tenant_data_policies must enable and force RLS';
  end if;

  if has_table_privilege(
    'authenticated',
    'public.tenant_data_policies',
    'SELECT'
  ) then
    raise exception 'tenant_data_policies must remain RPC-only';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.tenant_get_data_policy()',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.tenant_get_data_policy()',
    'EXECUTE'
  ) then
    raise exception 'tenant_get_data_policy grants are not least-privilege';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.tenant_set_data_policy(integer,boolean,text,bigint)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.tenant_set_data_policy(integer,boolean,text,bigint)',
    'EXECUTE'
  ) then
    raise exception 'tenant_set_data_policy grants are not least-privilege';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.tenant_prepare_data_export(text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.tenant_prepare_data_export(text)',
    'EXECUTE'
  ) then
    raise exception 'tenant_prepare_data_export grants are not least-privilege';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.tenant_prepare_data_export(text)'::regprocedure
  ) into function_source;

  if position('app_private.learning_rpc_context()' in function_source) = 0
    or position(
      'caller.identity_role not in (''tenant_owner'', ''tenant_admin'')'
      in function_source
    ) = 0
    or position('m.tenant_id = caller.tenant_id' in function_source) = 0
    or position('limit 10000' in lower(function_source)) = 0
  then
    raise exception 'tenant export must be role-gated, tenant-bound and bounded';
  end if;

  if position('tenant.data_export.generated' in function_source) = 0
    or position('storage_key' in function_source) > 0
    or position('provider_request_ref' in function_source) > 0
    or position('credential_vault_ref' in function_source) > 0
  then
    raise exception 'tenant export audit or sensitive-field boundary regressed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.tenant_get_billing_summary()'::regprocedure
  ) into function_source;

  if position('monthToDateBilledMicro' in function_source) = 0
    or position('dailyBudgetMicro' in function_source) = 0
    or position('maxCallsPerDay' in function_source) = 0
    or position('windowTrueCostMicro' in function_source) > 0
    or position('marginMultiplier' in function_source) > 0
  then
    raise exception 'tenant plan/usage boundary regressed';
  end if;
end;
$$;

rollback;
