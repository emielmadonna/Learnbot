-- ============================================================
-- 20260731071000_publish_imported_source_courses.sql
-- Let a course whose content came from a connector actually be published.
--
-- THE GAP THIS CLOSES
--
-- `public.learning_publish_course` (live definition:
-- 20260726095000_authored_content_retrieval.sql:973) refuses to publish unless
-- the course has hand-authored content:
--
--     if not exists (
--       select 1 from public.content_blocks cb
--       join public.lessons l on ...
--       where cb.course_id = target_course_id and ...
--     ) then
--       raise check_violation using message = 'Course has no publishable content';
--
-- That gate is correct for its original world, where the only way content
-- entered a course was someone writing a lesson. It is wrong for a source
-- connector.
--
-- `learning_create_source_course`
-- (20260731022436_blank_workspace_source_courses.sql:87) creates the
-- destination course as `'draft'` and deliberately writes no modules, no
-- lessons and no content blocks. `app_private.project_learning_source_connector`
-- (20260730143000_learning_source_connectors.sql) then writes
-- `learning_sources`, `learning_documents` and `learning_chunks`, publishes the
-- knowledge version (:888) and points the course at it (:892-898) -- and
-- pointedly does not touch `courses.status`, because publishing is a person's
-- decision, not an importer's.
--
-- So a YouTube or Circle import into a NEW course produced a fully built,
-- fully embedded, correctly activated knowledge version attached to a course
-- that could never leave `draft`. Retrieval requires `c.status = 'published'`
-- (20260726093000_widget_delivery.sql:681, and the lexical twin
-- 0020_grounded_lexical_retrieval.sql:108), so the imported content was
-- permanently unanswerable by both the signed-in assistant and the widget,
-- while the connector panel reported it as ready.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
--
-- The gate now asks the question it always meant to ask -- "is there anything
-- here to answer from?" -- instead of "did a human type it". Authored content
-- still qualifies exactly as before. Imported knowledge qualifies when it is
-- live, published, and actually the course's ACTIVE version, which is the same
-- triple retrieval itself requires; a stale or retired import does not unlock
-- a publish.
--
-- Publishing stays a deliberate, authored-gate-guarded act by a person with
-- author access. The connector still does not publish anything on its own.
--
-- WHY THE AUTHORED PROJECTION IS SKIPPED FOR AN IMPORT-ONLY COURSE
--
-- `app_private.knowledge_project_course` chunks published lessons. For a
-- course with none it would mint a new knowledge version containing zero
-- documents on every publish, forever incrementing `version_number` and
-- leaving inert rows behind. It would not corrupt anything -- its
-- `active_is_imported` guard (20260726095000:706-713) already refuses to
-- activate an authored projection over an imported one -- but it is pure
-- noise. So the projection runs only when there is authored content to
-- project, and an import-only publish reports the imported version's real
-- state instead, in the same shape the projection's unchanged-path returns.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The imported-knowledge state, in the projection result's own shape.
--
--    Mirrors the early-return branch of app_private.knowledge_project_course
--    (20260726095000:597-617) key for key, so a caller reading `knowledge`
--    from a publish result does not have to know which path produced it.
-- ---------------------------------------------------------------------------
create or replace function app_private.knowledge_active_version_state(
  target_tenant_id uuid,
  target_course_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce((
    select jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'changed', false,
      'activated', true,
      'knowledgeVersionId', kv.knowledge_version_id,
      'versionNumber', kv.version_number,
      'contentHash', kv.content_hash,
      'documentCount', (
        select count(*)::integer
        from public.learning_documents d
        where d.tenant_id = target_tenant_id
          and d.knowledge_version_id = kv.knowledge_version_id
          and d.deleted_at is null
      ),
      'chunkCount', chunks.total,
      'reusedEmbeddingCount', chunks.total - chunks.pending,
      'pendingEmbeddingCount', chunks.pending,
      'retrievable', chunks.total > 0
    )
    from public.courses c
    join public.knowledge_versions kv
      on kv.tenant_id = c.tenant_id
     and kv.knowledge_version_id = c.active_knowledge_version_id
    cross join lateral (
      select
        count(*)::integer as total,
        count(*) filter (where ch.embedding is null)::integer as pending
      from public.learning_chunks ch
      where ch.tenant_id = target_tenant_id
        and ch.course_id = target_course_id
        and ch.knowledge_version_id = kv.knowledge_version_id
        and ch.deleted_at is null
    ) as chunks
    where c.tenant_id = target_tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
      and kv.deleted_at is null
  ), jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'changed', false,
    'activated', false,
    'chunkCount', 0,
    'retrievable', false
  ));
