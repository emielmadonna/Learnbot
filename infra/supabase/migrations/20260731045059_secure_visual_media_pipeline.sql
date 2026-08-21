-- Secure media expansion for visual knowledge.
--
-- The original visual manager accepted only raster images and let any
-- authenticated author call the one-argument finalize RPC. This migration:
--
--   * records a durable semantic kind (image, svg, video or chart);
--   * accepts the prototype contract's PNG/JPEG/WebP/SVG/MP4 formats, with a
--     hard 20 MiB ceiling and cross-checks between kind, MIME type and object
--     extension;
--   * gates activation on a dedicated server-held operation capability, so a
--     browser can upload bytes but cannot attest that they were validated;
--   * adds mediaType and visualKind to newly projected chunk metadata without
--     changing any retrieval RPC signature; and
--   * leaves the tenant-private bucket, forced RLS and storage read policy
--     untouched.
--
-- The application server reads
-- `LEARNINGBOT_VISUAL_VALIDATION_OPERATION_TOKEN`, whose value must be
-- registered for `learning.visual.finalize`, and calls:
--
--   learning_finalize_validated_visual_asset(uuid, text, text)
--
-- The legacy learning_finalize_visual_asset(uuid) remains present only for
-- schema compatibility and has no executable grants.

begin;

-- -------------------------------------------------------------------------
-- Server-only finalization capability
-- -------------------------------------------------------------------------

alter table app_private.learning_operation_secrets
  drop constraint if exists learning_operation_secrets_capability_allowed;
alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_capability_allowed
  check (
    capability in (
      'conversation.answer.record',
      'knowledge.embedding.worker',
      'telemetry.outbox.drain',
      'billing.stripe.webhook',
      'billing.operations',
      'security.malware_scan',
      'observability.error_intake',
      'learning.visual.finalize'
    )
  );

