-- Invitation acceptance intentionally uses local variables named like durable
-- identity columns. Compile the function with explicit variable precedence so
-- expression positions resolve to the authenticated workflow state while
-- INSERT target lists and qualified table columns remain unchanged.

begin;

do $migration$
declare
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    (
      'public.onboarding_accept_invitation(' ||
      'text,text,text,text' ||
      ')'
    )::regprocedure
  )
  into function_definition;

  if function_definition like '%#variable_conflict use_variable%' then
    return;
  end if;

  patched_definition := replace(
    function_definition,
    E'AS $function$\n',
    E'AS $function$\n#variable_conflict use_variable\n'
  );

  if patched_definition = function_definition then
    raise exception
      'Unable to locate onboarding_accept_invitation function body delimiter'
      using errcode = '55000';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
