-- Durable, tenant-private visual knowledge.
--
-- Raster files remain in the existing private tenant bucket. This table owns
-- the searchable and accessible metadata; object paths never become public
-- URLs and are returned only to the application server for short-lived signing.
--
-- An active, answer-enabled visual is projected as one ordinary
-- learning_document + learning_chunk in an atomically built successor knowledge
-- version. The existing lexical, hybrid, embedding-worker and widget retrieval
-- paths therefore all see the same description without a second search system.

begin;

create table public.visual_knowledge_assets (
  visual_asset_id uuid primary key,
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  description text not null
    check (length(btrim(description)) between 3 and 2000),
  alt_text text not null check (length(btrim(alt_text)) between 3 and 500),
  show_in_answers boolean not null default true,
  file_name text not null check (length(btrim(file_name)) between 1 and 255),
  media_type text not null
    check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  object_key text not null check (length(object_key) between 1 and 1024),
  status text not null default 'pending_upload'
    check (status in ('pending_upload', 'active', 'archived')),
  usage_count bigint not null default 0 check (usage_count >= 0),
  uploaded_by uuid not null,
  upload_expires_at timestamptz not null,
  archived_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  unique (tenant_id, visual_asset_id),
  unique (tenant_id, object_key),
  unique (tenant_id, idempotency_key),
  check (object_key like tenant_id::text || '/visuals/%'),
  check (object_key not like '%..%'),
  check (
    (status = 'archived' and archived_at is not null and not show_in_answers)
    or (status <> 'archived' and archived_at is null)
  )
);

create index visual_knowledge_assets_course_status_idx
  on public.visual_knowledge_assets (
    tenant_id, course_id, status, updated_at desc
  );
create index visual_knowledge_assets_answerable_idx
  on public.visual_knowledge_assets (tenant_id, course_id)
  where status = 'active' and show_in_answers;

-- Usage is telemetry, not an author edit. Keep optimistic-edit versions stable
-- when an answer increments usage_count, while every metadata/lifecycle change
-- still advances the record version.
create or replace function app_private.visual_asset_set_version()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if (
    new.course_id,
    new.title,
    new.description,
    new.alt_text,
    new.show_in_answers,
    new.file_name,
    new.media_type,
    new.size_bytes,
    new.object_key,
    new.status,
    new.uploaded_by,
    new.upload_expires_at,
    new.archived_at
  ) is distinct from (
    old.course_id,
    old.title,
    old.description,
    old.alt_text,
    old.show_in_answers,
    old.file_name,
    old.media_type,
    old.size_bytes,
    old.object_key,
    old.status,
    old.uploaded_by,
    old.upload_expires_at,
    old.archived_at
  ) then
    new.updated_at := now();
    new.record_version := old.record_version + 1;
  else
    new.updated_at := old.updated_at;
    new.record_version := old.record_version;
  end if;
  return new;
end;
$$;
revoke execute on function app_private.visual_asset_set_version()
  from public, anon, authenticated, service_role;

create trigger visual_knowledge_assets_set_version
before update on public.visual_knowledge_assets
for each row execute function app_private.visual_asset_set_version();

alter table public.visual_knowledge_assets enable row level security;
alter table public.visual_knowledge_assets force row level security;
revoke all on table public.visual_knowledge_assets
  from public, anon, authenticated, service_role;

-- The browser never queries this table directly. All mutations go through the
-- tenant-bound RPCs below; the policy remains as defence in depth.
create policy visual_knowledge_assets_deny_direct
  on public.visual_knowledge_assets for all to authenticated
  using (false) with check (false);

-- A private object may be signed only when its metadata is visible to this
-- verified tenant principal. Authors may preview all visuals in their tenant;
-- students may read only active answer-enabled visuals from published courses.
create or replace function app_private.visual_storage_read_allowed(
  candidate_object_key text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from app_private.learning_rpc_context() caller
    join public.visual_knowledge_assets visual
      on visual.tenant_id = caller.tenant_id
     and visual.object_key = candidate_object_key
    join public.courses course
      on course.tenant_id = visual.tenant_id
     and course.course_id = visual.course_id
     and course.deleted_at is null
    where visual.status <> 'archived'
      and (
        caller.identity_role in (
          'tenant_owner', 'tenant_admin', 'creator', 'teacher'
        )
        or (
          caller.identity_role = 'student'
          and visual.status = 'active'
          and visual.show_in_answers
          and course.status = 'published'
        )
      )
  );
$$;
revoke execute on function app_private.visual_storage_read_allowed(text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.visual_storage_read_allowed(text)
  to authenticated;

drop policy if exists tenant_private_visual_select on storage.objects;
create policy tenant_private_visual_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-private'
    and (storage.foldername(name))[2] = 'visuals'
    and app_private.visual_storage_read_allowed(name)
  );