$$;
revoke execute on function app_private.knowledge_active_version_state(
  uuid, uuid
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The publisher. Identical to 20260726095000:973 apart from the gate and
--    the conditional projection called out in the header.
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
  has_authored_content boolean;
  has_imported_knowledge boolean;
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

  -- Unchanged: a hand-authored lesson with at least one live block.
  has_authored_content := exists (
    select 1
    from public.content_blocks cb
    join public.lessons l
      on l.tenant_id = cb.tenant_id
     and l.lesson_id = cb.lesson_id
    where cb.tenant_id = caller.tenant_id
      and cb.course_id = target_course_id
      and cb.deleted_at is null
      and l.deleted_at is null
  );

  -- New: content that arrived through a connector or an upload import. The
  -- predicate is the retrieval predicate minus `courses.status`, which is the
  -- very thing this call is about to set -- so "publishable" here means
  -- exactly "will be retrievable the moment this commits", and nothing weaker.
  has_imported_knowledge := exists (
    select 1
    from public.courses c
    join public.knowledge_versions kv
      on kv.tenant_id = c.tenant_id
     and kv.knowledge_version_id = c.active_knowledge_version_id
    join public.learning_chunks ch
      on ch.tenant_id = kv.tenant_id
     and ch.knowledge_version_id = kv.knowledge_version_id
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
      and kv.deleted_at is null
      and kv.status = 'published'
      and ch.course_id = target_course_id
      and ch.deleted_at is null
  );

  if not has_authored_content and not has_imported_knowledge then
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
  -- that says "published" and answers nothing. For an import-only course there
  -- is nothing to project and the imported version is already active, so the
  -- same guarantee is met by reporting it rather than by rebuilding it.
  if has_authored_content then
    projection := app_private.knowledge_project_course(
      caller.tenant_id,
      target_course_id,
      caller.actor_type,
      caller.identity_role,
      idempotency_key,
      false
    );
  else
    projection := app_private.knowledge_active_version_state(
      caller.tenant_id,
      target_course_id
    );
  end if;

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

-- Restated for the same reason as in 20260731070000: `create or replace`
-- preserves the ACL, but a future definition that creates the function fresh
-- would open PUBLIC execute by default, and this file should close that.
revoke execute on function public.learning_publish_course(uuid, text)
  from public, anon, service_role;
grant execute on function public.learning_publish_course(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stop the connector from reporting an unanswerable import as answerable.
--
--    `app_private.project_learning_source_connector` returns
--    `'retrievable', chunk_count > 0` (20260730143000:971, and the unchanged-
--    sync early return at :635) with `'activationBlockedReason', null`. Both
--    are true statements about the knowledge version and false statements
--    about the assistant: retrieval also requires `courses.status =
--    'published'` (20260726093000:681). The connector panel renders that field
--    verbatim as "Answerable now"
--    (components/sections/source-connectors.tsx), so importing into a draft
--    course -- the default for a blank workspace, which is exactly the case
--    20260731022436 was written for -- reported success for content nobody
--    could ever retrieve.
--
--    The projector itself is left alone: it is ~600 lines and its job is to
--    build knowledge, not to know about publication. The correction belongs in
--    the wrapper that is already the only PostgREST-visible surface, which is
--    four lines long and is where the destination course's status is cheap to
--    read.
-- ---------------------------------------------------------------------------
create or replace function public.learning_source_connector_sync(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  target_course_id uuid,
  source_kind text,
  external_ref text,
  source_name text,
  source_configuration jsonb,
  source_documents jsonb,
  source_content_hash text,
  replace_active_knowledge boolean,
  requested_idempotency_key text,
  source_credential_vault_ref text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  with projected as (
    select app_private.project_learning_source_connector(
      caller_auth_user_id, target_tenant_id, target_course_id, source_kind,
      external_ref, source_name, source_configuration, source_documents,
      source_content_hash, replace_active_knowledge,
      requested_idempotency_key, source_credential_vault_ref
    ) as result
  )
  select case
    -- A refusal is passed through byte for byte.
    when coalesce((projected.result ->> 'ok')::boolean, false) is not true
      then projected.result
    when exists (
      select 1
      from public.courses c
      where c.tenant_id = target_tenant_id
        and c.course_id = target_course_id
        and c.deleted_at is null
        and c.status = 'published'
    ) then projected.result
    -- Everything the projector measured is preserved; only the two claims
    -- about answerability are corrected, and the reason is named so the panel
    -- can say what to do about it rather than just "not yet".
    else projected.result || jsonb_build_object(
      'retrievable', false,
      'activationBlockedReason', 'course_not_published'
    )
  end
  from projected;
$$;

revoke execute on function public.learning_source_connector_sync(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.learning_source_connector_sync(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) to service_role;

commit;