create or replace function app_private.learning_operation_capabilities()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array[
    'conversation.answer.record',
    'knowledge.embedding.worker',
    'telemetry.outbox.drain',
    'billing.stripe.webhook',
    'billing.operations',
    'security.malware_scan',
    'observability.error_intake',
    'learning.visual.finalize'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- Durable media kind and cross-field validation
-- -------------------------------------------------------------------------

alter table public.visual_knowledge_assets
  add column visual_kind text,
  add column validated_sha256 text,
  add column validated_at timestamptz,
  add column validation_profile text,
  add column revalidation_show_in_answers boolean;

update public.visual_knowledge_assets
set visual_kind = case media_type
  when 'image/svg+xml' then 'svg'
  when 'video/mp4' then 'video'
  else 'image'
end
where visual_kind is null;

alter table public.visual_knowledge_assets
  alter column visual_kind set default 'image',
  alter column visual_kind set not null,
  drop constraint visual_knowledge_assets_media_type_check,
  drop constraint visual_knowledge_assets_size_bytes_check;

alter table public.visual_knowledge_assets
  add constraint visual_knowledge_assets_visual_kind_check
    check (visual_kind in ('image', 'svg', 'video', 'chart')),
  add constraint visual_knowledge_assets_media_type_check
    check (
      media_type in (
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/svg+xml',
        'video/mp4'
      )
    ),
  add constraint visual_knowledge_assets_size_bytes_check
    check (size_bytes between 1 and 20971520),
  add constraint visual_knowledge_assets_kind_media_type_check
    check (
      (visual_kind = 'image'
        and media_type in ('image/png', 'image/jpeg', 'image/webp'))
      or (visual_kind = 'svg' and media_type = 'image/svg+xml')
      or (visual_kind = 'video' and media_type = 'video/mp4')
      or (visual_kind = 'chart'
        and media_type in (
          'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'
        ))
    ),
  add constraint visual_knowledge_assets_object_extension_check
    check (
      (media_type = 'image/png' and lower(object_key) ~ '\.png$')
      or (
        media_type = 'image/jpeg'
        and lower(object_key) ~ '\.(jpg|jpeg)$'
      )
      or (media_type = 'image/webp' and lower(object_key) ~ '\.webp$')
      or (media_type = 'image/svg+xml' and lower(object_key) ~ '\.svg$')
      or (media_type = 'video/mp4' and lower(object_key) ~ '\.mp4$')
    ),
  add constraint visual_knowledge_assets_validated_sha256_check
    check (
      validated_sha256 is null
      or validated_sha256 ~ '^[0-9a-f]{64}$'
    ),
  add constraint visual_knowledge_assets_validation_receipt_check
    check (
      (
        validated_sha256 is null
        and validated_at is null
        and validation_profile is null
      )
      or (
        validated_sha256 is not null
        and validated_at is not null
        and validation_profile = 'server_media_inspection_v1'
      )
    ),
  add constraint visual_knowledge_assets_pending_unvalidated_check
    check (
      status not in ('pending_upload', 'pending_revalidation')
      or (
        validated_sha256 is null
        and validated_at is null
        and validation_profile is null
      )
    );

-- Existing objects predate byte inspection. Preserve their records and files,
-- but remove them from retrieval/read until the application validates the
-- stored bytes and records a receipt. The affected course corpus is rebuilt
-- atomically so no legacy visual chunk remains answerable.
alter table public.visual_knowledge_assets
  drop constraint visual_knowledge_assets_status_check,
  add constraint visual_knowledge_assets_status_check
    check (
      status in (
        'pending_upload', 'pending_revalidation', 'active', 'archived'
      )
    );

create temporary table visual_courses_pending_revalidation
on commit drop
as
select distinct visual.tenant_id, visual.course_id
from public.visual_knowledge_assets visual
where visual.status = 'active'
  and visual.validated_sha256 is null;

update public.visual_knowledge_assets visual
set
  revalidation_show_in_answers = visual.show_in_answers,
  status = 'pending_revalidation',
  show_in_answers = false
where visual.status = 'active'
  and visual.validated_sha256 is null;

do $$
declare
  affected record;
begin
  for affected in
    select tenant_id, course_id
    from visual_courses_pending_revalidation
  loop
    perform app_private.visual_rebuild_course(
      affected.tenant_id,
      affected.course_id,
      'system',
      null,
      'visual-security-revalidation:' || affected.course_id::text
    );
  end loop;
end
$$;

alter table public.visual_knowledge_assets
  add constraint visual_knowledge_assets_active_validation_receipt_check
    check (
      status <> 'active'
      or (
        validated_sha256 is not null
        and validated_at is not null
        and validation_profile = 'server_media_inspection_v1'
        and revalidation_show_in_answers is null
      )
    ),
  add constraint visual_knowledge_assets_revalidation_state_check
    check (
      status <> 'pending_revalidation'
      or revalidation_show_in_answers is not null
    );

-- visual_kind is authoring metadata, so changing it must advance the
-- optimistic record version just like a title, description or media type.
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
    new.visual_kind,
    new.validated_sha256,
    new.validated_at,
    new.validation_profile,
    new.revalidation_show_in_answers,
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
    old.visual_kind,
    old.validated_sha256,
    old.validated_at,
    old.validation_profile,
    old.revalidation_show_in_answers,
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

-- The bucket's original generic owner policies predate validation receipts.
-- Without restrictive guards, an uploader could delete an active object and
-- insert different bytes at the same known key after finalization. Visual
-- objects are append-once: an authenticated insert is allowed only while the
-- exact tenant/uploader asset is pending and unexpired; authenticated delete
-- is never allowed. Archiving is a database lifecycle change, not a storage
-- deletion.
create or replace function app_private.visual_storage_insert_allowed(
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
    where visual.status = 'pending_upload'
      and visual.uploaded_by = auth.uid()
      and visual.upload_expires_at > statement_timestamp()
      and visual.validated_sha256 is null
      and visual.validated_at is null
      and visual.validation_profile is null
  );
$$;
revoke execute on function app_private.visual_storage_insert_allowed(text)
  from public, anon, authenticated, service_role;
grant execute on function app_private.visual_storage_insert_allowed(text)
  to authenticated;

drop policy if exists tenant_private_visual_insert_guard on storage.objects;
create policy tenant_private_visual_insert_guard on storage.objects
  as restrictive
  for insert to authenticated
  with check (
    bucket_id <> 'tenant-private'
    or (storage.foldername(name))[2] is distinct from 'visuals'
    or app_private.visual_storage_insert_allowed(name)
  );

drop policy if exists tenant_private_visual_delete_guard on storage.objects;
create policy tenant_private_visual_delete_guard on storage.objects
  as restrictive
  for delete to authenticated
  using (
    bucket_id <> 'tenant-private'
    or (storage.foldername(name))[2] is distinct from 'visuals'
  );

-- This projector hook keeps every existing retrieval/search function
-- compatible: their signatures and result envelopes do not change, while the
-- ordinary chunk metadata they already return gains the media discriminator.
create or replace function app_private.visual_chunk_add_media_metadata()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  asset record;
begin
  if new.metadata ->> 'projector' is distinct from
      'visual_knowledge_manager'
  then
    return new;
  end if;

  select visual.media_type, visual.visual_kind
  into asset
  from public.visual_knowledge_assets visual
  where visual.tenant_id = new.tenant_id
    and visual.visual_asset_id::text =
      new.metadata ->> 'visualAssetId';
  if not found then
    raise exception 'visual projection metadata does not identify a tenant asset';
  end if;

  new.metadata := new.metadata || jsonb_build_object(
    'mediaType', asset.media_type,
    'visualKind', asset.visual_kind
  );
  return new;
end;
$$;
revoke execute on function app_private.visual_chunk_add_media_metadata()
  from public, anon, authenticated, service_role;

drop trigger if exists learning_chunks_add_visual_media_metadata
  on public.learning_chunks;
create trigger learning_chunks_add_visual_media_metadata
before insert or update of metadata on public.learning_chunks
for each row execute function app_private.visual_chunk_add_media_metadata();

-- Backfill the discriminator into prior raster projections as a metadata-only
-- compatibility repair. The body, content hash, embedding and knowledge
-- version lineage remain unchanged.
update public.learning_chunks chunk
set metadata = coalesce(chunk.metadata, '{}'::jsonb) || jsonb_build_object(
  'mediaType', visual.media_type,
  'visualKind', visual.visual_kind
)
from public.visual_knowledge_assets visual
where chunk.tenant_id = visual.tenant_id
  and chunk.metadata ->> 'projector' = 'visual_knowledge_manager'
  and chunk.metadata ->> 'visualAssetId' =
    visual.visual_asset_id::text
  and (
    chunk.metadata ->> 'mediaType' is distinct from visual.media_type
    or chunk.metadata ->> 'visualKind' is distinct from visual.visual_kind
  );

-- Resolve only presentation-safe visual metadata for a match. Object keys,
-- validation receipts and tenant identifiers are deliberately excluded.
create or replace function app_private.visual_source_for_match(
  target_tenant_id uuid,
  candidate_chunk_id text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce((
    select jsonb_strip_nulls(jsonb_build_object(
      'visualAssetId', chunk.metadata ->> 'visualAssetId',
      'mediaType', chunk.metadata ->> 'mediaType',
      'visualKind', chunk.metadata ->> 'visualKind',
      'altText', chunk.metadata ->> 'visualAltText'
    ))
    from public.learning_chunks chunk
    join public.courses course
      on course.tenant_id = chunk.tenant_id
     and course.course_id = chunk.course_id
     and course.deleted_at is null
     and course.status = 'published'
     and course.active_knowledge_version_id = chunk.knowledge_version_id
    join public.visual_knowledge_assets visual
      on visual.tenant_id = chunk.tenant_id
     and visual.visual_asset_id::text =
       chunk.metadata ->> 'visualAssetId'
     and visual.status = 'active'
     and visual.show_in_answers
     and visual.validated_sha256 is not null
     and visual.validated_at is not null
     and visual.validation_profile = 'server_media_inspection_v1'
    where chunk.tenant_id = target_tenant_id
      and chunk.deleted_at is null
      and chunk.metadata ->> 'projector' = 'visual_knowledge_manager'
      and candidate_chunk_id is not null
      and chunk.chunk_id::text = candidate_chunk_id
    order by chunk.updated_at desc, chunk.chunk_id
    limit 1
  ), '{}'::jsonb);
$$;
revoke execute on function app_private.visual_source_for_match(
  uuid, text
) from public, anon, authenticated, service_role;

-- Preserve the final shared ranker as an internal implementation, then enrich
-- its fixed source envelope. Authenticated hybrid search and anonymous widget
-- retrieval both call this public contract, so one wrapper prevents drift.
alter function app_private.learning_chunk_matches(
  uuid, text, extensions.vector, uuid, integer, jsonb
) rename to learning_chunk_matches_legacy;
revoke execute on function app_private.learning_chunk_matches_legacy(
  uuid, text, extensions.vector, uuid, integer, jsonb
) from public, anon, authenticated, service_role;

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
begin
  result := app_private.learning_chunk_matches_legacy(
    target_tenant_id,
    search_query,
    query_embedding,
    target_course_id,
    match_limit,
    course_allowlist
  );
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

-- The lexical fallback predates the shared ranker. Wrap its unchanged ranking
-- implementation and enrich by returned chunk id under the verified tenant.
alter function public.learning_search_chunks(text, uuid, integer)
  rename to learning_search_chunks_legacy;
alter function public.learning_search_chunks_legacy(text, uuid, integer)
  set schema app_private;
revoke execute on function app_private.learning_search_chunks_legacy(
  text, uuid, integer
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

-- Keep the older authenticated hybrid RPC compatible too; its current
-- implementation can safely delegate to the shared tenant-bound ranker.
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
set search_path = pg_catalog, extensions
as $$
declare
  caller record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if query_embedding is null then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_query_embedding'
    );
  end if;
  return app_private.learning_chunk_matches(
    caller.tenant_id,
    search_query,
    query_embedding,
    target_course_id,
    match_limit,
    '"all"'::jsonb
  );
end;
$$;
revoke execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) to authenticated;

-- Public widget matches deliberately remain unchanged. Their established
-- contract replaces chunk ids with opaque source refs; enriching those refs
-- by content hash would be ambiguous across identical course text. A public
-- visual endpoint must first introduce an exact, widget-scoped capability.

-- -------------------------------------------------------------------------
-- Creation
-- -------------------------------------------------------------------------

-- One internal implementation serves both the established twelve-argument RPC
-- and the new kind-aware overload. It repeats all tenant, role, object-path,
-- MIME, kind and size checks rather than relying on the caller.
create or replace function app_private.visual_create_asset(
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
  requested_idempotency_key text,
  requested_visual_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  expected_prefix text;
  normalized_media_type text :=
    lower(btrim(coalesce(requested_media_type, '')));
  normalized_visual_kind text :=
    lower(btrim(coalesce(requested_visual_kind, '')));
  asset public.visual_knowledge_assets%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_visual_asset_id is null
    or target_course_id is null
    or length(btrim(coalesce(requested_title, ''))) not between 1 and 160
    or length(btrim(coalesce(requested_description, '')))
      not between 3 and 2000
    or length(btrim(coalesce(requested_alt_text, '')))
      not between 3 and 500
    or length(btrim(coalesce(requested_file_name, '')))
      not between 1 and 255
    or requested_size_bytes is null
    or requested_size_bytes not between 1 and 20971520
    or requested_upload_expires_at is null
    or requested_upload_expires_at <= now() + interval '5 minutes'
    or requested_upload_expires_at > now() + interval '2 hours 5 minutes'
    or length(coalesce(requested_idempotency_key, ''))
      not between 8 and 200
    or normalized_visual_kind not in ('image', 'svg', 'video', 'chart')
    or not (
      (
        normalized_visual_kind = 'image'
        and normalized_media_type in (
          'image/png', 'image/jpeg', 'image/webp'
        )
      )
      or (
        normalized_visual_kind = 'svg'
        and normalized_media_type = 'image/svg+xml'
      )
      or (
        normalized_visual_kind = 'video'
        and normalized_media_type = 'video/mp4'
      )
      or (
        normalized_visual_kind = 'chart'
        and normalized_media_type in (
          'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'
        )
      )
    )
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
  if requested_object_key is null
    or requested_object_key not like expected_prefix || '%'
    or requested_object_key like '%..%'
    or length(requested_object_key) > 1024
    or not (
      (normalized_media_type = 'image/png'
        and lower(requested_object_key) ~ '\.png$')
      or (
        normalized_media_type = 'image/jpeg'
        and lower(requested_object_key) ~ '\.(jpg|jpeg)$'
      )
      or (normalized_media_type = 'image/webp'
        and lower(requested_object_key) ~ '\.webp$')
      or (normalized_media_type = 'image/svg+xml'
        and lower(requested_object_key) ~ '\.svg$')
      or (normalized_media_type = 'video/mp4'
        and lower(requested_object_key) ~ '\.mp4$')
    )
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
    visual_kind,
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
    normalized_media_type,
    normalized_visual_kind,
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
    or asset.media_type <> normalized_media_type
    or asset.visual_kind <> normalized_visual_kind
  then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'courseId', asset.course_id,
    'visualKind', asset.visual_kind,
    'mediaType', asset.media_type,
    'status', asset.status,
    'recordVersion', asset.record_version,
    'uploadExpiresAt', asset.upload_expires_at
  );
end;
$$;
revoke execute on function app_private.visual_create_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text, text
) from public, anon, authenticated, service_role;