-- Remove prior retrieval rows synchronously when a visual is archived or
-- disabled, so it cannot survive in answers after the metadata change.
create or replace function app_private.visual_deactivate_projection(
  target_tenant_id uuid,
  target_visual_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.learning_chunks chunk
  set deleted_at = coalesce(chunk.deleted_at, now())
  where chunk.tenant_id = target_tenant_id
    and chunk.metadata ->> 'visualAssetId' = target_visual_asset_id::text
    and chunk.deleted_at is null;

  update public.learning_documents document
  set
    status = 'deleted',
    deleted_at = coalesce(document.deleted_at, now())
  where document.tenant_id = target_tenant_id
    and document.metadata ->> 'visualAssetId' = target_visual_asset_id::text
    and document.deleted_at is null;
end;
$$;
revoke execute on function app_private.visual_deactivate_projection(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Project one visual into the current knowledge version. If the course has not
-- been projected yet, metadata remains active and the course trigger below
-- projects it automatically when a version becomes active.
create or replace function app_private.visual_project_asset(
  target_tenant_id uuid,
  target_visual_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  visual public.visual_knowledge_assets%rowtype;
  course record;
  source_id uuid;
  document_id uuid;
  prior_chunk record;
  body text;
  body_hash text;
begin
  select asset.* into visual
  from public.visual_knowledge_assets asset
  where asset.tenant_id = target_tenant_id
    and asset.visual_asset_id = target_visual_asset_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;

  if visual.status <> 'active' or not visual.show_in_answers then
    perform app_private.visual_deactivate_projection(
      target_tenant_id, target_visual_asset_id
    );
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'projected', false
    );
  end if;

  select
    c.title,
    c.external_id,
    c.active_knowledge_version_id
  into course
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = visual.course_id
    and c.deleted_at is null;
  if not found or course.active_knowledge_version_id is null then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'projected', false,
      'reason', 'course_not_projected'
    );
  end if;

  insert into public.learning_sources (
    tenant_id,
    course_id,
    source_type,
    name,
    status,
    external_ref,
    configuration,
    last_synced_at,
    idempotency_key
  ) values (
    target_tenant_id,
    visual.course_id,
    'api',
    left(coalesce(course.title, 'Course'), 140) || ' visual knowledge',
    'ready',
    'visuals:' || visual.course_id::text,
    jsonb_build_object(
      'projector', 'visual_knowledge_manager',
      'projectorVersion', 1
    ),
    now(),
    'visual-source:' || visual.course_id::text
  )
  on conflict (tenant_id, course_id, source_type, external_ref) do update
    set status = 'ready',
        last_synced_at = now()
  returning learning_sources.source_id into source_id;

  body := concat_ws(
    E'\n\n',
    concat_ws(
      ' · ',
      nullif(btrim(coalesce(course.title, '')), ''),
      'Visual knowledge',
      btrim(visual.title)
    ),
    btrim(visual.description),
    'Alt text: ' || btrim(visual.alt_text)
  );
  body_hash := encode(extensions.digest(body, 'sha256'), 'hex');

  select
    chunk.embedding,
    chunk.embedding_provider_key,
    chunk.embedding_model_key,
    chunk.embedding_dimensions
  into prior_chunk
  from public.learning_chunks chunk
  where chunk.tenant_id = target_tenant_id
    and chunk.content_hash = body_hash
    and chunk.embedding is not null
  order by chunk.updated_at desc, chunk.chunk_id
  limit 1;

  insert into public.learning_documents (
    tenant_id,
    course_id,
    source_id,
    knowledge_version_id,
    external_id,
    title,
    media_type,
    language,
    raw_storage_key,
    content_hash,
    status,
    metadata,
    idempotency_key
  ) values (
    target_tenant_id,
    visual.course_id,
    source_id,
    course.active_knowledge_version_id,
    'visual:' || visual.visual_asset_id::text,
    visual.title,
    visual.media_type,
    'en',
    visual.object_key,
    body_hash,
    'ready',
    jsonb_build_object(
      'projector', 'visual_knowledge_manager',
      'visualAssetId', visual.visual_asset_id,
      'visualTitle', visual.title,
      'visualAltText', visual.alt_text
    ),
    'visual-document:' || course.active_knowledge_version_id::text || ':'
      || visual.visual_asset_id::text
  )
  on conflict (
    tenant_id, knowledge_version_id, source_id, external_id
  ) do update
    set
      title = excluded.title,
      media_type = excluded.media_type,
      raw_storage_key = excluded.raw_storage_key,
      content_hash = excluded.content_hash,
      status = 'ready',
      metadata = excluded.metadata,
      deleted_at = null
  returning learning_documents.document_id into document_id;

  insert into public.learning_chunks (
    tenant_id,
    course_id,
    knowledge_version_id,
    document_id,
    ordinal,
    body,
    token_count,
    content_hash,
    embedding,
    embedding_provider_key,
    embedding_model_key,
    embedding_dimensions,
    metadata,
    idempotency_key
  ) values (
    target_tenant_id,
    visual.course_id,
    course.active_knowledge_version_id,
    document_id,
    0,
    body,
    ceil(length(body) / 4.0)::integer,
    body_hash,
    prior_chunk.embedding,
    prior_chunk.embedding_provider_key,
    prior_chunk.embedding_model_key,
    prior_chunk.embedding_dimensions,
    jsonb_build_object(
      'courseSlug', coalesce(course.external_id, visual.course_id::text),
      'courseName', course.title,
      'sectionName', 'Visual knowledge',
      -- The established retrieval envelope exposes lessonId/lessonName. For a
      -- course-scoped visual these carry the visual identity/title, while the
      -- explicit visual fields keep the stored metadata unambiguous.
      'lessonId', visual.visual_asset_id,
      'lessonName', visual.title,
      'visualAssetId', visual.visual_asset_id,
      'visualTitle', visual.title,
      'visualAltText', visual.alt_text,
      'projector', 'visual_knowledge_manager',
      'projectorVersion', 1
    ),
    'visual-chunk:' || course.active_knowledge_version_id::text || ':'
      || visual.visual_asset_id::text
  )
  on conflict (
    tenant_id, knowledge_version_id, document_id, ordinal
  ) do update
    set
      body = excluded.body,
      token_count = excluded.token_count,
      embedding = case
        when public.learning_chunks.content_hash = excluded.content_hash
          then public.learning_chunks.embedding
        else excluded.embedding
      end,
      embedding_provider_key = case
        when public.learning_chunks.content_hash = excluded.content_hash
          then public.learning_chunks.embedding_provider_key
        else excluded.embedding_provider_key
      end,
      embedding_model_key = case
        when public.learning_chunks.content_hash = excluded.content_hash
          then public.learning_chunks.embedding_model_key
        else excluded.embedding_model_key
      end,
      embedding_dimensions = case
        when public.learning_chunks.content_hash = excluded.content_hash
          then public.learning_chunks.embedding_dimensions
        else excluded.embedding_dimensions
      end,
      content_hash = excluded.content_hash,
      metadata = excluded.metadata,
      deleted_at = null;

  update public.learning_chunks chunk
  set deleted_at = coalesce(chunk.deleted_at, now())
  where chunk.tenant_id = target_tenant_id
    and chunk.metadata ->> 'visualAssetId' = visual.visual_asset_id::text
    and chunk.knowledge_version_id <> course.active_knowledge_version_id
    and chunk.deleted_at is null;
  update public.learning_documents document
  set
    status = 'deleted',
    deleted_at = coalesce(document.deleted_at, now())
  where document.tenant_id = target_tenant_id
    and document.metadata ->> 'visualAssetId' = visual.visual_asset_id::text
    and document.knowledge_version_id <> course.active_knowledge_version_id
    and document.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'projected', true,
    'knowledgeVersionId', course.active_knowledge_version_id,
    'documentId', document_id,
    'contentHash', body_hash
  );
