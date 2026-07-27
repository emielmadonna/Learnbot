-- Authored content becomes retrievable knowledge.
--
-- The defect this closes is the platform's most expensive one. Course authoring
-- writes public.content_blocks. Retrieval — public.learning_search_chunks and
-- public.learning_search_chunks_hybrid — reads public.learning_chunks joined to
-- public.knowledge_versions and public.learning_documents. Nothing in the
-- repository bridged them: the only writer of those three tables was a one-off
-- import script hardwired to a local folder. A newly provisioned client could
-- author a course, publish it, be told it was live, and then have their
-- assistant answer "I couldn't find this in the published learning yet" to
-- every question forever, because apps/console/src/lib/learning-provider.ts
-- short-circuits to a canned refusal whenever retrieval returns zero sources.
-- Nothing anywhere reported the failure.
--
-- What this migration adds:
--
--   1. A projector. app_private.knowledge_project_course reads every *published*
--      lesson of a course, turns its content blocks into retrieval-sized chunks
--      and writes them as public.learning_documents + public.learning_chunks
--      under a fresh public.knowledge_versions row, then flips
--      public.courses.active_knowledge_version_id onto it. The row shapes match
--      what public.learning_search_chunks already joins and what its citation
--      payload already reads out of learning_chunks.metadata, because both are
--      load-bearing: a chunk whose metadata lacks lessonId cannot be filtered to
--      a learner's selected lesson by apps/console/src/app/api/learning/respond.
--
--   2. Publishing invokes it. public.learning_publish_course is redefined here
--      (never edited in place in 20260726092000) so an author never has to know
--      the projection step exists. It runs in the publish transaction: if the
--      projection raises, the publish raises with it and the previously active
--      knowledge version is still the active one. There is no state in which a
--      course points at a half-built version.
--
--   3. Idempotency that respects money. Every projection is fingerprinted by
--      app_private.knowledge_projection_hash over the exact rows it would
--      project. A republish whose fingerprint is unchanged does no work at all.
--      A republish that did change carries each unchanged chunk's existing
--      embedding forward by content hash, so only genuinely new text is sent to
--      the embedding provider. Prior projections of the same course are retired
--      and their rows removed rather than accumulated, so republishing replaces
--      instead of duplicating.
--
--   4. An embedding producer that can actually be called.
--      public.learning_claim_embedding_batch and
--      public.learning_commit_embedding_batch have existed since 0023/0024, are
--      service_role-only and have never had a caller. The console runs on a
--      publishable key and holds no service-role credential, so this migration
--      adds token-gated siblings — claim / commit / release — that the console
--      route apps/console/src/app/api/learning/embeddings can reach. They are
--      granted to `anon` and do nothing at all until
--      app_private.learning_operation_token_is_valid accepts a server-held
--      secret, which is the same gate public.learning_get_agent_directive uses
--      and the same posture as the widget entrypoints in 20260726093000. A
--      lease plus an attempt counter make repeated calls safe and stop a poison
--      chunk from being paid for forever.
--
--   5. Visibility. public.learning_course_knowledge_state reports, per course,
--      whether the published course is actually answerable, how much of it is
--      embedded and whether it has drifted since it was projected. The dead path
--      was silent; it no longer is.
--
-- Note on lexical retrieval: a freshly published course is answerable the
-- instant this projection commits. public.learning_search_chunks (0020) is
-- purely lexical, and public.learning_search_chunks_hybrid (0023) already
-- reports 'lexical_degraded' and still returns matches when no chunk carries an
-- embedding. Embeddings improve ranking; they are never a precondition for an
-- answer. A client never sees a dead assistant while the queue drains.
--
-- The migration declares no new tables. It adds three nullable/defaulted
-- columns to public.learning_chunks, replaces functions and re-issues grants,
-- so it is safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- Embedding queue state on the chunk itself
--
-- The queue is "every live chunk whose embedding is null". Making that a lease
-- rather than a bare predicate is what lets two overlapping worker invocations
-- be free instead of double-billed, and the attempt counter is what stops a
-- chunk the provider will never accept from being retried for the rest of time.
-- ---------------------------------------------------------------------------

alter table public.learning_chunks
  add column if not exists embedding_lease_owner text,
  add column if not exists embedding_lease_expires_at timestamptz,
  add column if not exists embedding_attempts integer not null default 0;

alter table public.learning_chunks
  drop constraint if exists learning_chunks_embedding_attempts_check;
alter table public.learning_chunks
  add constraint learning_chunks_embedding_attempts_check
  check (embedding_attempts >= 0);

create index if not exists learning_chunks_embedding_queue_idx
  on public.learning_chunks (tenant_id, course_id, embedding_attempts)
  where embedding is null and deleted_at is null;

-- The worker capability joins the existing conversation capability in the same
-- secret table, so operating a worker token is the operating procedure that
-- already exists for the answer path. The original constraint was declared
-- inline and therefore carries a generated name; it is located by its predicate
-- rather than guessed at, so this cannot half-apply and leave the old, narrower
-- check in force.
do $$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select con.conname
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'app_private'
      and rel.relname = 'learning_operation_secrets'
      and con.contype = 'c'
      and pg_catalog.pg_get_constraintdef(con.oid)
        like '%conversation.answer.record%'
  loop
    execute format(
      'alter table app_private.learning_operation_secrets drop constraint %I',
      existing_constraint
    );
  end loop;
end $$;

alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_capability_allowed
  check (
    capability in (
      'conversation.answer.record',
      'knowledge.embedding.worker'
    )
  );

