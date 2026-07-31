do $$
begin
  if position(
    ''' OR ''' in pg_get_functiondef(
      'app_private.learning_chunk_matches(uuid,text,extensions.vector,uuid,integer,jsonb)'::regprocedure
    )
  ) = 0 then
    raise exception 'shared ranker does not contain the natural-question fallback';
  end if;

  if position(
    'learning_search_chunks_legacy' in pg_get_functiondef(
      'public.learning_search_chunks(text,uuid,integer)'::regprocedure
    )
  ) = 0 then
    raise exception 'authenticated lexical search lost its tenant-bound implementation';
  end if;
end;
$$;