end;
$$;
revoke execute on function app_private.visual_project_asset(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.visual_reproject_course_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  visual record;
begin
  if new.active_knowledge_version_id is distinct from old.active_knowledge_version_id
    and new.active_knowledge_version_id is not null
  then
    for visual in
      select asset.visual_asset_id
      from public.visual_knowledge_assets asset
      where asset.tenant_id = new.tenant_id
        and asset.course_id = new.course_id
        and asset.status = 'active'
        and asset.show_in_answers
    loop
      perform app_private.visual_project_asset(
        new.tenant_id, visual.visual_asset_id
      );
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function app_private.visual_reproject_course_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists courses_reproject_visual_knowledge
  on public.courses;
create trigger courses_reproject_visual_knowledge
after update of active_knowledge_version_id on public.courses
for each row execute function app_private.visual_reproject_course_trigger();

-- Visual metadata changes never edit a published knowledge version in place.
-- Instead, rebuild a complete successor by cloning the current non-visual
-- corpus and adding the current answer-enabled visual set while the new version
-- is still `building`. Only after it is complete is the course pointer flipped.
create or replace function app_private.visual_insert_into_version(
  target_tenant_id uuid,
  target_visual_asset_id uuid,
  target_knowledge_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  visual public.visual_knowledge_assets%rowtype;
  course record;
  source_id uuid;
  document_id uuid;
  prior_chunk record;
  body text;
  body_hash text;
begin
  select asset.* into visual
  from public.visual_knowledge_assets asset
  where asset.tenant_id = target_tenant_id
    and asset.visual_asset_id = target_visual_asset_id
    and asset.status = 'active'
    and asset.show_in_answers;
  if not found then
    return jsonb_build_object('ok', true, 'projected', false);
  end if;

  select c.title, c.external_id into course
  from public.courses c
  join public.knowledge_versions version
    on version.tenant_id = c.tenant_id
   and version.course_id = c.course_id
   and version.knowledge_version_id = target_knowledge_version_id
   and version.status = 'building'
  where c.tenant_id = target_tenant_id
    and c.course_id = visual.course_id
    and c.deleted_at is null;
  if not found then
    raise exception 'visual projection target is not a building course version';
  end if;

  insert into public.learning_sources (
    tenant_id, course_id, source_type, name, status, external_ref,
    configuration, last_synced_at, idempotency_key
  ) values (
    target_tenant_id,
    visual.course_id,
    'api',
    left(coalesce(course.title, 'Course'), 140) || ' visual knowledge',
    'ready',
    'visuals:' || visual.course_id::text,
    jsonb_build_object(
      'projector', 'visual_knowledge_manager',
      'projectorVersion', 2
    ),
    now(),
    'visual-source:' || visual.course_id::text
  )
  on conflict (tenant_id, course_id, source_type, external_ref) do update
    set status = 'ready',
        last_synced_at = now()
  returning learning_sources.source_id into source_id;

  body := concat_ws(
    E'\n\n',
    concat_ws(
      ' · ',
      nullif(btrim(coalesce(course.title, '')), ''),
      'Visual knowledge',
      btrim(visual.title)
    ),
    btrim(visual.description),
    'Alt text: ' || btrim(visual.alt_text)
  );
  body_hash := encode(extensions.digest(body, 'sha256'), 'hex');

  select
    chunk.embedding,
    chunk.embedding_provider_key,
    chunk.embedding_model_key,
    chunk.embedding_dimensions
  into prior_chunk
  from public.learning_chunks chunk
  where chunk.tenant_id = target_tenant_id
    and chunk.content_hash = body_hash
    and chunk.embedding is not null
  order by chunk.updated_at desc, chunk.chunk_id
  limit 1;

  insert into public.learning_documents (
    tenant_id, course_id, source_id, knowledge_version_id, external_id,
    title, media_type, language, raw_storage_key, content_hash, status,
    metadata, idempotency_key
  ) values (
    target_tenant_id,
    visual.course_id,
    source_id,
    target_knowledge_version_id,
    'visual:' || visual.visual_asset_id::text,
    visual.title,
    visual.media_type,
    'en',
    visual.object_key,
    body_hash,
    'ready',
    jsonb_build_object(
      'projector', 'visual_knowledge_manager',
      'projectorVersion', 2,
      'visualAssetId', visual.visual_asset_id,
      'visualTitle', visual.title,
      'visualAltText', visual.alt_text
    ),
    'visual-document:' || target_knowledge_version_id::text || ':'
      || visual.visual_asset_id::text
  )
  returning learning_documents.document_id into document_id;

  insert into public.learning_chunks (
    tenant_id, course_id, knowledge_version_id, document_id, ordinal, body,
    token_count, content_hash, embedding, embedding_provider_key,
    embedding_model_key, embedding_dimensions, metadata, idempotency_key
  ) values (
    target_tenant_id,
    visual.course_id,
    target_knowledge_version_id,
    document_id,
    0,
    body,
    ceil(length(body) / 4.0)::integer,
    body_hash,
    prior_chunk.embedding,
    prior_chunk.embedding_provider_key,
    prior_chunk.embedding_model_key,
    prior_chunk.embedding_dimensions,
    jsonb_build_object(
      'courseSlug', coalesce(course.external_id, visual.course_id::text),
      'courseName', course.title,
      'sectionName', 'Visual knowledge',
      'lessonId', visual.visual_asset_id,
      'lessonName', visual.title,
      'visualAssetId', visual.visual_asset_id,
      'visualTitle', visual.title,
      'visualAltText', visual.alt_text,
      'projector', 'visual_knowledge_manager',
      'projectorVersion', 2
    ),
    'visual-chunk:' || target_knowledge_version_id::text || ':'
      || visual.visual_asset_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'projected', true,
    'documentId', document_id,
    'contentHash', body_hash
  );
end;
$$;
revoke execute on function app_private.visual_insert_into_version(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function app_private.visual_rebuild_course(
  target_tenant_id uuid,
  target_course_id uuid,
  caller_actor_type text,
  caller_actor_role text,
  command_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  course record;
  active_version record;
  previous_document record;
  cloned_document_id uuid;
  visual record;
  next_manifest jsonb;
  visual_fingerprint text;
  next_hash text;
  next_version_number integer;
  next_version_id uuid;
  visual_count integer := 0;
begin
  select c.* into course
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'course_not_found');
  end if;
  if course.active_knowledge_version_id is null then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'projected', false,
      'reason', 'course_not_projected'
    );
  end if;

  select version.* into active_version
  from public.knowledge_versions version
  where version.tenant_id = target_tenant_id
    and version.course_id = target_course_id
    and version.knowledge_version_id = course.active_knowledge_version_id
    and version.status = 'published';
  if not found then
    raise exception 'active course knowledge version is not published';
  end if;

  select coalesce(
    jsonb_agg(item.entry order by item.ordinal),
    '[]'::jsonb
  ) into next_manifest
  from jsonb_array_elements(active_version.source_manifest)
    with ordinality as item(entry, ordinal)
  where item.entry ->> 'kind' is distinct from 'visual_knowledge';
  next_manifest := next_manifest || jsonb_build_array(jsonb_build_object(
    'source', 'visuals:' || target_course_id::text,
    'kind', 'visual_knowledge',
    'projectorVersion', 2
  ));

  select coalesce(
    string_agg(
      asset.visual_asset_id::text || chr(30)
        || asset.record_version::text || chr(30)
        || asset.title || chr(30)
        || asset.description || chr(30)
        || asset.alt_text,
      chr(31) order by asset.visual_asset_id
    ),
    'no-answer-enabled-visuals'
  ) into visual_fingerprint
  from public.visual_knowledge_assets asset
  where asset.tenant_id = target_tenant_id
    and asset.course_id = target_course_id
    and asset.status = 'active'
    and asset.show_in_answers;
  next_hash := encode(
    extensions.digest(
      coalesce(active_version.content_hash, '') || chr(31)
        || visual_fingerprint,
      'sha256'
    ),
    'hex'
  );

  select coalesce(max(version.version_number), 0) + 1
    into next_version_number
  from public.knowledge_versions version
  where version.tenant_id = target_tenant_id
    and version.course_id = target_course_id;

  insert into public.knowledge_versions (
    tenant_id, course_id, version_number, status, source_manifest,
    content_hash, embedding_provider_key, embedding_model_key,
    embedding_dimensions, built_by, supersedes_version_id, idempotency_key
  ) values (
    target_tenant_id,
    target_course_id,
    next_version_number,
    'building',
    next_manifest,
    next_hash,
    active_version.embedding_provider_key,
    active_version.embedding_model_key,
    active_version.embedding_dimensions,
    auth.uid(),
    active_version.knowledge_version_id,
    'visual-knowledge:' || target_course_id::text || ':'
      || next_version_number::text
  )
  returning knowledge_versions.knowledge_version_id into next_version_id;

  -- Clone the current non-visual corpus. New document identities keep the
  -- document/chunk foreign-key graph wholly inside the successor version.
  for previous_document in
    select document.*
    from public.learning_documents document
    where document.tenant_id = target_tenant_id
      and document.course_id = target_course_id
      and document.knowledge_version_id =
        active_version.knowledge_version_id
      and document.deleted_at is null
      and document.status = 'ready'
      and document.metadata ->> 'projector'
        is distinct from 'visual_knowledge_manager'
    order by document.document_id
  loop
    insert into public.learning_documents (
      tenant_id, course_id, source_id, knowledge_version_id, external_id,
      title, media_type, language, raw_storage_key, extracted_storage_key,
      content_hash, status, metadata, idempotency_key
    ) values (
      target_tenant_id,
      target_course_id,
      previous_document.source_id,
      next_version_id,
      previous_document.external_id,
      previous_document.title,
      previous_document.media_type,
      previous_document.language,
      previous_document.raw_storage_key,
      previous_document.extracted_storage_key,
      previous_document.content_hash,
      'ready',
      previous_document.metadata,
      'visual-copy-document:' || next_version_id::text || ':'
        || previous_document.document_id::text
    )
    returning learning_documents.document_id into cloned_document_id;

    insert into public.learning_chunks (
      tenant_id, course_id, knowledge_version_id, document_id, ordinal, body,
      token_count, content_hash, embedding, embedding_provider_key,
      embedding_model_key, embedding_dimensions, metadata, idempotency_key
    )
    select
      target_tenant_id,
      target_course_id,
      next_version_id,
      cloned_document_id,
      chunk.ordinal,
      chunk.body,
      chunk.token_count,
      chunk.content_hash,
      chunk.embedding,
      chunk.embedding_provider_key,
      chunk.embedding_model_key,
      chunk.embedding_dimensions,
      chunk.metadata,
      'visual-copy-chunk:' || next_version_id::text || ':'
        || chunk.chunk_id::text
    from public.learning_chunks chunk
    where chunk.tenant_id = target_tenant_id
      and chunk.course_id = target_course_id
      and chunk.knowledge_version_id = active_version.knowledge_version_id
      and chunk.document_id = previous_document.document_id
      and chunk.deleted_at is null
    order by chunk.ordinal, chunk.chunk_id;
  end loop;

  for visual in
    select asset.visual_asset_id
    from public.visual_knowledge_assets asset
    where asset.tenant_id = target_tenant_id
      and asset.course_id = target_course_id
      and asset.status = 'active'
      and asset.show_in_answers
    order by asset.visual_asset_id
  loop
    perform app_private.visual_insert_into_version(
      target_tenant_id, visual.visual_asset_id, next_version_id
    );
    visual_count := visual_count + 1;
  end loop;

  update public.knowledge_versions version
  set status = 'published',
      published_at = now()
  where version.tenant_id = target_tenant_id
    and version.knowledge_version_id = next_version_id;

  update public.courses c
  set active_knowledge_version_id = next_version_id
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id;

  -- Only our previous composite is retired. The authored/imported base remains
  -- immutable and available for its own lineage/audit history.
  if active_version.source_manifest
    @> '[{"kind": "visual_knowledge"}]'::jsonb
  then
    update public.knowledge_versions version
    set status = 'retired'
    where version.tenant_id = target_tenant_id
      and version.knowledge_version_id = active_version.knowledge_version_id;
    update public.learning_chunks chunk
    set deleted_at = coalesce(chunk.deleted_at, now())
    where chunk.tenant_id = target_tenant_id
      and chunk.knowledge_version_id = active_version.knowledge_version_id
      and chunk.deleted_at is null;
    update public.learning_documents document
    set status = 'deleted',
        deleted_at = coalesce(document.deleted_at, now())
    where document.tenant_id = target_tenant_id
      and document.knowledge_version_id =
        active_version.knowledge_version_id
      and document.deleted_at is null;
  end if;

  perform app_private.authoring_append_audit(
    target_tenant_id,
    coalesce(caller_actor_type, 'system'),
    caller_actor_role,
    'learning.visual.knowledge.project',
    target_course_id::text,
    command_id,
    active_version.content_hash,
    next_hash,
    next_version_id::text
  );
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'projected', true,
    'knowledgeVersionId', next_version_id,
    'versionNumber', next_version_number,
    'contentHash', next_hash,
    'visualCount', visual_count
  );
end;
$$;
revoke execute on function app_private.visual_rebuild_course(
  uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;

-- Replace the earlier single-row projector with the version-safe projector.
create or replace function app_private.visual_project_asset(
  target_tenant_id uuid,
  target_visual_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  asset record;
  actor_type text;
begin
  select visual.course_id, visual.record_version into asset
  from public.visual_knowledge_assets visual
  where visual.tenant_id = target_tenant_id
    and visual.visual_asset_id = target_visual_asset_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;
  select * into caller from app_private.learning_rpc_context();
  actor_type := case
    when caller.identity_role in ('tenant_owner', 'tenant_admin')
      then 'owner'
    when caller.identity_role in ('creator', 'teacher')
      then 'creator'
    else 'system'
  end;
  return app_private.visual_rebuild_course(
    target_tenant_id,
    asset.course_id,
    actor_type,
    caller.identity_role,
    'visual-project:' || target_visual_asset_id::text || ':'
      || asset.record_version::text
  );
end;
$$;
revoke execute on function app_private.visual_project_asset(uuid, uuid)
  from public, anon, authenticated, service_role;

-- A publish may replace the whole active corpus. Reprojection is deferred to
-- transaction end so the authored/import pipeline finishes its own retirement
-- and audit work first; the second pointer change is ignored because the
-- successor manifest already carries the visual-knowledge marker.
create or replace function app_private.visual_reproject_course_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  active_manifest jsonb;
begin
  if new.active_knowledge_version_id is not distinct from
      old.active_knowledge_version_id
    or new.active_knowledge_version_id is null
  then
    return new;
  end if;
  select version.source_manifest into active_manifest
  from public.knowledge_versions version
  where version.tenant_id = new.tenant_id
    and version.course_id = new.course_id
    and version.knowledge_version_id = new.active_knowledge_version_id
    and version.status = 'published';
  if not found
    or active_manifest @> '[{"kind": "visual_knowledge"}]'::jsonb
    or not exists (
      select 1
      from public.visual_knowledge_assets visual
      where visual.tenant_id = new.tenant_id
        and visual.course_id = new.course_id
        and visual.status = 'active'
        and visual.show_in_answers
    )
  then
    return new;
  end if;
  perform app_private.visual_rebuild_course(
    new.tenant_id,
    new.course_id,
    'system',
    null,
    'visual-republish:' || new.course_id::text || ':'
      || new.active_knowledge_version_id::text
  );
  return new;
end;
$$;
revoke execute on function app_private.visual_reproject_course_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists courses_reproject_visual_knowledge
  on public.courses;
create constraint trigger courses_reproject_visual_knowledge
after update on public.courses
deferrable initially deferred
for each row execute function app_private.visual_reproject_course_trigger();

-- The v1 in-place deactivation helper was needed only while constructing this
-- migration. The committed schema exposes no function capable of editing a
-- published visual projection in place.
drop function app_private.visual_deactivate_projection(uuid, uuid);

-- -------------------------------------------------------------------------
-- Author lifecycle RPCs
-- -------------------------------------------------------------------------

create or replace function public.learning_create_visual_asset(
  requested_visual_asset_id uuid,
  target_course_id uuid,
  requested_title text,
  requested_description text,
  requested_alt_text text,
  requested_show_in_answers boolean,
  requested_file_name text,
  requested_media_type text,
  requested_size_bytes bigint,
  requested_object_key text,
  requested_upload_expires_at timestamptz,
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  expected_prefix text;
  asset public.visual_knowledge_assets%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_visual_asset_id is null
    or target_course_id is null
    or length(btrim(coalesce(requested_title, ''))) not between 1 and 160
    or length(btrim(coalesce(requested_description, ''))) not between 3 and 2000
    or length(btrim(coalesce(requested_alt_text, ''))) not between 3 and 500
    or length(btrim(coalesce(requested_file_name, ''))) not between 1 and 255
    or requested_media_type not in ('image/png', 'image/jpeg', 'image/webp')
    or requested_size_bytes not between 1 and 20971520
    or requested_upload_expires_at <= now() + interval '5 minutes'
    or requested_upload_expires_at > now() + interval '2 hours 5 minutes'
    or length(coalesce(requested_idempotency_key, '')) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1
    from public.courses course
    where course.tenant_id = caller.tenant_id
      and course.course_id = target_course_id
      and course.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  expected_prefix := caller.tenant_id::text
    || '/visuals/'
    || auth.uid()::text
    || '/'
    || requested_visual_asset_id::text
    || '/';
  if requested_object_key not like expected_prefix || '%'
    or requested_object_key like '%..%'
    or length(requested_object_key) > 1024
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_object_key');
  end if;

  insert into public.visual_knowledge_assets (
    visual_asset_id,
    tenant_id,
    course_id,
    title,
    description,
    alt_text,
    show_in_answers,
    file_name,
    media_type,
    size_bytes,
    object_key,
    status,
    usage_count,
    uploaded_by,
    upload_expires_at,
    idempotency_key
  ) values (
    requested_visual_asset_id,
    caller.tenant_id,
    target_course_id,
    btrim(requested_title),
    btrim(requested_description),
    btrim(requested_alt_text),
    coalesce(requested_show_in_answers, true),
    btrim(requested_file_name),
    requested_media_type,
    requested_size_bytes,
    requested_object_key,
    'pending_upload',
    0,
    auth.uid(),
    requested_upload_expires_at,
    requested_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) do nothing;

  select visual.* into asset
  from public.visual_knowledge_assets visual
  where visual.tenant_id = caller.tenant_id
    and visual.idempotency_key = requested_idempotency_key;
  if not found
    or asset.visual_asset_id <> requested_visual_asset_id
    or asset.object_key <> requested_object_key
  then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'courseId', asset.course_id,
    'status', asset.status,
    'recordVersion', asset.record_version,
    'uploadExpiresAt', asset.upload_expires_at
  );
end;
$$;

create or replace function public.learning_finalize_visual_asset(
  target_visual_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  asset public.visual_knowledge_assets%rowtype;
  object_metadata jsonb;
  observed_size bigint;
  observed_media_type text;
  projection jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select visual.* into asset
  from public.visual_knowledge_assets visual
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = target_visual_asset_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;
  if asset.status = 'active' then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'visualAssetId', asset.visual_asset_id,
      'status', asset.status,
      'recordVersion', asset.record_version
    );
  end if;
  if asset.status <> 'pending_upload'
    or asset.upload_expires_at <= now()
  then
    return jsonb_build_object('ok', false, 'code', 'upload_intent_unavailable');
  end if;

  select object.metadata into object_metadata
  from storage.objects object
  where object.bucket_id = 'tenant-private'
    and object.name = asset.object_key;
  if object_metadata is null then
    return jsonb_build_object('ok', false, 'code', 'upload_incomplete');
  end if;
  if coalesce(object_metadata ->> 'size', '') !~ '^[0-9]+$' then
    return jsonb_build_object('ok', false, 'code', 'upload_evidence_invalid');
  end if;
  observed_size := (object_metadata ->> 'size')::bigint;
  observed_media_type := lower(coalesce(object_metadata ->> 'mimetype', ''));
  if observed_size <> asset.size_bytes
    or observed_media_type <> asset.media_type
  then
    return jsonb_build_object('ok', false, 'code', 'upload_evidence_mismatch');
  end if;

  update public.visual_knowledge_assets visual
  set status = 'active'
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = asset.visual_asset_id
  returning visual.* into asset;

  projection := app_private.visual_project_asset(
    caller.tenant_id, asset.visual_asset_id
  );
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'courseId', asset.course_id,
    'status', asset.status,
    'recordVersion', asset.record_version,
    'projected', coalesce((projection ->> 'projected')::boolean, false)
  );
end;
$$;

create or replace function public.learning_update_visual_asset(
  target_visual_asset_id uuid,
  target_course_id uuid,
  requested_title text,
  requested_description text,
  requested_alt_text text,
  requested_show_in_answers boolean,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  asset public.visual_knowledge_assets%rowtype;
  projection jsonb;
  prior_course_id uuid;
  actor_type text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_visual_asset_id is null
    or target_course_id is null
    or length(btrim(coalesce(requested_title, ''))) not between 1 and 160
    or length(btrim(coalesce(requested_description, ''))) not between 3 and 2000
    or length(btrim(coalesce(requested_alt_text, ''))) not between 3 and 500
    or expected_version is null
    or expected_version < 1
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1
    from public.courses course
    where course.tenant_id = caller.tenant_id
      and course.course_id = target_course_id
      and course.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select visual.course_id into prior_course_id
  from public.visual_knowledge_assets visual
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = target_visual_asset_id
    and visual.status = 'active'
    and visual.record_version = expected_version
  for update;
  if not found then
    if exists (
      select 1
      from public.visual_knowledge_assets visual
      where visual.tenant_id = caller.tenant_id
        and visual.visual_asset_id = target_visual_asset_id
        and visual.status = 'active'
    ) then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;

  update public.visual_knowledge_assets visual
  set
    course_id = target_course_id,
    title = btrim(requested_title),
    description = btrim(requested_description),
    alt_text = btrim(requested_alt_text),
    show_in_answers = coalesce(requested_show_in_answers, false)
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = target_visual_asset_id
    and visual.status = 'active'
    and visual.record_version = expected_version
  returning visual.* into asset;
  if not found then
    if exists (
      select 1
      from public.visual_knowledge_assets visual
      where visual.tenant_id = caller.tenant_id
        and visual.visual_asset_id = target_visual_asset_id
        and visual.status = 'active'
    ) then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;

  actor_type := case
    when caller.identity_role in ('tenant_owner', 'tenant_admin')
      then 'owner'
    else 'creator'
  end;
  if prior_course_id is distinct from asset.course_id then
    perform app_private.visual_rebuild_course(
      caller.tenant_id,
      prior_course_id,
      actor_type,
      caller.identity_role,
      'visual-move-source:' || asset.visual_asset_id::text || ':'
        || asset.record_version::text
    );
  end if;
  projection := app_private.visual_project_asset(
    caller.tenant_id, asset.visual_asset_id
  );
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'courseId', asset.course_id,
    'title', asset.title,
    'description', asset.description,
    'altText', asset.alt_text,
    'showInAnswers', asset.show_in_answers,
    'status', asset.status,
    'usageCount', asset.usage_count,
    'recordVersion', asset.record_version,
    'updatedAt', asset.updated_at,
    'projected', coalesce((projection ->> 'projected')::boolean, false)
  );
end;
$$;

create or replace function public.learning_archive_visual_asset(
  target_visual_asset_id uuid,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  asset public.visual_knowledge_assets%rowtype;
  projection jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  update public.visual_knowledge_assets visual
  set
    status = 'archived',
    show_in_answers = false,
    archived_at = now()
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = target_visual_asset_id
    and visual.status in ('pending_upload', 'active')
    and visual.record_version = expected_version
  returning visual.* into asset;
  if not found then
    if exists (
      select 1
      from public.visual_knowledge_assets visual
      where visual.tenant_id = caller.tenant_id
        and visual.visual_asset_id = target_visual_asset_id
        and visual.status in ('pending_upload', 'active')
    ) then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;

  projection := app_private.visual_project_asset(
    caller.tenant_id, asset.visual_asset_id
  );
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'status', asset.status,
    'recordVersion', asset.record_version,
    'archivedAt', asset.archived_at,
    'projected', coalesce((projection ->> 'projected')::boolean, false)
  );
end;
$$;

create or replace function public.learning_list_visual_assets(
  target_course_id uuid default null,
  include_archived boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  items jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher'
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'visualAssetId', visual.visual_asset_id,
        'courseId', visual.course_id,
        'courseTitle', course.title,
        'title', visual.title,
        'description', visual.description,
        'altText', visual.alt_text,
        'showInAnswers', visual.show_in_answers,
        'fileName', visual.file_name,
        'mediaType', visual.media_type,
        'sizeBytes', visual.size_bytes,
        'status', visual.status,
        'usageCount', visual.usage_count,
        'recordVersion', visual.record_version,
        'createdAt', visual.created_at,
        'updatedAt', visual.updated_at,
        'archivedAt', visual.archived_at,
        -- Stripped by the application route after signing.
        'privateObjectKey', visual.object_key
      )
      order by
        case visual.status
          when 'pending_upload' then 0
          when 'active' then 1
          else 2
        end,
        visual.updated_at desc,
        visual.visual_asset_id
    ),
    '[]'::jsonb
  ) into items
  from public.visual_knowledge_assets visual
  join public.courses course
    on course.tenant_id = visual.tenant_id
   and course.course_id = visual.course_id
  where visual.tenant_id = caller.tenant_id
    and (target_course_id is null or visual.course_id = target_course_id)
    and (coalesce(include_archived, false) or visual.status <> 'archived');

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'items', items
  );
