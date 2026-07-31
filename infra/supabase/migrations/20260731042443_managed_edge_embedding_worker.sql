-- Managed Edge embedding worker metering boundary.
--
-- The existing claim/commit/release RPCs already enforce the
-- `knowledge.embedding.worker` operation capability and lease each chunk with
-- stale-content protection. This migration adds two service-role-only
-- companions so the Edge worker can enforce each tenant's durable provider
-- policy before spend and append the completed OpenAI call to cost_ledger.
-- No plaintext operation token is stored or returned.

begin;

create or replace function public.learning_reserve_embedding_worker_call(
  operation_token text,
  target_tenant_id uuid,
  subject_key text default 'managed-edge-embedding-worker'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if not app_private.learning_operation_token_is_valid(
    'knowledge.embedding.worker',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  return app_private.provider_call_decision(
    target_tenant_id,
    'conversation.embed',
    coalesce(nullif(btrim(subject_key), ''), 'managed-edge-embedding-worker')
  );
end;
$$;

create or replace function public.learning_record_embedding_worker_cost(
  operation_token text,
  target_tenant_id uuid,
  prompt_tokens bigint,
  estimated_cost_micro bigint,
  trace_id text,
  idempotency_key text,
  item_count integer,
  latency_ms integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  cost_policy public.tenant_cost_policies%rowtype;
  existing public.cost_ledger%rowtype;
  created public.cost_ledger%rowtype;
begin
  if not app_private.learning_operation_token_is_valid(
    'knowledge.embedding.worker',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or prompt_tokens is null
    or prompt_tokens < 0
    or estimated_cost_micro is null
    or estimated_cost_micro < 0
    or estimated_cost_micro > 100000000
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
    or item_count is null
    or item_count not between 1 and 64
    or latency_ms is null
    or latency_ms not between 0 and 120000
    or not exists (
      select 1
      from public.tenants tenant
      where tenant.tenant_id = target_tenant_id
        and tenant.deleted_at is null
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select * into existing
  from public.cost_ledger ledger
  where ledger.tenant_id = target_tenant_id
    and ledger.idempotency_key =
      learning_record_embedding_worker_cost.idempotency_key;
  if found then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true,
      'costEntryId', existing.cost_entry_id
    );
  end if;

  cost_policy := app_private.tenant_cost_policy(target_tenant_id);
  insert into public.cost_ledger (
    tenant_id,
    request_id,
    trace_id,
    capability,
    provider_key,
    model_key,
    quantity,
    unit,
    estimated_cost_micro,
    estimated_cost_minor,
    currency,
    funding_source,
    provider_metadata_safe,
    idempotency_key,
    occurred_at,
    retain_until
  ) values (
    target_tenant_id,
    left(trace_id, 200),
    trace_id,
    'conversation.embed',
    'openai',
    'text-embedding-3-small',
    prompt_tokens,
    'input_tokens',
    estimated_cost_micro,
    ceil(estimated_cost_micro::numeric / 10000)::bigint,
    cost_policy.currency,
    'platform',
    jsonb_build_object(
      'operation', 'stored_chunk_embedding',
      'itemCount', item_count,
      'latencyMs', latency_ms,
      'dimensions', 384
    ),
    idempotency_key,
    statement_timestamp(),
    statement_timestamp() + interval '7 years'
  )
  returning * into created;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'costEntryId', created.cost_entry_id,
    'estimatedCostMicro', created.estimated_cost_micro,
    'currency', created.currency
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true
    );
end;
$$;

-- SECURITY DEFINER functions receive PUBLIC execute by default. The Edge
-- worker calls these with the project's secret key; no browser role can reach
-- either function even if it somehow learns the operation token.
revoke all on function public.learning_reserve_embedding_worker_call(
  text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.learning_record_embedding_worker_cost(
  text, uuid, bigint, bigint, text, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.learning_reserve_embedding_worker_call(
  text, uuid, text
) to service_role;
grant execute on function public.learning_record_embedding_worker_cost(
  text, uuid, bigint, bigint, text, text, integer, integer
) to service_role;

commit;
