-- Run after migrations 0001..0026.

begin;

do $$
begin
  if has_function_privilege(
    'anon',
    'public.learning_create_upload_intent(uuid,uuid,text,text,bigint,text,timestamptz,jsonb)',
    'execute'
  ) then
    raise exception 'anonymous callers can create upload intents';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.learning_confirm_quarantine_upload(uuid,uuid)',
    'execute'
  ) then
    raise exception 'authenticated authors cannot confirm uploads';
  end if;
  if pg_get_functiondef(
    'public.learning_confirm_quarantine_upload(uuid,uuid)'::regprocedure
  ) not like '%promotionAllowed'', false%' then
    raise exception 'quarantine confirmation can claim promotion';
  end if;
  if pg_get_functiondef(
    'public.learning_confirm_quarantine_upload(uuid,uuid)'::regprocedure
  ) not like '%''malware_scan''%' then
    raise exception 'quarantine confirmation is missing the malware checkpoint';
  end if;
end
$$;

rollback;
