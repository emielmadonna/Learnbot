-- Tenant-scoped learning source connections and connector projection.
--
-- Credentials are encrypted in Vault and are only decrypted through a
-- service-role RPC after the initiating Supabase user and their currently
-- selected tenant have been re-verified. Browser sessions receive only safe
-- connection metadata. Connector documents use the same durable
-- learning_sources -> learning_documents -> learning_chunks model as uploads.

begin;

create table app_private.learning_source_connections (
  connection_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id) on delete cascade,
  provider text not null check (provider in ('circle')),
  account_label text,
  api_base_url text not null default 'https://app.circle.so'
    check (api_base_url = 'https://app.circle.so'),
  vault_secret_id uuid not null,
  key_last4 text not null check (key_last4 ~ '^[[:print:]]{4}$'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  record_version bigint not null default 1 check (record_version > 0),
  created_by_principal_id text references public.identity_principals(principal_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, provider),
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

alter table app_private.learning_source_connections enable row level security;
alter table app_private.learning_source_connections force row level security;
revoke all on table app_private.learning_source_connections
  from public, anon, authenticated, service_role;

-- No public role may inspect the decrypted Vault view. This repeats the
-- boundary deliberately so the connector migration remains fail-closed if it
-- is applied to an environment built from a partial baseline.
revoke all on table vault.decrypted_secrets
  from public, anon, authenticated;

create or replace function app_private.set_learning_source_connection(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  target_provider text,
  raw_credential text,
  account_label text,
  clear_credential boolean,
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  existing app_private.learning_source_connections%rowtype;
  secret_id uuid;
  connection_ref uuid;
  normalized_provider text := lower(btrim(coalesce(target_provider, '')));
  normalized_credential text := btrim(coalesce(raw_credential, ''));
  normalized_label text := nullif(left(btrim(account_label), 160), '');
  normalized_request text := btrim(coalesce(requested_idempotency_key, ''));
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or normalized_provider <> 'circle'
    or clear_credential is null
    or normalized_request !~ '^[A-Za-z0-9:_-]{8,200}$'
    or (clear_credential and normalized_credential <> '')
    or (
      not clear_credential
      and (
        length(normalized_credential) < 20
        or length(normalized_credential) > 1000
        or normalized_credential !~ '^[[:print:]]+$'
      )
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  if not found
    or caller.tenant_id <> target_tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select c.* into existing
  from app_private.learning_source_connections c
  where c.tenant_id = target_tenant_id
    and c.provider = normalized_provider;

  if clear_credential then
    if found then
      update app_private.learning_source_connections c
      set
        status = 'revoked',
        revoked_at = now(),
        record_version = c.record_version + 1,
        updated_at = now()
      where c.connection_id = existing.connection_id;
      delete from vault.secrets s
      where s.id = existing.vault_secret_id;
      perform app_private.ingestion_append_audit(
        target_tenant_id,
        caller.identity_role,
        'learning.connector.credential.clear',
        existing.connection_id::text,
        normalized_request
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'configured', false,
      'provider', normalized_provider
    );
  end if;

  if found and existing.status = 'active' then
    secret_id := existing.vault_secret_id;
    perform vault.update_secret(
      secret_id,
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text ||
        ':learning-source:' || normalized_provider,
      'Tenant-scoped LearningBot learning source credential',
      null::uuid
    );
    update app_private.learning_source_connections c
    set
      account_label = normalized_label,
      key_last4 = right(normalized_credential, 4),
      status = 'active',
      revoked_at = null,
      record_version = c.record_version + 1,
      created_by_principal_id = caller.principal_id,
      updated_at = now()
    where c.connection_id = existing.connection_id;
    connection_ref := existing.connection_id;
  elsif found then
    secret_id := vault.create_secret(
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text ||
        ':learning-source:' || normalized_provider,
      'Tenant-scoped LearningBot learning source credential',
      null::uuid
    );
    update app_private.learning_source_connections c
    set
      vault_secret_id = secret_id,
      account_label = normalized_label,
      key_last4 = right(normalized_credential, 4),
      status = 'active',
      revoked_at = null,
      record_version = c.record_version + 1,
      created_by_principal_id = caller.principal_id,
      updated_at = now()
    where c.connection_id = existing.connection_id;
    connection_ref := existing.connection_id;
  else
    secret_id := vault.create_secret(
      normalized_credential,
      'learningbot:tenant:' || target_tenant_id::text ||
        ':learning-source:' || normalized_provider,
      'Tenant-scoped LearningBot learning source credential',
      null::uuid
    );
    insert into app_private.learning_source_connections (
      tenant_id, provider, account_label, api_base_url, vault_secret_id,
      key_last4, status, created_by_principal_id
    ) values (
      target_tenant_id, normalized_provider, normalized_label,
      'https://app.circle.so', secret_id, right(normalized_credential, 4),
      'active', caller.principal_id
    )
    returning connection_id into connection_ref;
  end if;

  perform app_private.ingestion_append_audit(
    target_tenant_id,
    caller.identity_role,
    'learning.connector.credential.configure',
    connection_ref::text,
    normalized_request
  );

  return jsonb_build_object(
    'ok', true,
    'configured', true,
    'provider', normalized_provider,
    'accountLabel', normalized_label,
    'keyLast4', right(normalized_credential, 4)
  );
end;
$$;

revoke execute on function app_private.set_learning_source_connection(
  uuid, uuid, text, text, text, boolean, text
) from public, anon, authenticated, service_role;

create or replace function app_private.learning_source_connection_for_runtime(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  requested_provider text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  connection record;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or lower(btrim(coalesce(requested_provider, ''))) <> 'circle'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  if not found
    or caller.tenant_id <> target_tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select
    c.provider,
    c.account_label,
    c.key_last4,
    c.vault_secret_id,
    d.decrypted_secret
  into connection
  from app_private.learning_source_connections c
  join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.tenant_id = target_tenant_id
    and c.provider = lower(btrim(requested_provider))
    and c.status = 'active'
    and c.revoked_at is null;

  if not found or connection.decrypted_secret is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_credential_not_configured'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'provider', connection.provider,
    'accountLabel', connection.account_label,
    'keyLast4', connection.key_last4,
    'vaultReference', 'vault://' || connection.vault_secret_id::text,
    'credential', connection.decrypted_secret
  );
end;
$$;

revoke execute on function app_private.learning_source_connection_for_runtime(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

-- Safe browser-visible state. It derives the tenant exclusively from auth.uid()
-- and the durable selected membership. A blank selection cannot see any
-- connection or source rows.
create or replace function public.learning_source_connection_state(
  requested_provider text default 'circle'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  connection jsonb;
  sources jsonb;
  normalized_provider text := lower(btrim(coalesce(requested_provider, '')));
begin
  select c.* into caller
  from app_private.supabase_auth_context_for_user(auth.uid()) c;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_selection_required'
    );
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if normalized_provider <> 'circle' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select jsonb_build_object(
    'configured', c.status = 'active' and c.revoked_at is null,
    'provider', c.provider,
    'accountLabel', c.account_label,
    'keyLast4', c.key_last4,
    'status', c.status,
    'updatedAt', c.updated_at
  )
  into connection
  from app_private.learning_source_connections c
  where c.tenant_id = caller.tenant_id
    and c.provider = normalized_provider;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sourceId', s.source_id,
        'courseId', s.course_id,
        'kind', s.source_type,
        'externalRef', s.external_ref,
        'name', s.name,
        'status', s.status,
        'lastSyncedAt', s.last_synced_at
      )
      order by s.updated_at desc
    ),
    '[]'::jsonb
  )
  into sources
  from public.learning_sources s
  where s.tenant_id = caller.tenant_id
    and s.source_type in ('circle', 'youtube')
    and s.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'connection', connection,
    'sources', sources
  );
