-- With explicit variable precedence enabled, use the durable primary-key
-- constraint name instead of a column-list conflict target. This prevents the
-- local principal_id variable from being parsed as an index expression.

begin;

do $migration$
declare
  function_definition text;
  patched_definition text;
  ambiguous_target text :=
    'on conflict (principal_id) do nothing;';
  constraint_target text :=
    'on conflict on constraint identity_principals_pkey do nothing;';
begin
  select pg_get_functiondef(
    (
      'public.onboarding_accept_invitation(' ||
      'text,text,text,text' ||
      ')'
    )::regprocedure
  )
  into function_definition;

  if function_definition like
      '%on conflict on constraint identity_principals_pkey%' then
    return;
  end if;

  patched_definition := replace(
    function_definition,
    ambiguous_target,
    constraint_target
  );

  if patched_definition = function_definition then
    raise exception
      'Unable to locate onboarding invitation principal conflict target'
      using errcode = '55000';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
