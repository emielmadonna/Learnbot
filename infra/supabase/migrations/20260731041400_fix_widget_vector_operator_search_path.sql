-- Keep the anonymous widget retrieval function on an explicit, trusted
-- search path while allowing PostgreSQL to resolve pgvector's distance
-- operators. Without `extensions` here, the function fails during planning
-- with SQLSTATE 42883 even for lexical-only requests whose query embedding is
-- null, which makes every hosted assistant question look unavailable.
alter function app_private.learning_chunk_matches(
  uuid,
  text,
  extensions.vector,
  uuid,
  integer,
  jsonb
)
set search_path = pg_catalog, extensions;
