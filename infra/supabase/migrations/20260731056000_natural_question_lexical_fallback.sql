-- Anonymous hosted assistants do not run a browser-side embedding model. Keep
-- precise web-search matching first, then relax a zero-result natural-language
-- question to OR-ranked terms. This lets questions such as "How should I find
-- ideal prospects?" retrieve the published lesson instead of treating every
-- non-stopword as mandatory. Tenant, publication and course-scope checks remain
-- inside the existing ranker.

begin;

create or replace function app_private.learning_chunk_matches(
  target_tenant_id uuid,
  search_query text,
  query_embedding extensions.vector(384),
  target_course_id uuid,
  match_limit integer,
  course_allowlist jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions
as $$
declare
  result jsonb;
  enriched_matches jsonb;
  relaxed_query text;
begin
  result := app_private.learning_chunk_matches_legacy(
    target_tenant_id,
    search_query,
    query_embedding,
    target_course_id,
    match_limit,
    course_allowlist
  );

  if query_embedding is null
    and coalesce((result ->> 'ok')::boolean, false)
    and jsonb_array_length(coalesce(result -> 'matches', '[]'::jsonb)) = 0
  then
    relaxed_query := regexp_replace(
      btrim(coalesce(search_query, '')),
      '[[:space:]]+',
      ' OR ',
      'g'
    );
    if relaxed_query <> btrim(coalesce(search_query, '')) then
      result := app_private.learning_chunk_matches_legacy(
        target_tenant_id,
        relaxed_query,
        null::extensions.vector(384),
        target_course_id,
        match_limit,
        course_allowlist
      );
    end if;
  end if;

  if coalesce((result ->> 'ok')::boolean, false) is not true then
    return result;
  end if;

  select coalesce(
    jsonb_agg(
      item.match || jsonb_build_object(
        'source',
        coalesce(item.match -> 'source', '{}'::jsonb)
          || app_private.visual_source_for_match(
            target_tenant_id,
            item.match ->> 'chunkId'
          )
      )
      order by item.ordinal
    ),
    '[]'::jsonb
  ) into enriched_matches
  from jsonb_array_elements(coalesce(result -> 'matches', '[]'::jsonb))
    with ordinality as item(match, ordinal);

  return jsonb_set(result, '{matches}', enriched_matches, true);
end;
$$;

revoke execute on function app_private.learning_chunk_matches(
  uuid, text, extensions.vector, uuid, integer, jsonb
) from public, anon, authenticated, service_role;

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
declare
  caller record;
  result jsonb;
  enriched_matches jsonb;
  relaxed_query text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;

  result := app_private.learning_search_chunks_legacy(
    search_query,
    target_course_id,
    match_limit
  );

  if coalesce((result ->> 'ok')::boolean, false)
    and jsonb_array_length(coalesce(result -> 'matches', '[]'::jsonb)) = 0
  then
    relaxed_query := regexp_replace(
      btrim(coalesce(search_query, '')),
      '[[:space:]]+',
      ' OR ',
      'g'
    );
    if relaxed_query <> btrim(coalesce(search_query, '')) then
      result := app_private.learning_search_chunks_legacy(
        relaxed_query,
        target_course_id,
        match_limit
      );
    end if;
  end if;

  if coalesce((result ->> 'ok')::boolean, false) is not true then
    return result;
  end if;

  select coalesce(
    jsonb_agg(
      item.match || jsonb_build_object(
        'source',
        coalesce(item.match -> 'source', '{}'::jsonb)
          || app_private.visual_source_for_match(
            caller.tenant_id,
            item.match ->> 'chunkId'
          )
      )
      order by item.ordinal
    ),
    '[]'::jsonb
  ) into enriched_matches
  from jsonb_array_elements(coalesce(result -> 'matches', '[]'::jsonb))
    with ordinality as item(match, ordinal);

  return jsonb_set(result, '{matches}', enriched_matches, true);
end;
$$;

revoke execute on function public.learning_search_chunks(
  text, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.learning_search_chunks(
  text, uuid, integer
) to authenticated;

commit;