end;
$$;

revoke execute on function public.learning_source_connection_state(text)
  from public, anon, service_role;
grant execute on function public.learning_source_connection_state(text)
  to authenticated;

-- Projects provider-returned text into durable, versioned knowledge. Provider
-- adapters pass only sanitized documents; this function independently checks
-- tenant/course ownership, role, sizes and source kinds before writing.
create or replace function app_private.project_learning_source_connector(
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
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  chunk_target constant integer := 1200;
  chunk_max constant integer := 1800;
  caller record;
  course record;
  active_version record;
  prior_document record;
  prior_chunk record;
  carried_chunk record;
  resolved_source_id uuid;
  new_version_id uuid;
  new_version_number integer;
  new_document_id uuid;
  normalized_kind text := lower(btrim(coalesce(source_kind, '')));
  normalized_external text := btrim(coalesce(external_ref, ''));
  normalized_name text := left(btrim(coalesce(source_name, '')), 160);
  normalized_request text := btrim(coalesce(requested_idempotency_key, ''));
  sanitized_configuration jsonb;
  doc_payload jsonb;
  doc_external_id text;
  doc_title text;
  doc_body text;
  doc_language text;
  doc_media_type text;
  doc_metadata jsonb;
  packed_chunks text[];
  split_parts text[];
  chunk_body text;
  chunk_with_context text;
  chunk_hash text;
  chunk_ordinal integer;
  document_count integer := 0;
  chunk_count integer := 0;
  reused_count integer := 0;
  pending_count integer := 0;
  projected_chunk_count integer := 0;
  total_document_characters bigint := 0;
  total_document_bytes bigint := 0;
  next_source_manifest jsonb := '[]'::jsonb;
  combined_content_hash text;
begin
  if auth.role() <> 'service_role'
    or caller_auth_user_id is null
    or target_tenant_id is null
    or target_course_id is null
    or normalized_kind not in ('youtube', 'circle')
    or normalized_external = ''
    or length(normalized_external) > 500
    or normalized_name = ''
    or coalesce(source_content_hash, '') !~ '^[0-9a-f]{64}$'
    or normalized_request !~ '^[A-Za-z0-9:_-]{8,200}$'
    or replace_active_knowledge is null
    or jsonb_typeof(coalesce(source_configuration, '{}'::jsonb)) <> 'object'
    or length(coalesce(source_configuration, '{}'::jsonb)::text) > 20000
    or (
      case
      when jsonb_typeof(coalesce(source_documents, 'null'::jsonb)) = 'array'
        then jsonb_array_length(source_documents) not between 1 and 500
      else true
      end
    )
    or (
      normalized_kind = 'circle'
      and coalesce(source_credential_vault_ref, '') !~
        '^vault://[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or (
      normalized_kind = 'youtube'
      and source_credential_vault_ref is not null
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.* into caller
  from app_private.supabase_auth_context_for_user(caller_auth_user_id) c;
  if not found
    or caller.tenant_id <> target_tenant_id
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  -- Validate all documents before the first mutation, so a malformed provider
  -- response cannot leave a half-updated source row.
  for doc_payload in
    select value from jsonb_array_elements(source_documents)
  loop
    doc_external_id := btrim(coalesce(doc_payload ->> 'externalId', ''));
    doc_title := btrim(coalesce(doc_payload ->> 'title', ''));
    doc_body := btrim(coalesce(doc_payload ->> 'body', ''));
    if jsonb_typeof(doc_payload) <> 'object'
      or doc_external_id = ''
      or length(doc_external_id) > 500
      or doc_title = ''
      or length(doc_title) > 500
      or doc_body = ''
      or length(doc_body) > 1000000
      or (
        doc_payload ? 'metadata'
        and jsonb_typeof(doc_payload -> 'metadata') <> 'object'
      )
    then
      return jsonb_build_object('ok', false, 'code', 'invalid_document');
    end if;

    total_document_characters :=
      total_document_characters + length(doc_body);
    total_document_bytes :=
      total_document_bytes + octet_length(doc_body);
    split_parts := app_private.knowledge_split_text(doc_body, chunk_max);
    packed_chunks := app_private.knowledge_pack_chunks(
      split_parts, chunk_target, chunk_max
    );
    if array_length(packed_chunks, 1) is null then
      return jsonb_build_object('ok', false, 'code', 'invalid_document');
    end if;
    projected_chunk_count :=
      projected_chunk_count + array_length(packed_chunks, 1);
    if total_document_characters > 20000000
      or total_document_bytes > 25000000
      or projected_chunk_count > 20000
    then
      return jsonb_build_object(
        'ok', false, 'code', 'connector_payload_too_large'
      );
    end if;
  end loop;

  select
    c.course_id, c.tenant_id, c.title, c.external_id,
    c.active_knowledge_version_id
  into course
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'course_not_found');
  end if;

  if not exists (
    select 1
    from public.learning_sources s
    where s.tenant_id = target_tenant_id
      and s.course_id = target_course_id
      and s.source_type = normalized_kind
      and s.external_ref = normalized_external
  )
    and (
      select count(*)
      from public.learning_sources s
      where s.tenant_id = target_tenant_id
        and s.source_type in ('circle', 'youtube')
        and s.deleted_at is null
    ) >= 100
  then
    return jsonb_build_object(
      'ok', false, 'code', 'connector_source_quota_exceeded'
    );
  end if;

  sanitized_configuration := case normalized_kind
    when 'youtube' then jsonb_strip_nulls(jsonb_build_object(
      'videoId', source_configuration ->> 'videoId',
      'videoUrl', source_configuration ->> 'videoUrl',
      'authorName', source_configuration ->> 'authorName',
      'captionBacked',
        coalesce((source_configuration ->> 'captionBacked')::boolean, false)
    ))
    when 'circle' then jsonb_strip_nulls(jsonb_build_object(
      'circleSpaceId', source_configuration ->> 'circleSpaceId',
      'circleSpaceSlug', source_configuration ->> 'circleSpaceSlug',
      'circleSpaceUrl', source_configuration ->> 'circleSpaceUrl'
    ))
    else '{}'::jsonb
  end;

  insert into public.learning_sources (
    tenant_id, course_id, source_type, name, status, external_ref,
    credential_vault_ref, configuration, cursor_value, last_synced_at,
    idempotency_key
  ) values (
    target_tenant_id, target_course_id, normalized_kind, normalized_name,
    'ready', normalized_external, source_credential_vault_ref,
    sanitized_configuration, source_content_hash, now(),
    'connector-source:' || target_course_id::text || ':' ||
      normalized_kind || ':' || normalized_external
  )
  on conflict (tenant_id, course_id, source_type, external_ref) do update
    set
      name = excluded.name,
      status = 'ready',
      credential_vault_ref = excluded.credential_vault_ref,
      configuration = excluded.configuration,
      cursor_value = excluded.cursor_value,
      last_synced_at = excluded.last_synced_at,
      record_version = public.learning_sources.record_version + 1,
      updated_at = now(),
      deleted_at = null
  returning learning_sources.source_id into resolved_source_id;

  select
    kv.knowledge_version_id, kv.version_number, kv.status,
    kv.content_hash, kv.source_manifest
  into active_version
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id = course.active_knowledge_version_id;

  -- A source hash is source-specific. A merged knowledge version has a
  -- different aggregate content_hash, so replay detection must inspect the
  -- active manifest entry instead of comparing the aggregate hash.
  if found
    and active_version.status = 'published'
    and active_version.source_manifest @> jsonb_build_array(
      jsonb_build_object(
        'sourceId', resolved_source_id,
        'contentHash', source_content_hash
      )
    )
    and (
      not replace_active_knowledge
      or jsonb_array_length(active_version.source_manifest) = 1
    )
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
      'contentHash', active_version.content_hash,
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
      'retrievable', chunk_count > 0,
      'activationBlockedReason', null
    );
  end if;

  -- Normal syncs merge the active version and replace only this source.
  -- Explicit replacement intentionally discards every other source.
  if not replace_active_knowledge
    and active_version.knowledge_version_id is not null
  then
    select coalesce(jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
    into next_source_manifest
    from jsonb_array_elements(active_version.source_manifest)
      with ordinality as entry(value, ordinality)
    where coalesce(entry.value ->> 'sourceId', '') <>
      resolved_source_id::text;
  end if;
  next_source_manifest := next_source_manifest || jsonb_build_array(
    jsonb_build_object(
      'kind', 'source_connector',
      'provider', normalized_kind,
      'source', normalized_kind || ':' || normalized_external,
      'sourceId', resolved_source_id,
      'contentHash', source_content_hash
    )
  );
  -- Canonical source order makes the aggregate hash independent of which
  -- connector happened to be refreshed most recently.
  select jsonb_agg(entry.value order by
    coalesce(entry.value ->> 'sourceId', ''),
    coalesce(entry.value ->> 'source', ''),
    entry.value::text
  )
  into next_source_manifest
  from jsonb_array_elements(next_source_manifest) entry(value);
  combined_content_hash := encode(
    extensions.digest(next_source_manifest::text, 'sha256'),
    'hex'
  );

  select coalesce(max(kv.version_number), 0) + 1
  into new_version_number
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id;

  insert into public.knowledge_versions (
    tenant_id, course_id, version_number, status, source_manifest,
    content_hash, embedding_provider_key, embedding_model_key,
    embedding_dimensions, built_by, supersedes_version_id, idempotency_key
  ) values (
    target_tenant_id, target_course_id, new_version_number, 'building',
    next_source_manifest,
    combined_content_hash, 'openai', 'text-embedding-3-small', 384,
    caller_auth_user_id, course.active_knowledge_version_id,
    'connector-knowledge:' || resolved_source_id::text || ':' ||
      new_version_number::text
  )
  returning knowledge_versions.knowledge_version_id into new_version_id;

  -- Carry every other source forward into the new immutable version. New
  -- document ids preserve the version/document/chunk foreign-key boundary.
  if not replace_active_knowledge
    and active_version.knowledge_version_id is not null
  then
    for prior_document in
      select d.*
      from public.learning_documents d
      where d.tenant_id = target_tenant_id
        and d.course_id = target_course_id
        and d.knowledge_version_id = active_version.knowledge_version_id
        and d.source_id <> resolved_source_id
        and d.deleted_at is null
        and d.status = 'ready'
      order by d.created_at, d.document_id
    loop
      new_document_id := gen_random_uuid();
      insert into public.learning_documents (
        document_id, tenant_id, course_id, source_id, knowledge_version_id,
        external_id, title, media_type, language, raw_storage_key,
        extracted_storage_key, content_hash, status, metadata,
        idempotency_key, retain_until
      ) values (
        new_document_id, target_tenant_id, target_course_id,
        prior_document.source_id, new_version_id, prior_document.external_id,
        prior_document.title, prior_document.media_type,
        prior_document.language, prior_document.raw_storage_key,
        prior_document.extracted_storage_key, prior_document.content_hash,
        'ready', prior_document.metadata,
        'connector-merge-doc:' || new_version_id::text || ':' ||
          prior_document.document_id::text,
        prior_document.retain_until
      );
      document_count := document_count + 1;

      for carried_chunk in
        select ch.*
        from public.learning_chunks ch
        where ch.tenant_id = target_tenant_id
          and ch.course_id = target_course_id
          and ch.knowledge_version_id = active_version.knowledge_version_id
          and ch.document_id = prior_document.document_id
          and ch.deleted_at is null
        order by ch.ordinal
      loop
        insert into public.learning_chunks (
          tenant_id, course_id, knowledge_version_id, document_id, ordinal,
          body, token_count, content_hash, embedding, embedding_provider_key,
          embedding_model_key, embedding_dimensions, metadata,
          idempotency_key, retain_until
        ) values (
          target_tenant_id, target_course_id, new_version_id, new_document_id,
          carried_chunk.ordinal, carried_chunk.body,
          carried_chunk.token_count, carried_chunk.content_hash,
          carried_chunk.embedding, carried_chunk.embedding_provider_key,
          carried_chunk.embedding_model_key,
          carried_chunk.embedding_dimensions, carried_chunk.metadata,
          'connector-merge-chunk:' || new_version_id::text || ':' ||
            carried_chunk.chunk_id::text,
          carried_chunk.retain_until
        );
        chunk_count := chunk_count + 1;
        if carried_chunk.embedding is null then
          pending_count := pending_count + 1;
        else
          reused_count := reused_count + 1;
        end if;
      end loop;
    end loop;
  end if;

  for doc_payload in
    select value from jsonb_array_elements(source_documents)
  loop
    doc_external_id := btrim(doc_payload ->> 'externalId');
    doc_title := btrim(doc_payload ->> 'title');
    doc_body := btrim(doc_payload ->> 'body');
    doc_language := coalesce(nullif(btrim(doc_payload ->> 'language'), ''), 'und');
    doc_media_type := coalesce(
      nullif(btrim(doc_payload ->> 'mediaType'), ''),
      'text/plain'
    );
    doc_metadata := case normalized_kind
      when 'youtube' then jsonb_strip_nulls(jsonb_build_object(
        'provider', 'youtube',
        'videoId', doc_payload #>> '{metadata,videoId}',
        'videoUrl', doc_payload #>> '{metadata,videoUrl}',
        'authorName', doc_payload #>> '{metadata,authorName}',
        'captionLanguage', doc_payload #>> '{metadata,captionLanguage}',
        'autoGenerated',
          coalesce(
            (doc_payload #>> '{metadata,autoGenerated}')::boolean,
            false
          )
      ))
      when 'circle' then jsonb_strip_nulls(jsonb_build_object(
        'provider', 'circle',
        'spaceId', doc_payload #>> '{metadata,spaceId}',
        'sectionId', doc_payload #>> '{metadata,sectionId}',
        'sectionName', doc_payload #>> '{metadata,sectionName}',
        'lessonUrl', doc_payload #>> '{metadata,lessonUrl}',
        'updatedAt', doc_payload #>> '{metadata,updatedAt}'
      ))
      else '{}'::jsonb
    end;

    split_parts := app_private.knowledge_split_text(doc_body, chunk_max);
    packed_chunks := app_private.knowledge_pack_chunks(
      split_parts, chunk_target, chunk_max
    );
    if array_length(packed_chunks, 1) is null then
      return jsonb_build_object('ok', false, 'code', 'invalid_document');
    end if;

    insert into public.learning_documents (
      tenant_id, course_id, source_id, knowledge_version_id, external_id,
      title, media_type, language, content_hash, status, metadata,
      idempotency_key
    ) values (
      target_tenant_id, target_course_id, resolved_source_id, new_version_id,
      doc_external_id, doc_title, left(doc_media_type, 200),
      left(doc_language, 35),
      encode(extensions.digest(doc_body, 'sha256'), 'hex'),
      'ready',
      doc_metadata || jsonb_build_object(
        'connector', normalized_kind,
        'sourceId', resolved_source_id,
        'chunkCount', array_length(packed_chunks, 1)
      ),
      'connector-doc:' || new_version_id::text || ':' || doc_external_id
    )
    returning learning_documents.document_id into new_document_id;
    document_count := document_count + 1;

    for chunk_ordinal in 1..array_length(packed_chunks, 1) loop
      chunk_body := packed_chunks[chunk_ordinal];
      chunk_with_context := concat_ws(
        E'\n\n',
        nullif(concat_ws(
          ' · ',
          nullif(btrim(coalesce(course.title, '')), ''),
          nullif(doc_title, '')
        ), ''),
        chunk_body
      );
      chunk_hash := encode(
        extensions.digest(chunk_with_context, 'sha256'),
        'hex'
      );

      select
        ch.embedding, ch.embedding_provider_key, ch.embedding_model_key,
        ch.embedding_dimensions
      into prior_chunk
      from public.learning_chunks ch
      where ch.tenant_id = target_tenant_id
        and ch.course_id = target_course_id
        and ch.content_hash = chunk_hash
        and ch.embedding is not null
      order by ch.updated_at desc, ch.chunk_id
      limit 1;

      insert into public.learning_chunks (
        tenant_id, course_id, knowledge_version_id, document_id, ordinal,
        body, token_count, content_hash, embedding, embedding_provider_key,
        embedding_model_key, embedding_dimensions, metadata, idempotency_key
      ) values (
        target_tenant_id, target_course_id, new_version_id, new_document_id,
        chunk_ordinal - 1, chunk_with_context,
        ceil(length(chunk_with_context) / 4.0)::integer,
        chunk_hash, prior_chunk.embedding, prior_chunk.embedding_provider_key,
        prior_chunk.embedding_model_key, prior_chunk.embedding_dimensions,
        doc_metadata || jsonb_build_object(
          'courseSlug', coalesce(course.external_id, target_course_id::text),
          'courseName', course.title,
          'sectionName', doc_title,
          'connector', normalized_kind,
          'sourceId', resolved_source_id,
          'externalDocumentId', doc_external_id
        ),
        'connector-chunk:' || new_version_id::text || ':' ||
          doc_external_id || ':' || (chunk_ordinal - 1)::text
      );
      chunk_count := chunk_count + 1;
      if prior_chunk.embedding is null then
        pending_count := pending_count + 1;
      else
        reused_count := reused_count + 1;
      end if;
    end loop;
  end loop;

  update public.knowledge_versions kv
  set status = 'published', published_at = now(), updated_at = now()
  where kv.tenant_id = target_tenant_id
    and kv.knowledge_version_id = new_version_id;

  update public.courses c
  set
    active_knowledge_version_id = new_version_id,
    record_version = c.record_version + 1,
    updated_at = now()
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id;

  update public.knowledge_versions kv
  set status = 'retired', updated_at = now()
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id <> new_version_id
    and kv.status <> 'retired'
    and (
      kv.knowledge_version_id = active_version.knowledge_version_id
      or kv.source_manifest @> jsonb_build_array(
        jsonb_build_object('sourceId', resolved_source_id)
      )
    );

  update public.learning_chunks ch
  set deleted_at = now(), updated_at = now()
  where ch.tenant_id = target_tenant_id
    and ch.course_id = target_course_id
    and ch.knowledge_version_id <> new_version_id
    and ch.deleted_at is null
    and exists (
      select 1
      from public.knowledge_versions kv
      where kv.tenant_id = ch.tenant_id
        and kv.knowledge_version_id = ch.knowledge_version_id
        and (
          kv.knowledge_version_id = active_version.knowledge_version_id
          or kv.source_manifest @> jsonb_build_array(
            jsonb_build_object('sourceId', resolved_source_id)
          )
        )
    );

  update public.learning_documents d
  set deleted_at = now(), status = 'deleted', updated_at = now()
  where d.tenant_id = target_tenant_id
    and d.course_id = target_course_id
    and d.knowledge_version_id <> new_version_id
    and d.deleted_at is null
    and exists (
      select 1
      from public.knowledge_versions kv
      where kv.tenant_id = d.tenant_id
        and kv.knowledge_version_id = d.knowledge_version_id
        and (
          kv.knowledge_version_id = active_version.knowledge_version_id
          or kv.source_manifest @> jsonb_build_array(
            jsonb_build_object('sourceId', resolved_source_id)
          )
        )
    );

  perform app_private.ingestion_append_audit(
    target_tenant_id,
    caller.identity_role,
    'learning.connector.sync',
    target_course_id::text,
    new_version_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'changed', true,
    'activated', true,
    'knowledgeVersionId', new_version_id,
    'versionNumber', new_version_number,
    'contentHash', combined_content_hash,
    'documentCount', document_count,
    'chunkCount', chunk_count,
    'reusedEmbeddingCount', reused_count,
    'pendingEmbeddingCount', pending_count,
    'retrievable', chunk_count > 0,
    'activationBlockedReason', null
  );
end;
$$;

revoke execute on function app_private.project_learning_source_connector(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) from public, anon, authenticated, service_role;

-- PostgREST exposes only these service-role wrappers. The authenticated browser
-- role cannot set/decrypt credentials or invoke projection directly.
create or replace function public.learning_source_connection_set(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  target_provider text,
  raw_credential text,
  account_label text,
  clear_credential boolean,
  requested_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select app_private.set_learning_source_connection(
    caller_auth_user_id, target_tenant_id, target_provider, raw_credential,
    account_label, clear_credential, requested_idempotency_key
  );
$$;

revoke execute on function public.learning_source_connection_set(
  uuid, uuid, text, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.learning_source_connection_set(
  uuid, uuid, text, text, text, boolean, text
) to service_role;

create or replace function public.learning_source_connection_runtime(
  caller_auth_user_id uuid,
  target_tenant_id uuid,
  requested_provider text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.learning_source_connection_for_runtime(
    caller_auth_user_id, target_tenant_id, requested_provider
  );
$$;

revoke execute on function public.learning_source_connection_runtime(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.learning_source_connection_runtime(
  uuid, uuid, text
) to service_role;

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
  select app_private.project_learning_source_connector(
    caller_auth_user_id, target_tenant_id, target_course_id, source_kind,
    external_ref, source_name, source_configuration, source_documents,
    source_content_hash, replace_active_knowledge,
    requested_idempotency_key, source_credential_vault_ref
  );
$$;

revoke execute on function public.learning_source_connector_sync(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.learning_source_connector_sync(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) to service_role;

commit;