-- ---------------------------------------------------------------------------
-- Text preparation
-- ---------------------------------------------------------------------------

-- Position of the last occurrence of `needle`, or 0. Used to cut an oversized
-- block at the most natural boundary inside the size band rather than mid-word.
create or replace function app_private.knowledge_last_index(
  haystack text,
  needle text
)
returns integer
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case
    when haystack is null or needle is null or needle = '' then 0
    when strpos(reverse(haystack), reverse(needle)) = 0 then 0
    else length(haystack)
      - strpos(reverse(haystack), reverse(needle))
      - length(needle)
      + 2
  end;
$$;

-- Authored blocks arrive with editor whitespace. Paragraph structure is the one
-- thing the chunker needs to preserve, so runs of horizontal space collapse and
-- blank-line runs normalise to exactly one blank line.
create or replace function app_private.knowledge_normalize_text(raw_value text)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(raw_value, ''), E'\r\n?', E'\n', 'g'),
            E'[\t\f\v ]+', ' ', 'g'
          ),
          E' ?\n ?', E'\n', 'g'
        ),
        E'\n{3,}', E'\n\n', 'g'
      )
    ),
    ''
  );
$$;

-- Readable text of one content block. app_private.authoring_valid_block accepts
-- 'rich_text', 'heading', 'callout', 'code', 'quote', 'list' and 'divider' and
-- only constrains the shape of 'rich_text', so the extractor reads the known
-- keys first and then falls back to every string leaf that is not structural
-- metadata. A block whose text cannot be recovered contributes nothing rather
-- than contributing a JSON blob that would then be retrieved and quoted.
create or replace function app_private.knowledge_block_text(
  block_type text,
  content jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  collected text;
begin
  if content is null
    or jsonb_typeof(content) <> 'object'
    or block_type = 'divider'
  then
    return null;
  end if;

  collected := concat_ws(
    E'\n\n',
    case
      when jsonb_typeof(content -> 'title') = 'string'
        then content ->> 'title'
    end,
    case
      when jsonb_typeof(content -> 'heading') = 'string'
        then content ->> 'heading'
    end,
    case
      when jsonb_typeof(content -> 'text') = 'string'
        then content ->> 'text'
    end,
    case
      when jsonb_typeof(content -> 'body') = 'string'
        then content ->> 'body'
    end,
    case
      when jsonb_typeof(content -> 'markdown') = 'string'
        then content ->> 'markdown'
    end,
    case
      when jsonb_typeof(content -> 'code') = 'string'
        then content ->> 'code'
    end,
    case
      when jsonb_typeof(content -> 'quote') = 'string'
        then content ->> 'quote'
    end,
    case
      when jsonb_typeof(content -> 'caption') = 'string'
        then content ->> 'caption'
    end,
    case
      when jsonb_typeof(content -> 'items') = 'array' then (
        select string_agg(
          case
            when jsonb_typeof(listed.item) = 'string' then listed.item #>> '{}'
            when jsonb_typeof(listed.item) = 'object'
              and jsonb_typeof(listed.item -> 'text') = 'string'
              then listed.item ->> 'text'
          end,
          E'\n' order by listed.item_index
        )
        from jsonb_array_elements(content -> 'items')
          with ordinality as listed(item, item_index)
      )
    end
  );

  if btrim(coalesce(collected, '')) = '' then
    select string_agg(fields.field_value #>> '{}', E'\n\n' order by fields.field_key)
    into collected
    from jsonb_each(content) as fields(field_key, field_value)
    where jsonb_typeof(fields.field_value) = 'string'
      and fields.field_key not in (
        'format', 'language', 'id', 'url', 'href', 'src', 'align', 'variant',
        'level', 'icon', 'tone', 'color', 'alt', 'startHms', 'sourceStart',
        'sourceLabel'
      )
      and length(btrim(fields.field_value #>> '{}')) >= 2;
  end if;

  return left(app_private.knowledge_normalize_text(collected), 60000);
end;
$$;

-- Split one oversized block into pieces no larger than max_size, preferring a
-- paragraph break, then a sentence end, then a word boundary. A block smaller
-- than max_size is returned whole, which is what keeps block boundaries intact.
create or replace function app_private.knowledge_split_text(
  source_text text,
  max_size integer
)
returns text[]
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  remaining text;
  window_text text;
  cut integer;
  piece text;
  parts text[] := array[]::text[];
  guard integer := 0;
begin
  remaining := btrim(coalesce(source_text, ''));
  if remaining = '' or max_size < 64 then
    return case when remaining = '' then parts else array[remaining] end;
  end if;

  while length(remaining) > max_size and guard < 4000 loop
    guard := guard + 1;
    window_text := left(remaining, max_size);

    cut := app_private.knowledge_last_index(window_text, E'\n\n');
    if cut > max_size / 3 then
      piece := left(window_text, cut - 1);
      remaining := substr(remaining, cut + 2);
    else
      cut := app_private.knowledge_last_index(window_text, '. ');
      if cut > max_size / 3 then
        piece := left(window_text, cut);
        remaining := substr(remaining, cut + 2);
      else
        cut := app_private.knowledge_last_index(window_text, ' ');
        if cut > max_size / 3 then
          piece := left(window_text, cut - 1);
          remaining := substr(remaining, cut + 1);
        else
          piece := window_text;
          remaining := substr(remaining, max_size + 1);
        end if;
      end if;
    end if;

    piece := btrim(piece);
    if piece <> '' then
      parts := parts || piece;
    end if;
    remaining := btrim(remaining);
  end loop;

  if remaining <> '' then
    parts := parts || remaining;
  end if;
  return parts;
end;
$$;

-- Greedy packing that never splits a block: consecutive blocks join until the
-- next one would push the chunk past target_size. A short trailing chunk is
-- folded back into its predecessor so no citation is a stray sentence.
create or replace function app_private.knowledge_pack_chunks(
  parts text[],
  target_size integer,
  max_size integer
)
returns text[]
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  part text;
  current_chunk text := '';
  packed text[] := array[]::text[];
  tail integer;
begin
  if parts is null then
    return packed;
  end if;

  foreach part in array parts loop
    part := btrim(coalesce(part, ''));
    if part = '' then
      continue;
    end if;
    if current_chunk = '' then
      current_chunk := part;
    elsif length(current_chunk) + 2 + length(part) <= target_size then
      current_chunk := current_chunk || E'\n\n' || part;
    else
      packed := packed || current_chunk;
      current_chunk := part;
    end if;
  end loop;

  if current_chunk <> '' then
    packed := packed || current_chunk;
  end if;

  tail := array_length(packed, 1);
  if tail is not null
    and tail > 1
    and length(packed[tail]) < 240
    and length(packed[tail - 1]) + 2 + length(packed[tail]) <= max_size
  then
    packed[tail - 1] := packed[tail - 1] || E'\n\n' || packed[tail];
    packed := packed[1:tail - 1];
  end if;

  return packed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Projection fingerprint
--
-- The exact set of rows a projection would read, in a stable order. Equality
-- means re-projecting would produce byte-identical chunks, so the projector can
-- decline to do anything — which is the difference between republishing being
-- free and republishing costing an embedding pass. The projector version is
-- part of the hash so changing the chunker forces a rebuild.
-- ---------------------------------------------------------------------------
create or replace function app_private.knowledge_projection_hash(
  target_tenant_id uuid,
  target_course_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.digest(
      'authored_content_blocks:v1' || chr(29) ||
      coalesce(c.title, '') || chr(29) ||
      coalesce((
        select string_agg(f.fingerprint, chr(31) order by f.fingerprint)
        from (
          select
            lpad(m.position::text, 6, '0') || chr(30) ||
            m.module_id::text || chr(30) ||
            coalesce(m.title, '') || chr(30) ||
            lpad(l.position::text, 6, '0') || chr(30) ||
            l.lesson_id::text || chr(30) ||
            coalesce(l.title, '') || chr(30) ||
            coalesce((
              select string_agg(
                cb.content_block_id::text || ':' || cb.block_type || ':' ||
                  cb.content_hash,
                ',' order by cb.position, cb.content_block_id
              )
              from public.content_blocks cb
              where cb.tenant_id = l.tenant_id
                and cb.lesson_id = l.lesson_id
                and cb.deleted_at is null
            ), '') as fingerprint
          from public.lessons l
          join public.modules m
            on m.tenant_id = l.tenant_id
           and m.module_id = l.module_id
          where l.tenant_id = c.tenant_id
            and l.course_id = c.course_id
            and l.deleted_at is null
            and l.status = 'published'
            and m.deleted_at is null
            and m.status = 'published'
        ) f
      ), ''),
      'sha256'
    ),
    'hex'
  )
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null;
$$;

revoke execute on function app_private.knowledge_last_index(text, text)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_normalize_text(text)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_block_text(text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_split_text(text, integer)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_pack_chunks(
  text[], integer, integer
) from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_projection_hash(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The projector
--
-- Atomicity is the calling transaction. Every write below happens in one
-- statement-level scope: the new knowledge version is created 'building',
-- filled, promoted to 'published' and only then does the course point at it. If
-- anything raises — a unique violation, a constraint, a bad block — the whole
-- projection unwinds and the course still points at whatever it pointed at
-- before. There is no window in which a course is active on a half-built
-- version, and no cleanup path is needed because there is nothing to clean up.
--
-- Draft and archived content is never projected. 20260726092000 made the
-- distinction between draft, published and archived meaningful for what a
-- learner can see; this makes it equally meaningful for what the assistant can
-- say. A lesson that is not published, or whose module is not published, is not
-- retrievable, full stop.
-- ---------------------------------------------------------------------------
create or replace function app_private.knowledge_project_course(
  target_tenant_id uuid,
  target_course_id uuid,
  caller_actor_type text,
  caller_actor_role text,
  command_id text,
  replace_imported_knowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  chunk_target constant integer := 1200;
  chunk_max constant integer := 1800;
  course record;
  active_version record;
  lesson_row record;
  block_row record;
  prior_chunk record;
  projection_hash text;
  resolved_source_id uuid;
  new_version_id uuid;
  new_version_number integer;
  new_document_id uuid;
  document_text text;
  raw_parts text[];
  expanded_parts text[];
  packed_chunks text[];
  context_header text;
  chunk_body text;
  chunk_hash text;
  chunk_ordinal integer;
  document_count integer := 0;
  chunk_count integer := 0;
  reused_count integer := 0;
  pending_count integer := 0;
  active_is_imported boolean := false;
  should_activate boolean := true;
begin
  -- Serialises concurrent projections of the same course. Two publishes racing
  -- would otherwise both compute the same next version number.
  select
    c.course_id,
    c.tenant_id,
    c.title,
    c.external_id,
    c.status,
    c.active_knowledge_version_id
  into course
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null
  for update;
  if not found then
    raise no_data_found using message = 'Course was not found in this tenant';
  end if;

  projection_hash := app_private.knowledge_projection_hash(
    target_tenant_id,
    target_course_id
  );

  select
    kv.knowledge_version_id,
    kv.version_number,
    kv.status,
    kv.content_hash,
    kv.source_manifest,
    kv.published_at
  into active_version
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id = course.active_knowledge_version_id;

  -- Nothing changed since the last projection: re-chunking would produce the
  -- same rows and re-embedding them would be paid for twice.
  if found
    and active_version.status = 'published'
    and active_version.content_hash = projection_hash
    and active_version.source_manifest
      @> '[{"kind": "authored_content_blocks"}]'::jsonb
  then
    select
      count(*)::integer,
      count(*) filter (where ch.embedding is null)::integer
    into chunk_count, pending_count
    from public.learning_chunks ch
    where ch.tenant_id = target_tenant_id
      and ch.course_id = target_course_id
      and ch.knowledge_version_id = active_version.knowledge_version_id
      and ch.deleted_at is null;

    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'changed', false,
      'activated', true,
      'knowledgeVersionId', active_version.knowledge_version_id,
      'versionNumber', active_version.version_number,
      'contentHash', projection_hash,
      'documentCount', (
        select count(*)::integer
        from public.learning_documents d
        where d.tenant_id = target_tenant_id
          and d.knowledge_version_id = active_version.knowledge_version_id
          and d.deleted_at is null
      ),
      'chunkCount', chunk_count,
      'reusedEmbeddingCount', chunk_count - pending_count,
      'pendingEmbeddingCount', pending_count,
      'retrievable', chunk_count > 0
    );
  end if;

  -- An authored projection must never silently discard an imported knowledge
  -- version that was built by another pipeline: the authored blocks are usually
  -- a summary of it, so activating would shrink the corpus without anyone
  -- asking. The version is still built, and public.learning_course_knowledge_state
  -- reports 'inactive_projection' until someone chooses.
  active_is_imported := course.active_knowledge_version_id is not null
    and (
      active_version.knowledge_version_id is null
      or not (
        active_version.source_manifest
          @> '[{"kind": "authored_content_blocks"}]'::jsonb
      )
    );
  should_activate := (not active_is_imported) or replace_imported_knowledge;

  insert into public.learning_sources (
    tenant_id, course_id, source_type, name, status, external_ref,
    configuration, last_synced_at, idempotency_key
  ) values (
    target_tenant_id,
    target_course_id,
    'api',
    left(coalesce(course.title, 'Course'), 160) || ' authored content',
    'ready',
    'authored:' || target_course_id::text,
    jsonb_build_object(
      'projector', 'authored_content_blocks',
      'projectorVersion', 1
    ),
    now(),
    'authored-source:' || target_course_id::text
  )
  on conflict (tenant_id, course_id, source_type, external_ref) do update
    set status = 'ready',
        last_synced_at = now()
  returning learning_sources.source_id into resolved_source_id;

  select coalesce(max(kv.version_number), 0) + 1
  into new_version_number
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id;

  insert into public.knowledge_versions (
    tenant_id, course_id, version_number, status, source_manifest, content_hash,
    embedding_provider_key, embedding_model_key, embedding_dimensions,
    built_by, supersedes_version_id, idempotency_key
  ) values (
    target_tenant_id,
    target_course_id,
    new_version_number,
    'building',
    jsonb_build_array(jsonb_build_object(
      'source', 'authored:' || target_course_id::text,
      'kind', 'authored_content_blocks',
      'sourceId', resolved_source_id
    )),
    projection_hash,
    'openai',
    'text-embedding-3-small',
    384,
    auth.uid(),
    course.active_knowledge_version_id,
    'authored-knowledge:' || target_course_id::text || ':' ||
      new_version_number::text
  )
  returning knowledge_versions.knowledge_version_id into new_version_id;

  for lesson_row in
    select
      l.lesson_id,
      l.title,
      l.position as lesson_position,
      m.module_id,
      m.title as module_title,
      m.position as module_position
    from public.lessons l
    join public.modules m
      on m.tenant_id = l.tenant_id
     and m.module_id = l.module_id
    where l.tenant_id = target_tenant_id
      and l.course_id = target_course_id
      and l.deleted_at is null
      and l.status = 'published'
      and m.deleted_at is null
      and m.status = 'published'
    order by m.position, m.module_id, l.position, l.lesson_id
  loop
    raw_parts := array[]::text[];
    for block_row in
      select
        app_private.knowledge_block_text(cb.block_type, cb.content) as body
      from public.content_blocks cb
      where cb.tenant_id = target_tenant_id
        and cb.lesson_id = lesson_row.lesson_id
        and cb.deleted_at is null
      order by cb.position, cb.content_block_id
    loop
      if block_row.body is not null then
        raw_parts := raw_parts || block_row.body;
      end if;
    end loop;

    expanded_parts := array[]::text[];
    if array_length(raw_parts, 1) is not null then
      for chunk_ordinal in 1..array_length(raw_parts, 1) loop
        expanded_parts := expanded_parts || app_private.knowledge_split_text(
          raw_parts[chunk_ordinal],
          chunk_max
        );
      end loop;
    end if;

    packed_chunks := app_private.knowledge_pack_chunks(
      expanded_parts,
      chunk_target,
      chunk_max
    );
    if array_length(packed_chunks, 1) is null then
      -- A published lesson with no recoverable text is not a document. It is
      -- reported as an uncovered lesson by the knowledge-state RPC instead.
      continue;
    end if;

    document_text := array_to_string(expanded_parts, E'\n\n');
    insert into public.learning_documents (
      tenant_id, course_id, source_id, knowledge_version_id, external_id,
      title, media_type, language, content_hash, status, metadata,
      idempotency_key
    ) values (
      target_tenant_id,
      target_course_id,
      resolved_source_id,
      new_version_id,
      lesson_row.lesson_id::text,
      left(coalesce(lesson_row.title, 'Lesson'), 500),
      'text/markdown',
      'en',
      encode(extensions.digest(document_text, 'sha256'), 'hex'),
      'ready',
      jsonb_build_object(
        'projector', 'authored_content_blocks',
        'moduleId', lesson_row.module_id,
        'moduleTitle', lesson_row.module_title,
        'lessonId', lesson_row.lesson_id,
        'lessonPosition', lesson_row.lesson_position,
        'modulePosition', lesson_row.module_position,
        'chunkCount', array_length(packed_chunks, 1)
      ),
      'authored-doc:' || new_version_id::text || ':' ||
        lesson_row.lesson_id::text
    )
    returning learning_documents.document_id into new_document_id;
    document_count := document_count + 1;

    -- The citation context the retrieval RPCs and the answer prompt both read.
    -- It is prepended to the chunk body as well as carried in metadata: a
    -- learner asking "what does the onboarding lesson say" has to be able to
    -- match the lesson by name lexically, before any embedding exists.
    context_header := concat_ws(
      ' · ',
      nullif(btrim(coalesce(course.title, '')), ''),
      nullif(btrim(coalesce(lesson_row.module_title, '')), ''),
      nullif(btrim(coalesce(lesson_row.title, '')), '')
    );

    for chunk_ordinal in 1..array_length(packed_chunks, 1) loop
      chunk_body := case
        when context_header is null or context_header = ''
          then packed_chunks[chunk_ordinal]
        else context_header || E'\n\n' || packed_chunks[chunk_ordinal]
      end;
      chunk_hash := encode(extensions.digest(chunk_body, 'sha256'), 'hex');

      -- Identical text that has already been paid for keeps its vector. This is
      -- the whole reason republishing a course with one edited lesson does not
      -- re-embed the other forty.
      select
        ch.embedding,
        ch.embedding_provider_key,
        ch.embedding_model_key,
        ch.embedding_dimensions
      into prior_chunk
      from public.learning_chunks ch
      where ch.tenant_id = target_tenant_id
        and ch.course_id = target_course_id
        and ch.content_hash = chunk_hash
        and ch.embedding is not null
      order by ch.updated_at desc, ch.chunk_id
      limit 1;
      -- SELECT INTO nulls every field of the record when no row matches, so a
      -- miss inserts a null embedding and the chunk joins the queue.

      insert into public.learning_chunks (
        tenant_id, course_id, knowledge_version_id, document_id, ordinal, body,
        token_count, content_hash, embedding, embedding_provider_key,
        embedding_model_key, embedding_dimensions, metadata, idempotency_key
      ) values (
        target_tenant_id,
        target_course_id,
        new_version_id,
        new_document_id,
        chunk_ordinal - 1,
        chunk_body,
        ceil(length(chunk_body) / 4.0)::integer,
        chunk_hash,
        prior_chunk.embedding,
        prior_chunk.embedding_provider_key,
        prior_chunk.embedding_model_key,
        prior_chunk.embedding_dimensions,
        jsonb_build_object(
          'courseSlug', coalesce(course.external_id, target_course_id::text),
          'courseName', course.title,
          'sectionName', lesson_row.module_title,
          'moduleId', lesson_row.module_id,
          'lessonId', lesson_row.lesson_id,
          'lessonName', lesson_row.title,
          'projector', 'authored_content_blocks',
          'projectorVersion', 1
        ),
        'authored-chunk:' || new_version_id::text || ':' ||
          lesson_row.lesson_id::text || ':' || (chunk_ordinal - 1)::text
      );

      chunk_count := chunk_count + 1;
      if prior_chunk.embedding is null then
        pending_count := pending_count + 1;
      else
        reused_count := reused_count + 1;
      end if;
    end loop;
  end loop;

  update public.knowledge_versions
  set status = 'published',
      published_at = now()
  where tenant_id = target_tenant_id
    and knowledge_version_id = new_version_id;

  if should_activate then
    update public.courses
    set active_knowledge_version_id = new_version_id
    where tenant_id = target_tenant_id
      and course_id = target_course_id;
  end if;

  -- Replace, never accumulate. Earlier authored projections of this course stop
  -- being retrievable immediately; the immediately previous generation is kept
  -- soft-deleted so its embeddings remain available for reuse, and anything
  -- older is removed outright.
  update public.knowledge_versions kv
  set status = 'retired'
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id <> new_version_id
    and kv.status <> 'retired'
    and kv.source_manifest @> '[{"kind": "authored_content_blocks"}]'::jsonb;

  update public.learning_chunks ch
  set deleted_at = now()
  where ch.tenant_id = target_tenant_id
    and ch.course_id = target_course_id
    and ch.knowledge_version_id <> new_version_id
    and ch.deleted_at is null
    and exists (
      select 1
      from public.knowledge_versions kv
      where kv.tenant_id = ch.tenant_id
        and kv.knowledge_version_id = ch.knowledge_version_id
        and kv.source_manifest
          @> '[{"kind": "authored_content_blocks"}]'::jsonb
    );

  update public.learning_documents d
  set deleted_at = now(),
      status = 'deleted'
  where d.tenant_id = target_tenant_id
    and d.course_id = target_course_id
    and d.knowledge_version_id <> new_version_id
    and d.deleted_at is null
    and exists (
      select 1
      from public.knowledge_versions kv
      where kv.tenant_id = d.tenant_id
        and kv.knowledge_version_id = d.knowledge_version_id
        and kv.source_manifest
          @> '[{"kind": "authored_content_blocks"}]'::jsonb
    );

  delete from public.learning_chunks ch
  using public.knowledge_versions kv
  where kv.tenant_id = ch.tenant_id
    and kv.knowledge_version_id = ch.knowledge_version_id
    and kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.version_number < new_version_number - 1
    and kv.source_manifest @> '[{"kind": "authored_content_blocks"}]'::jsonb;

  delete from public.learning_documents d
  using public.knowledge_versions kv
  where kv.tenant_id = d.tenant_id
    and kv.knowledge_version_id = d.knowledge_version_id
    and kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.version_number < new_version_number - 1
    and kv.source_manifest @> '[{"kind": "authored_content_blocks"}]'::jsonb;

  perform app_private.authoring_append_audit(
    target_tenant_id,
    coalesce(caller_actor_type, 'system'),
    caller_actor_role,
    'learning.knowledge.project',
    target_course_id::text,
    command_id,
    active_version.content_hash,
    projection_hash,
    new_version_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'changed', true,
    'activated', should_activate,
    'knowledgeVersionId', new_version_id,
    'versionNumber', new_version_number,
    'contentHash', projection_hash,
    'documentCount', document_count,
    'chunkCount', chunk_count,
    'reusedEmbeddingCount', reused_count,
    'pendingEmbeddingCount', pending_count,
    'retrievable', should_activate and chunk_count > 0,
    'activationBlockedReason', case
      when should_activate then null
      else 'imported_knowledge_version_active'
    end
  );
end;
$$;

revoke execute on function app_private.knowledge_project_course(
  uuid, uuid, text, text, text, boolean
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Publishing projects. Redefined here, never edited in 20260726092000.
--
-- Everything the applied definition promised is preserved verbatim: only draft
-- children are promoted, archived children stay archived, the reported counts
-- are the counts of rows this call actually made visible, and the authoring
-- gate — not the learning gate — decides who may publish. The single change is
-- the projection call, and the `knowledge` object it adds to the result.
-- ---------------------------------------------------------------------------
create or replace function public.learning_publish_course(
  target_course_id uuid,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  fingerprint text;
  published_modules integer;
  published_lessons integer;
  projection jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_course_id is null
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid publish request';
  end if;
  if not exists (
    select 1
    from public.content_blocks cb
    join public.lessons l
      on l.tenant_id = cb.tenant_id
     and l.lesson_id = cb.lesson_id
    where cb.tenant_id = caller.tenant_id
      and cb.course_id = target_course_id
      and cb.deleted_at is null
      and l.deleted_at is null
  ) then
    raise check_violation using message = 'Course has no publishable content';
  end if;

  fingerprint := encode(
    extensions.digest(target_course_id::text, 'sha256'),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'learning.course.publish',
    idempotency_key,
    fingerprint,
    'learning_publish_course'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  update public.courses
  set status = 'published', published_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null;
  if not found then
    raise no_data_found using message = 'Course was not found';
  end if;

  with promoted as (
    update public.modules
    set status = 'published'
    where tenant_id = caller.tenant_id
      and course_id = target_course_id
      and deleted_at is null
      and status = 'draft'
    returning module_id
  )
  select count(*)::integer into published_modules from promoted;

  with promoted as (
    update public.lessons
    set status = 'published'
    where tenant_id = caller.tenant_id
      and course_id = target_course_id
      and deleted_at is null
      and status = 'draft'
    returning lesson_id
  )
  select count(*)::integer into published_lessons from promoted;

  -- Publishing is the moment the content becomes answerable. Running the
  -- projection inside this transaction is what makes that true, and what makes
  -- a projection failure roll the publish back rather than leaving a course
  -- that says "published" and answers nothing.
  projection := app_private.knowledge_project_course(
    caller.tenant_id,
    target_course_id,
    caller.actor_type,
    caller.identity_role,
    idempotency_key,
    false
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'status', 'published',
    'publishedModules', published_modules,
    'publishedLessons', published_lessons,
    'knowledge', projection
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'learning.course.publish',
    idempotency_key,
    result
  );
  return result;
end;
$$;

-- Re-projection without a publish: recovering a course whose projection failed,
-- and the deliberate override that lets an imported knowledge version be
-- replaced by the authored one.
create or replace function public.learning_project_course_knowledge(
  target_course_id uuid,
  idempotency_key text,
  replace_imported_knowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  fingerprint text;
  projection jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_course_id is null
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid projection request';
  end if;

  fingerprint := encode(
    extensions.digest(
      target_course_id::text || chr(31) ||
        coalesce(replace_imported_knowledge, false)::text,
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'learning.knowledge.project',
    idempotency_key,
    fingerprint,
    'learning_project_course_knowledge'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  projection := app_private.knowledge_project_course(
    caller.tenant_id,
    target_course_id,
    caller.actor_type,
    caller.identity_role,
    idempotency_key,
    coalesce(replace_imported_knowledge, false)
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'knowledge', projection
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'learning.knowledge.project',
    idempotency_key,
    result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Making the failure visible
--
-- Before this, an author had no way to tell a course that answers questions
-- from a course that refuses every one of them. `answerable` is the honest
-- version of that question: the course is published, its active knowledge
-- version is published, and it has at least one live chunk — which is exactly
-- the predicate public.learning_search_chunks applies. Embedding counts are
-- reported separately because embeddings improve ranking and never gate an
-- answer, so a draining queue must not read as a broken course.
-- ---------------------------------------------------------------------------
create or replace function public.learning_course_knowledge_state(
  target_course_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  courses_payload jsonb;
  queue_payload jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(entry order by entry ->> 'title', entry ->> 'courseId'),
    '[]'::jsonb
  )
  into courses_payload
  from (
    select jsonb_build_object(
      'courseId', c.course_id,
      'title', c.title,
      'status', c.status,
      'knowledgeVersionId', c.active_knowledge_version_id,
      'versionNumber', active.version_number,
      'versionStatus', active.status,
      'projectedAt', active.published_at,
      'documentCount', coalesce(counts.document_count, 0),
      'chunkCount', coalesce(counts.chunk_count, 0),
      'embeddedChunkCount', coalesce(counts.embedded_count, 0),
      'pendingEmbeddingCount', coalesce(counts.pending_count, 0),
      'failedEmbeddingCount', coalesce(counts.failed_count, 0),
      'publishedLessonCount', coalesce(coverage.published_lessons, 0),
      'coveredLessonCount', coalesce(counts.covered_lessons, 0),
      'answerable',
        c.status = 'published'
        and active.status = 'published'
        and coalesce(counts.chunk_count, 0) > 0,
      'contentHash', active.content_hash,
      'currentContentHash', current_hash.hash_value,
      'state', case
        when c.status <> 'published' then 'not_published'
        when authored.knowledge_version_id is null then 'never_projected'
        when c.active_knowledge_version_id is distinct from
          authored.knowledge_version_id then 'inactive_projection'
        when coalesce(counts.chunk_count, 0) = 0 then 'empty'
        when active.content_hash is distinct from current_hash.hash_value
          then 'stale'
        else 'ready'
      end
    ) as entry
    from public.courses c
    left join lateral (
      select
        kv.knowledge_version_id,
        kv.version_number,
        kv.status,
        kv.content_hash,
        kv.published_at
      from public.knowledge_versions kv
      where kv.tenant_id = c.tenant_id
        and kv.course_id = c.course_id
        and kv.knowledge_version_id = c.active_knowledge_version_id
    ) active on true
    left join lateral (
      select kv.knowledge_version_id
      from public.knowledge_versions kv
      where kv.tenant_id = c.tenant_id
        and kv.course_id = c.course_id
        and kv.status = 'published'
        and kv.source_manifest
          @> '[{"kind": "authored_content_blocks"}]'::jsonb
      order by kv.version_number desc
      limit 1
    ) authored on true
    left join lateral (
      select
        count(*)::integer as chunk_count,
        count(*) filter (where ch.embedding is not null)::integer
          as embedded_count,
        count(*) filter (
          where ch.embedding is null and ch.embedding_attempts < 8
        )::integer as pending_count,
        count(*) filter (
          where ch.embedding is null and ch.embedding_attempts >= 8
        )::integer as failed_count,
        count(distinct ch.document_id)::integer as document_count,
        count(distinct ch.metadata ->> 'lessonId')::integer as covered_lessons
      from public.learning_chunks ch
      where ch.tenant_id = c.tenant_id
        and ch.course_id = c.course_id
        and ch.knowledge_version_id = c.active_knowledge_version_id
        and ch.deleted_at is null
    ) counts on true
    left join lateral (
      select count(*)::integer as published_lessons
      from public.lessons l
      join public.modules m
        on m.tenant_id = l.tenant_id
       and m.module_id = l.module_id
      where l.tenant_id = c.tenant_id
        and l.course_id = c.course_id
        and l.deleted_at is null
        and l.status = 'published'
        and m.deleted_at is null
        and m.status = 'published'
    ) coverage on true
    left join lateral (
      select app_private.knowledge_projection_hash(
        c.tenant_id, c.course_id
      ) as hash_value
    ) current_hash on true
    where c.tenant_id = caller.tenant_id
      and c.deleted_at is null
      and (target_course_id is null or c.course_id = target_course_id)
    order by
      case c.status when 'published' then 0 else 1 end,
      c.updated_at desc,
      c.course_id
    limit 50
  ) visible;

  select jsonb_build_object(
    'embeddedChunkCount', count(*) filter (where ch.embedding is not null),
    'pendingChunkCount', count(*) filter (
      where ch.embedding is null and ch.embedding_attempts < 8
    ),
    'failedChunkCount', count(*) filter (
      where ch.embedding is null and ch.embedding_attempts >= 8
    )
  )
  into queue_payload
  from public.learning_chunks ch
  where ch.tenant_id = caller.tenant_id
    and ch.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courses', courses_payload,
    'embedding', queue_payload
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The embedding producer's server contract
--
-- public.learning_claim_embedding_batch / _commit_embedding_batch (0023, 0024)
-- are service_role-only and have never had a caller, because the only server
-- that could call them — the console — deliberately holds no service-role key.
-- These three wrappers are the callable surface. They are granted to `anon`
-- and return access_denied before touching a row unless the caller presents the
-- 'knowledge.embedding.worker' operation secret, which lives only in the
-- application server environment. That is the same gate
-- public.learning_get_agent_directive applies, and the same posture as the
-- widget entrypoints: reachability is not authority.
--
-- The lease is what makes repeated calls safe. Two overlapping worker runs
-- claim disjoint chunks; a run that dies mid-flight releases its chunks when the
-- lease expires. embedding_attempts bounds the cost of a chunk the provider will
-- never accept, and a retryable provider failure gives the attempt back.
-- ---------------------------------------------------------------------------
create or replace function public.learning_claim_embedding_work(
  operation_token text,
  batch_limit integer default 32
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  bounded_limit integer;
  lease_owner text;
  items jsonb;
  remaining integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'knowledge.embedding.worker',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  bounded_limit := greatest(1, least(coalesce(batch_limit, 32), 64));
  lease_owner := 'embedding-worker:' || gen_random_uuid()::text;

  with candidate as (
    select ch.chunk_id
    from public.learning_chunks ch
    join public.knowledge_versions kv
      on kv.tenant_id = ch.tenant_id
     and kv.knowledge_version_id = ch.knowledge_version_id
    join public.courses c
      on c.tenant_id = ch.tenant_id
     and c.course_id = ch.course_id
    where ch.deleted_at is null
      and ch.embedding is null
      and ch.embedding_attempts < 8
      and (
        ch.embedding_lease_expires_at is null
        or ch.embedding_lease_expires_at < now()
      )
      and kv.deleted_at is null
      and kv.status = 'published'
      and c.deleted_at is null
    order by
      (c.active_knowledge_version_id = ch.knowledge_version_id) desc,
      ch.embedding_attempts,
      ch.created_at,
      ch.chunk_id
    limit bounded_limit
    for update of ch skip locked
  ),
  leased as (
    update public.learning_chunks target
    set embedding_lease_owner = lease_owner,
        embedding_lease_expires_at = now() + interval '5 minutes',
        embedding_attempts = target.embedding_attempts + 1
    from candidate
    where target.chunk_id = candidate.chunk_id
    returning
      target.chunk_id,
      target.tenant_id,
      target.content_hash,
      target.body
  )
  -- tenantId is carried so the worker's spend can be attributed per tenant in
  -- public.cost_ledger. The batch deliberately spans tenants — the queue is
  -- global — so the producer has to group by it rather than assume one.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'chunkId', leased.chunk_id,
        'tenantId', leased.tenant_id,
        'contentHash', leased.content_hash,
        'body', leased.body
      )
      order by leased.chunk_id
    ),
    '[]'::jsonb
  )
  into items
  from leased;

  select count(*)::integer
  into remaining
  from public.learning_chunks ch
  where ch.deleted_at is null
    and ch.embedding is null
    and ch.embedding_attempts < 8;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'leaseOwner', lease_owner,
    'provider', 'openai',
    'model', 'text-embedding-3-small',
    'dimensions', 384,
    'items', items,
    'remaining', remaining
  );
end;
$$;

create or replace function public.learning_commit_embedding_work(
  operation_token text,
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
  committed jsonb;
begin
  if not app_private.learning_operation_token_is_valid(
    'knowledge.embedding.worker',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  -- The provider/model/dimension contract and the stale-content-hash guard both
  -- live in the function 0024 already ships. This wrapper adds only the token
  -- gate and the lease release.
  committed := public.learning_commit_embedding_batch(
    items,
    provider_key,
    model_key
  );
  if coalesce(committed ->> 'ok', 'false') <> 'true' then
    return committed;
  end if;

  update public.learning_chunks ch
  set embedding_lease_owner = null,
      embedding_lease_expires_at = null
  from jsonb_to_recordset(items) as supplied(chunk_id uuid)
  where ch.chunk_id = supplied.chunk_id
    and ch.embedding is not null;

  return committed;
end;
$$;

-- A provider outage must not consume a chunk's retry budget. The worker returns
-- its lease and, when the failure was retryable, the attempt it spent.
create or replace function public.learning_release_embedding_work(
  operation_token text,
  chunk_ids jsonb,
  retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  released integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'knowledge.embedding.worker',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if jsonb_typeof(chunk_ids) <> 'array'
    or jsonb_array_length(chunk_ids) > 64
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_release_batch');
  end if;

  update public.learning_chunks ch
  set embedding_lease_owner = null,
      embedding_lease_expires_at = null,
      embedding_attempts = case
        when coalesce(retryable, true)
          then greatest(0, ch.embedding_attempts - 1)
        else ch.embedding_attempts
      end
  from jsonb_to_recordset(chunk_ids) as supplied(chunk_id uuid)
  where ch.chunk_id = supplied.chunk_id
    and ch.embedding is null;
  get diagnostics released = row_count;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'released', released
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.learning_publish_course(uuid, text)
  from public, anon, service_role;
grant execute on function public.learning_publish_course(uuid, text)
  to authenticated;

revoke execute on function public.learning_project_course_knowledge(
  uuid, text, boolean
) from public, anon, service_role;
grant execute on function public.learning_project_course_knowledge(
  uuid, text, boolean
) to authenticated;

revoke execute on function public.learning_course_knowledge_state(uuid)
  from public, anon, service_role;
grant execute on function public.learning_course_knowledge_state(uuid)
  to authenticated;

-- The worker entrypoints are reachable without a session and authorised only by
-- the operation secret, so `authenticated` is deliberately not granted: a signed
-- in browser must never be able to reach the embedding queue at all.
revoke execute on function public.learning_claim_embedding_work(text, integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_commit_embedding_work(
  text, jsonb, text, text
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_release_embedding_work(
  text, jsonb, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.learning_claim_embedding_work(text, integer)
  to anon, service_role;
grant execute on function public.learning_commit_embedding_work(
  text, jsonb, text, text
) to anon, service_role;
grant execute on function public.learning_release_embedding_work(
  text, jsonb, boolean
) to anon, service_role;

commit;
