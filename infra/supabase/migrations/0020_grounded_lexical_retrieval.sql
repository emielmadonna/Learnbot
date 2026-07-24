-- Tenant-bound lexical retrieval over the active published knowledge version.
-- The RPC exposes bounded source excerpts, not direct access to knowledge tables.

begin;

create index learning_chunks_body_fts_idx
  on public.learning_chunks
  using gin (to_tsvector('english', body))
  where deleted_at is null;

create or replace function public.learning_search_chunks(
  search_query text,
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
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_selection_required'
    );
  end if;

  normalized_query := regexp_replace(
    btrim(coalesce(search_query, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  if length(normalized_query) < 2 or length(normalized_query) > 512 then
    return jsonb_build_object(
      'ok', false,
      'code', 'invalid_search_query'
    );
  end if;

  bounded_limit := greatest(1, least(coalesce(match_limit, 6), 12));
  parsed_query := websearch_to_tsquery('english', normalized_query);
  if numnode(parsed_query) = 0 then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'query', normalized_query,
      'courseId', target_course_id,
      'matchLimit', bounded_limit,
      'matches', '[]'::jsonb
    );
  end if;
  if querytree(parsed_query) in ('', 'T') then
    return jsonb_build_object(
      'ok', false,
      'code', 'invalid_search_query'
    );
  end if;

  with ranked_matches as (
    select
      ch.chunk_id,
      ch.course_id,
      c.title as course_title,
      ch.knowledge_version_id,
      ch.document_id,
      d.title as document_title,
      ch.ordinal,
      ch.content_hash,
      ch.metadata,
      ts_rank_cd(
        to_tsvector('english', ch.body),
        parsed_query,
        32
      ) as relevance,
      ts_headline(
        'english',
        ch.body,
        parsed_query,
        'MaxFragments=2,MaxWords=80,MinWords=20'
      ) as excerpt
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
      and (
        target_course_id is null
        or ch.course_id = target_course_id
      )
      and to_tsvector('english', ch.body) @@ parsed_query
    order by
      relevance desc,
      ch.course_id,
      ch.document_id,
      ch.ordinal,
      ch.chunk_id
    limit bounded_limit
  )
  select coalesce(
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
        course_id,
        document_id,
        ordinal,
        chunk_id
    ),
    '[]'::jsonb
  )
  into matches
  from ranked_matches;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'query', normalized_query,
    'courseId', target_course_id,
    'matchLimit', bounded_limit,
    'matches', matches
  );
end;
$$;

revoke execute on function public.learning_search_chunks(
  text, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.learning_search_chunks(
  text, uuid, integer
) to authenticated;
revoke execute on function public.learning_search_chunks(
  text, uuid, integer
) from service_role;

commit;
