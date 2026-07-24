-- Switch the hosted embedding worker to the configured provider-neutral OpenAI
-- adapter. The dimension remains 384, so no vector rewrite is required.

begin;

alter function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) rename to learning_search_chunks_hybrid_v1;

revoke execute on function public.learning_search_chunks_hybrid_v1(
  text, extensions.vector, uuid, integer
) from public, anon, authenticated, service_role;

create function public.learning_search_chunks_hybrid(
  search_query text,
  query_embedding extensions.vector(384),
  target_course_id uuid default null,
  match_limit integer default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  result := public.learning_search_chunks_hybrid_v1(
    search_query,
    query_embedding,
    target_course_id,
    match_limit
  );
  if result ->> 'ok' = 'true' then
    result := jsonb_set(result, '{embeddingProvider}', '"openai"'::jsonb);
    result := jsonb_set(
      result,
      '{embeddingModel}',
      '"text-embedding-3-small"'::jsonb
    );
  end if;
  return result;
end;
$$;

grant execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) to authenticated;

create or replace function public.learning_commit_embedding_batch(
  items jsonb,
  provider_key text,
  model_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  committed integer;
begin
  if jsonb_typeof(items) <> 'array'
    or jsonb_array_length(items) < 1
    or jsonb_array_length(items) > 64
    or provider_key <> 'openai'
    or model_key <> 'text-embedding-3-small' then
    return jsonb_build_object('ok', false, 'code', 'invalid_embedding_batch');
  end if;

  with incoming as (
    select
      x.chunk_id,
      x.content_hash,
      x.embedding::extensions.vector(384) as embedding
    from jsonb_to_recordset(items) as x(
      chunk_id uuid,
      content_hash text,
      embedding text
    )
  )
  update public.learning_chunks ch
  set
    embedding = i.embedding,
    embedding_provider_key = provider_key,
    embedding_model_key = model_key,
    embedding_dimensions = 384,
    updated_at = now()
  from incoming i
  where ch.chunk_id = i.chunk_id
    and ch.content_hash = i.content_hash
    and ch.deleted_at is null
    and extensions.vector_dims(i.embedding) = 384;

  get diagnostics committed = row_count;
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'committed', committed
  );
end;
$$;

revoke execute on function public.learning_commit_embedding_batch(
  jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.learning_commit_embedding_batch(
  jsonb, text, text
) to service_role;

commit;
