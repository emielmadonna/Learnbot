-- Run after 20260731042443_managed_edge_embedding_worker.sql.

begin;

do $$
declare
  reserve_definition text;
  record_definition text;
begin
  -- MEW-01: browser roles cannot reserve provider spend.
  if has_function_privilege(
    'anon',
    'public.learning_reserve_embedding_worker_call(text,uuid,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.learning_reserve_embedding_worker_call(text,uuid,text)',
    'execute'
  ) then
    raise exception 'MEW-01 browser role can reserve embedding spend';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.learning_reserve_embedding_worker_call(text,uuid,text)',
    'execute'
  ) then
    raise exception 'MEW-01 service worker cannot reserve embedding spend';
  end if;

  -- MEW-02: browser roles cannot forge cost records.
  if has_function_privilege(
    'anon',
    'public.learning_record_embedding_worker_cost(text,uuid,bigint,bigint,text,text,integer,integer)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.learning_record_embedding_worker_cost(text,uuid,bigint,bigint,text,text,integer,integer)',
    'execute'
  ) then
    raise exception 'MEW-02 browser role can record embedding costs';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.learning_record_embedding_worker_cost(text,uuid,bigint,bigint,text,text,integer,integer)',
    'execute'
  ) then
    raise exception 'MEW-02 service worker cannot record embedding costs';
  end if;

  select pg_get_functiondef(
    'public.learning_reserve_embedding_worker_call(text,uuid,text)'::regprocedure
  ) into reserve_definition;
  select pg_get_functiondef(
    'public.learning_record_embedding_worker_cost(text,uuid,bigint,bigint,text,text,integer,integer)'::regprocedure
  ) into record_definition;

  -- MEW-03: both service operations independently validate the capability.
  if reserve_definition not like
    '%learning_operation_token_is_valid(%knowledge.embedding.worker%'
    or record_definition not like
    '%learning_operation_token_is_valid(%knowledge.embedding.worker%'
  then
    raise exception 'MEW-03 operation-token validation is missing';
  end if;

  -- MEW-04: a reservation enforces durable policy and the recorder appends
  -- only bounded billing metadata for the embedding capability.
  if lower(reserve_definition) not like '%provider_call_decision%'
    or lower(reserve_definition) not like '%conversation.embed%'
    or lower(record_definition) not like '%cost_ledger%'
    or lower(record_definition) not like '%text-embedding-3-small%'
    or lower(record_definition) not like '%itemcount%'
  then
    raise exception 'MEW-04 durable policy or cost metering is missing';
  end if;
end
$$;

rollback;
