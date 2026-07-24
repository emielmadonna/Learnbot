-- Run after migrations 0001..0023.

begin;

do $$
declare
  hybrid_definition text;
begin
  select pg_get_functiondef(
    'public.learning_search_chunks_hybrid(text,extensions.vector,uuid,integer)'::regprocedure
  ) into hybrid_definition;

  if hybrid_definition not like '%app_private.learning_rpc_context()%' then
    raise exception 'hybrid search is missing the tenant context boundary';
  end if;
  if hybrid_definition not like '%c.active_knowledge_version_id = ch.knowledge_version_id%' then
    raise exception 'hybrid search is missing the active version boundary';
  end if;
  if hybrid_definition not like '%target_course_id is null or ch.course_id = target_course_id%' then
    raise exception 'hybrid search is missing its typed course filter';
  end if;
  if has_function_privilege(
    'anon',
    'public.learning_search_chunks_hybrid(text,extensions.vector,uuid,integer)',
    'execute'
  ) then
    raise exception 'anonymous callers can execute hybrid search';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.learning_search_chunks_hybrid(text,extensions.vector,uuid,integer)',
    'execute'
  ) then
    raise exception 'authenticated callers cannot execute hybrid search';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.learning_claim_embedding_batch(integer)',
    'execute'
  ) then
    raise exception 'authenticated callers can claim embedding work';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.learning_commit_embedding_batch(jsonb,text,text)',
    'execute'
  ) then
    raise exception 'service worker cannot commit embedding work';
  end if;
end
$$;

rollback;