end;
$$;

create or replace function public.learning_get_visual_asset_for_read(
  target_visual_asset_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  asset record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  select
    visual.visual_asset_id,
    visual.title,
    visual.alt_text,
    visual.media_type,
    visual.object_key
  into asset
  from public.visual_knowledge_assets visual
  join public.courses course
    on course.tenant_id = visual.tenant_id
   and course.course_id = visual.course_id
   and course.deleted_at is null
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = target_visual_asset_id
    and visual.status = 'active'
    and (
      caller.identity_role in (
        'tenant_owner', 'tenant_admin', 'creator', 'teacher'
      )
      or (
        caller.identity_role = 'student'
        and visual.show_in_answers
        and course.status = 'published'
      )
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'title', asset.title,
    'altText', asset.alt_text,
    'mediaType', asset.media_type,
    'privateObjectKey', asset.object_key
  );
end;
$$;

create or replace function public.learning_record_visual_usage(
  visual_asset_ids uuid[],
  operation_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  recorded integer := 0;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or not app_private.learning_operation_token_is_valid(
      'conversation.answer.record', operation_token
    )
    or visual_asset_ids is null
    or cardinality(visual_asset_ids) > 12
  then
    return jsonb_build_object('ok', false, 'code', 'request_denied');
  end if;

  update public.visual_knowledge_assets visual
  set usage_count = visual.usage_count + 1
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = any(visual_asset_ids)
    and visual.status = 'active'
    and visual.show_in_answers;
  get diagnostics recorded = row_count;
  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'recorded', recorded
  );
end;
$$;

-- Function creation grants PUBLIC execute by default. Close every new surface
-- first, then grant only the roles that have a real caller.
revoke execute on function public.learning_create_visual_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_finalize_visual_asset(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_update_visual_asset(
  uuid, uuid, text, text, text, boolean, bigint
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_archive_visual_asset(uuid, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_list_visual_assets(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_get_visual_asset_for_read(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_record_visual_usage(uuid[], text)
  from public, anon, authenticated, service_role;

grant execute on function public.learning_create_visual_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text
) to authenticated;
grant execute on function public.learning_finalize_visual_asset(uuid)
  to authenticated;
grant execute on function public.learning_update_visual_asset(
  uuid, uuid, text, text, text, boolean, bigint
) to authenticated;
grant execute on function public.learning_archive_visual_asset(uuid, bigint)
  to authenticated;
grant execute on function public.learning_list_visual_assets(uuid, boolean)
  to authenticated;
grant execute on function public.learning_get_visual_asset_for_read(uuid)
  to authenticated;
grant execute on function public.learning_record_visual_usage(uuid[], text)
  to authenticated;

commit;
