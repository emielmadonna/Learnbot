-- Compile the tenant-selection RPC with an explicit PL/pgSQL name-resolution
-- rule. Its table-shaped return value includes tenant_id, which otherwise
-- conflicts with INSERT conflict-target column names at runtime.

begin;

do $migration$
declare
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.auth_select_tenant(uuid,text,text)'::regprocedure
  )
  into function_definition;

  if function_definition like '%#variable_conflict use_column%' then
    return;
  end if;

  patched_definition := replace(
    function_definition,
    E'AS $function$\n',
    E'AS $function$\n#variable_conflict use_column\n'
  );

  if patched_definition = function_definition then
    raise exception
      'Unable to locate auth_select_tenant function body delimiter'
      using errcode = '55000';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
