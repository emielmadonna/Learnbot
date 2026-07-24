-- Durable hybrid retrieval for published learning.
-- Embeddings use Supabase gte-small (384 normalized dimensions). Tenant and
-- publication filters live inside the RPC so ranking cannot cross boundaries.

begin;

alter table public.learning_chunks
  alter column embedding type extensions.vector(384)
  using embedding::extensions.vector(384);

create index learning_chunks_embedding_hnsw_idx
  on public.learning_chunks
  using hnsw (embedding vector_ip_ops)
  where embedding is not null and deleted_at is null;

create or replace function public.learning_search_chunks_hybrid(
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
#variable_conflict use_variable
declare
  caller record;
  normalized_query text;
  parsed_query tsquery;
  bounded_limit integer;
  matches jsonb;
  embedded_match_count integer;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  normalized_query := regexp_replace(
    btrim(coalesce(search_query, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  if length(normalized_query) < 2 or length(normalized_query) > 512 then
    return jsonb_build_object('ok', false, 'code', 'invalid_search_query');
  end if;
  if query_embedding is null
    or extensions.vector_dims(query_embedding) <> 384 then
    return jsonb_build_object('ok', false, 'code', 'invalid_query_embedding');
  end if;

  bounded_limit := greatest(1, least(coalesce(match_limit, 6), 12));
  parsed_query := websearch_to_tsquery('english', normalized_query);

  with eligible as materialized (
    select
      ch.chunk_id,
      ch.course_id,
      c.title as course_title,
      ch.knowledge_version_id,
      ch.document_id,
      d.title as document_title,
      ch.ordinal,
      ch.body,
      ch.content_hash,
      ch.metadata,
      ch.embedding
    from public.learning_chunks ch
    join public.courses c
      on c.tenant_id = ch.tenant_id
     and c.course_id = ch.course_id
    join public.knowledge_versions kv
      on kv.tenant_id = ch.tenant_id
     and kv.knowledge_version_id = ch.knowledge_version_id
     and kv.course_id = ch.course_id
    join public.learning_documents d
      on d.tenant_id = ch.tenant_id
     and d.document_id = ch.document_id
     and d.course_id = ch.course_id
     and d.knowledge_version_id = ch.knowledge_version_id
    where ch.tenant_id = caller.tenant_id
      and ch.deleted_at is null
      and c.deleted_at is null
      and c.status = 'published'
      and c.active_knowledge_version_id = ch.knowledge_version_id
      and kv.deleted_at is null
      and kv.status = 'published'
      and d.deleted_at is null
      and d.status = 'ready'
      and (target_course_id is null or ch.course_id = target_course_id)
  ),
  lexical as (
    select
      e.chunk_id,
      row_number() over (
        order by
          ts_rank_cd(to_tsvector('english', e.body), parsed_query, 32) desc,
          e.chunk_id
      ) as lexical_rank
    from eligible e
    where numnode(parsed_query) > 0
      and querytree(parsed_query) not in ('', 'T')
      and to_tsvector('english', e.body) @@ parsed_query
    order by lexical_rank
    limit 50
  ),
  semantic as (
    select
      e.chunk_id,
      row_number() over (
        order by e.embedding <#> query_embedding, e.chunk_id
      ) as semantic_rank,
      -(e.embedding <#> query_embedding) as semantic_similarity
    from eligible e
    where e.embedding is not null
    order by e.embedding <#> query_embedding, e.chunk_id
    limit 50
  ),
  fused as (
    select
      coalesce(l.chunk_id, s.chunk_id) as chunk_id,
      l.lexical_rank,
      s.semantic_rank,
      s.semantic_similarity,
      coalesce(1.0 / (60 + l.lexical_rank), 0.0)
        + coalesce(1.0 / (60 + s.semantic_rank), 0.0) as relevance
    from lexical l
    full join semantic s on s.chunk_id = l.chunk_id
  ),
  ranked_matches as (
    select
      e.*,
      f.relevance,
      f.lexical_rank,
      f.semantic_rank,
      f.semantic_similarity,
      case
        when f.lexical_rank is not null then ts_headline(
          'english',
          e.body,
          parsed_query,
          'MaxFragments=2,MaxWords=80,MinWords=20'
        )
        else left(e.body, 700)
      end as excerpt
    from fused f
    join eligible e on e.chunk_id = f.chunk_id
    order by
      f.relevance desc,
      f.semantic_similarity desc nulls last,
      e.course_id,
      e.document_id,
      e.ordinal,
      e.chunk_id
    limit bounded_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'chunkId', chunk_id,
          'courseId', course_id,
          'courseTitle', course_title,
          'knowledgeVersionId', knowledge_version_id,
          'documentId', document_id,
          'documentTitle', document_title,
          'ordinal', ordinal,
          'contentHash', content_hash,
          'relevance', relevance,
          'lexicalRank', lexical_rank,
          'semanticRank', semantic_rank,
          'semanticSimilarity', semantic_similarity,
          'excerpt', excerpt,
          'source', jsonb_strip_nulls(jsonb_build_object(
            'courseSlug', metadata ->> 'courseSlug',
            'sectionName', metadata ->> 'sectionName',
            'lessonId', metadata ->> 'lessonId',
            'lessonName', metadata ->> 'lessonName',
            'startHms', metadata ->> 'startHms'
          ))
        )
        order by
          relevance desc,
          semantic_similarity desc nulls last,
          course_id,
          document_id,
          ordinal,
          chunk_id
      ),
      '[]'::jsonb
    ),
    count(*) filter (where semantic_rank is not null)
  into matches, embedded_match_count
  from ranked_matches;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'retrievalMode',
      case when embedded_match_count > 0 then 'hybrid' else 'lexical_degraded' end,
    'embeddingProvider', 'supabase',
    'embeddingModel', 'gte-small',
    'embeddingDimensions', 384,
    'query', normalized_query,
    'courseId', target_course_id,
    'matchLimit', bounded_limit,
    'matches', matches
  );
end;
$$;

revoke execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) to authenticated;

-- Server-only worker contracts. Content hashes prevent stale embeddings from
-- being committed after a chunk is revised.
create or replace function public.learning_claim_embedding_batch(
  batch_limit integer default 32
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'items',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'chunkId', q.chunk_id,
          'contentHash', q.content_hash,
          'body', q.body
        )
        order by q.chunk_id
      ),
      '[]'::jsonb
    )
  )
  from (
    select ch.chunk_id, ch.content_hash, ch.body
    from public.learning_chunks ch
    where ch.deleted_at is null
      and ch.embedding is null
    order by ch.chunk_id
    limit greatest(1, least(coalesce(batch_limit, 32), 64))
  ) q;
$$;

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
    or provider_key <> 'supabase'
    or model_key <> 'gte-small' then
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

revoke execute on function public.learning_claim_embedding_batch(integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_commit_embedding_batch(
  jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.learning_claim_embedding_batch(integer)
  to service_role;
grant execute on function public.learning_commit_embedding_batch(
  jsonb, text, text
) to service_role;

commit;
