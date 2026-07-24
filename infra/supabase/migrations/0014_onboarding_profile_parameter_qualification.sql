-- Qualify the profile RPC parameter inside the branding INSERT ... SELECT.
-- The lateral branding row also exposes an idempotency_key column, so leaving
-- the parameter unqualified makes the statement ambiguous at runtime.

begin;

do $migration$
declare
  function_definition text;
  patched_definition text;
  ambiguous_expression text :=
    E'caller.tenant_id::text || chr(31) || idempotency_key,\n';
  qualified_expression text :=
    E'caller.tenant_id::text || chr(31) || ' ||
    E'onboarding_update_tenant_profile.idempotency_key,\n';
begin
  select pg_get_functiondef(
    (
      'public.onboarding_update_tenant_profile(' ||
      'text,text,text,text,text,text,text,bigint,text,text,text' ||
      ')'
    )::regprocedure
  )
  into function_definition;

  if function_definition like
      '%onboarding_update_tenant_profile.idempotency_key%' then
    return;
  end if;

  patched_definition := replace(
    function_definition,
    ambiguous_expression,
    qualified_expression
  );

  if patched_definition = function_definition then
    raise exception
      'Unable to locate onboarding profile idempotency expression'
      using errcode = '55000';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