-- Established signature: new formats are inferred without breaking current
-- callers. A raster chart should use the kind-aware overload below.
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
language sql
security definer
set search_path = pg_catalog
as $$
  select app_private.visual_create_asset(
    requested_visual_asset_id,
    target_course_id,
    requested_title,
    requested_description,
    requested_alt_text,
    requested_show_in_answers,
    requested_file_name,
    requested_media_type,
    requested_size_bytes,
    requested_object_key,
    requested_upload_expires_at,
    requested_idempotency_key,
    case lower(btrim(coalesce(requested_media_type, '')))
      when 'image/svg+xml' then 'svg'
      when 'video/mp4' then 'video'
      else 'image'
    end
  );
$$;

-- Kind-aware overload for chart builders and future explicit callers. The
-- original argument set is unchanged, with requested_visual_kind appended.
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
  requested_idempotency_key text,
  requested_visual_kind text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select app_private.visual_create_asset(
    requested_visual_asset_id,
    target_course_id,
    requested_title,
    requested_description,
    requested_alt_text,
    requested_show_in_answers,
    requested_file_name,
    requested_media_type,
    requested_size_bytes,
    requested_object_key,
    requested_upload_expires_at,
    requested_idempotency_key,
    requested_visual_kind
  );
$$;

revoke execute on function public.learning_create_visual_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_create_visual_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.learning_create_visual_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text
) to authenticated;
grant execute on function public.learning_create_visual_asset(
  uuid, uuid, text, text, text, boolean, text, text, bigint, text,
  timestamptz, text, text
) to authenticated;

-- -------------------------------------------------------------------------
-- Token-gated finalization
-- -------------------------------------------------------------------------

-- Remove the browser-callable activation path. The function remains so older
-- generated clients do not fail schema introspection, but no API role can run
-- it and therefore no direct authenticated client can activate an upload.
revoke execute on function public.learning_finalize_visual_asset(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.learning_finalize_validated_visual_asset(
  target_visual_asset_id uuid,
  observed_sha256 text,
  operation_token text
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
  normalized_sha256 text :=
    lower(btrim(coalesce(observed_sha256, '')));
  projection jsonb;
begin
  if not app_private.learning_operation_token_is_valid(
    'learning.visual.finalize',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if normalized_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object(
      'ok', false, 'code', 'upload_evidence_invalid'
    );
  end if;

  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator'
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
    if asset.validated_sha256 is distinct from normalized_sha256
      or asset.validated_at is null
      or asset.validation_profile is distinct from
        'server_media_inspection_v1'
    then
      return jsonb_build_object(
        'ok', false,
        'code', 'upload_evidence_mismatch'
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'visualAssetId', asset.visual_asset_id,
      'visualKind', asset.visual_kind,
      'mediaType', asset.media_type,
      'validatedSha256', asset.validated_sha256,
      'validatedAt', asset.validated_at,
      'status', asset.status,
      'recordVersion', asset.record_version
    );
  end if;
  if asset.status not in ('pending_upload', 'pending_revalidation')
    or (
      asset.status = 'pending_upload'
      and asset.upload_expires_at <= now()
    )
  then
    return jsonb_build_object(
      'ok', false,
      'code', 'upload_intent_unavailable'
    );
  end if;

  select object.metadata into object_metadata
  from storage.objects object
  where object.bucket_id = 'tenant-private'
    and object.name = asset.object_key;
  if object_metadata is null
    or jsonb_typeof(object_metadata) <> 'object'
  then
    return jsonb_build_object('ok', false, 'code', 'upload_incomplete');
  end if;
  if coalesce(object_metadata ->> 'size', '') !~ '^[0-9]+$'
    or length(coalesce(object_metadata ->> 'mimetype', '')) > 100
  then
    return jsonb_build_object(
      'ok', false,
      'code', 'upload_evidence_invalid'
    );
  end if;

  observed_size := (object_metadata ->> 'size')::bigint;
  observed_media_type :=
    lower(btrim(coalesce(object_metadata ->> 'mimetype', '')));
  if observed_size <> asset.size_bytes
    or observed_size not between 1 and 20971520
    or observed_media_type <> asset.media_type
    or not (
      (asset.media_type = 'image/png'
        and lower(asset.object_key) ~ '\.png$')
      or (
        asset.media_type = 'image/jpeg'
        and lower(asset.object_key) ~ '\.(jpg|jpeg)$'
      )
      or (asset.media_type = 'image/webp'
        and lower(asset.object_key) ~ '\.webp$')
      or (asset.media_type = 'image/svg+xml'
        and lower(asset.object_key) ~ '\.svg$')
      or (asset.media_type = 'video/mp4'
        and lower(asset.object_key) ~ '\.mp4$')
    )
  then
    return jsonb_build_object(
      'ok', false,
      'code', 'upload_evidence_mismatch'
    );
  end if;

  update public.visual_knowledge_assets visual
  set
    status = 'active',
    show_in_answers = coalesce(
      visual.revalidation_show_in_answers,
      visual.show_in_answers
    ),
    revalidation_show_in_answers = null,
    validated_sha256 = normalized_sha256,
    validated_at = now(),
    validation_profile = 'server_media_inspection_v1'
  where visual.tenant_id = caller.tenant_id
    and visual.visual_asset_id = asset.visual_asset_id
    and visual.status in ('pending_upload', 'pending_revalidation')
  returning visual.* into asset;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'upload_intent_unavailable'
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
    'visualKind', asset.visual_kind,
    'mediaType', asset.media_type,
    'validatedSha256', asset.validated_sha256,
    'validatedAt', asset.validated_at,
    'status', asset.status,
    'recordVersion', asset.record_version,
    'projected', coalesce((projection ->> 'projected')::boolean, false)
  );
end;
$$;
revoke execute on function public.learning_finalize_validated_visual_asset(
  uuid, text, text
)
  from public, anon, authenticated, service_role;
grant execute on function public.learning_finalize_validated_visual_asset(
  uuid, text, text
)
  to authenticated;

-- The application route admits owners, admins and creators. Move the prior
-- mutation implementations behind app_private and restore their public names
-- as role-gated wrappers so a teacher cannot bypass the route by calling the
-- RPC directly.
alter function public.learning_update_visual_asset(
  uuid, uuid, text, text, text, boolean, bigint
) rename to visual_update_asset_legacy;
alter function public.visual_update_asset_legacy(
  uuid, uuid, text, text, text, boolean, bigint
) set schema app_private;
revoke execute on function app_private.visual_update_asset_legacy(
  uuid, uuid, text, text, text, boolean, bigint
) from public, anon, authenticated, service_role;

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
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  return app_private.visual_update_asset_legacy(
    target_visual_asset_id,
    target_course_id,
    requested_title,
    requested_description,
    requested_alt_text,
    requested_show_in_answers,
    expected_version
  );
end;
$$;
revoke execute on function public.learning_update_visual_asset(
  uuid, uuid, text, text, text, boolean, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.learning_update_visual_asset(
  uuid, uuid, text, text, text, boolean, bigint
) to authenticated;

alter function public.learning_archive_visual_asset(uuid, bigint)
  rename to visual_archive_asset_legacy;
alter function public.visual_archive_asset_legacy(uuid, bigint)
  set schema app_private;
revoke execute on function app_private.visual_archive_asset_legacy(uuid, bigint)
  from public, anon, authenticated, service_role;

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
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  return app_private.visual_archive_asset_legacy(
    target_visual_asset_id,
    expected_version
  );
end;
$$;
revoke execute on function public.learning_archive_visual_asset(uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.learning_archive_visual_asset(uuid, bigint)
  to authenticated;

-- -------------------------------------------------------------------------
-- Kind-aware reads (additive JSON fields; RPC signatures stay unchanged)
-- -------------------------------------------------------------------------

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
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if caller.identity_role not in (
    'tenant_owner', 'tenant_admin', 'creator'
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
        'visualKind', visual.visual_kind,
        'sizeBytes', visual.size_bytes,
        'status', visual.status,
        'usageCount', visual.usage_count,
        'recordVersion', visual.record_version,
        'createdAt', visual.created_at,
        'updatedAt', visual.updated_at,
        'archivedAt', visual.archived_at,
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
    and (
      coalesce(include_archived, false)
      or visual.status <> 'archived'
    );

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
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;

  select
    visual.visual_asset_id,
    visual.title,
    visual.alt_text,
    visual.media_type,
    visual.visual_kind,
    visual.size_bytes,
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
    and visual.validated_sha256 is not null
    and visual.validated_at is not null
    and visual.validation_profile = 'server_media_inspection_v1'
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
    'visualKind', asset.visual_kind,
    'sizeBytes', asset.size_bytes,
    'privateObjectKey', asset.object_key
  );
end;
$$;

-- CREATE OR REPLACE does not change grants, but close and restore the intended
-- read surfaces explicitly so a later ownership/default-ACL change cannot.
revoke execute on function public.learning_list_visual_assets(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_get_visual_asset_for_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.learning_list_visual_assets(uuid, boolean)
  to authenticated;
grant execute on function public.learning_get_visual_asset_for_read(uuid)
  to authenticated;

commit;
