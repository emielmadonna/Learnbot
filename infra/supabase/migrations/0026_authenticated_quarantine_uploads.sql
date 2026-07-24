-- Authenticated author upload flow. Files are signed into tenant-private
-- quarantine and become resumable ingestion jobs only after object evidence is
-- verified. No file is promoted or parsed before a malware worker clears it.

begin;

create or replace function public.learning_create_upload_intent(
  requested_intent_id uuid,
  target_course_id uuid,
  requested_filename text,
  requested_media_type text,
  requested_size_bytes bigint,
  requested_object_key text,
  requested_expires_at timestamptz,
  requested_signed_upload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  expected_prefix text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if requested_intent_id is null
    or target_course_id is null
    or length(btrim(coalesce(requested_filename, ''))) not between 1 and 255
    or requested_media_type not in (
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    or requested_size_bytes not between 1 and 26214400
    or requested_expires_at <= now() + interval '5 minutes'
    or requested_expires_at > now() + interval '2 hours 5 minutes'
    or jsonb_typeof(requested_signed_upload) <> 'object'
    or requested_signed_upload ->> 'method' <> 'PUT'
    or requested_signed_upload ->> 'url' not like 'https://%'
    or requested_signed_upload ->> 'courseId' <> target_course_id::text
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1
    from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  expected_prefix := caller.tenant_id::text
    || '/quarantine/'
    || auth.uid()::text
    || '/'
    || requested_intent_id::text
    || '/';
  if requested_object_key not like expected_prefix || '%'
    or requested_object_key like '%..%'
    or length(requested_object_key) > 1024 then
    return jsonb_build_object('ok', false, 'code', 'invalid_object_key');
  end if;

  insert into public.upload_intents (
    intent_id,
    tenant_id,
    actor_id,
    filename,
    media_type,
    declared_size_bytes,
    object_key,
    expires_at,
    status,
    disposition,
    signed_upload,
    scan_results,
    promotion_attempts,
    idempotency_key
  ) values (
    requested_intent_id::text,
    caller.tenant_id,
    auth.uid()::text,
    btrim(requested_filename),
    requested_media_type,
    requested_size_bytes,
    requested_object_key,
    requested_expires_at,
    'quarantined',
    'quarantine',
    requested_signed_upload,
    '[]'::jsonb,
    0,
    'learning-upload:' || requested_intent_id::text
  )
  on conflict (tenant_id, intent_id) do nothing;

  if not exists (
    select 1
    from public.upload_intents ui
    where ui.tenant_id = caller.tenant_id
      and ui.intent_id = requested_intent_id::text
      and ui.actor_id = auth.uid()::text
      and ui.object_key = requested_object_key
      and ui.declared_size_bytes = requested_size_bytes
      and ui.media_type = requested_media_type
  ) then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'intentId', requested_intent_id,
    'courseId', target_course_id,
    'status', 'quarantined',
    'expiresAt', requested_expires_at
  );
end;
$$;

create or replace function public.learning_confirm_quarantine_upload(
  requested_intent_id uuid,
  target_course_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  intent public.upload_intents%rowtype;
  object_metadata jsonb;
  observed_size bigint;
  source_id uuid;
  job_id uuid;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select ui.* into intent
  from public.upload_intents ui
  where ui.tenant_id = caller.tenant_id
    and ui.intent_id = requested_intent_id::text
    and ui.actor_id = auth.uid()::text
  for update;
  if not found
    or target_course_id is null
    or intent.signed_upload ->> 'courseId' <> target_course_id::text
    or intent.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'upload_intent_unavailable');
  end if;

  select so.metadata into object_metadata
  from storage.objects so
  where so.bucket_id = 'tenant-private'
    and so.name = intent.object_key;
  if object_metadata is null then
    return jsonb_build_object('ok', false, 'code', 'upload_incomplete');
  end if;
  if coalesce(object_metadata ->> 'size', '') !~ '^[0-9]+$' then
    return jsonb_build_object('ok', false, 'code', 'upload_evidence_invalid');
  end if;
  observed_size := (object_metadata ->> 'size')::bigint;
  if observed_size <> intent.declared_size_bytes then
    update public.upload_intents
    set
      status = 'blocked',
      failure = jsonb_build_object(
        'code', 'DECLARED_SIZE_MISMATCH',
        'message', 'The uploaded object size did not match the signed intent.',
        'retryable', false
      ),
      updated_at = now(),
      record_version = record_version + 1
    where tenant_id = caller.tenant_id
      and intent_id = intent.intent_id;
    return jsonb_build_object('ok', false, 'code', 'declared_size_mismatch');
  end if;

  insert into public.learning_sources (
    tenant_id,
    course_id,
    source_type,
    name,
    status,
    external_ref,
    configuration,
    idempotency_key
  ) values (
    caller.tenant_id,
    target_course_id,
    'upload',
    intent.filename,
    'connecting',
    intent.object_key,
    jsonb_build_object(
      'bucket', 'tenant-private',
      'disposition', 'quarantine',
      'mediaType', intent.media_type,
      'declaredSizeBytes', intent.declared_size_bytes,
      'uploadIntentId', intent.intent_id
    ),
    'learning-upload-source:' || intent.intent_id
  )
  on conflict (tenant_id, idempotency_key)
    where idempotency_key is not null
  do update set updated_at = public.learning_sources.updated_at
  returning public.learning_sources.source_id into source_id;

  insert into public.ingestion_jobs (
    tenant_id,
    course_id,
    source_id,
    job_type,
    status,
    priority,
    payload_ref,
    trace_id,
    max_attempts,
    idempotency_key
  ) values (
    caller.tenant_id,
    target_course_id,
    source_id,
    'upload_ingestion',
    'waiting',
    100,
    intent.object_key,
    'upload-ingestion:' || intent.intent_id,
    5,
    'learning-upload-job:' || intent.intent_id
  )
  on conflict (tenant_id, idempotency_key)
  do update set updated_at = public.ingestion_jobs.updated_at
  returning public.ingestion_jobs.ingestion_job_id into job_id;

  insert into public.ingestion_checkpoints (
    tenant_id,
    ingestion_job_id,
    stage,
    checkpoint_key,
    status,
    input_hash,
    metrics,
    idempotency_key
  ) values (
    caller.tenant_id,
    job_id,
    'security',
    'malware_scan',
    'pending',
    encode(digest(intent.object_key || ':' || observed_size::text, 'sha256'), 'hex'),
    jsonb_build_object(
      'observedSizeBytes', observed_size,
      'disposition', 'quarantine'
    ),
    'learning-upload-scan:' || intent.intent_id
  )
  on conflict (tenant_id, ingestion_job_id, checkpoint_key)
  do update set updated_at = public.ingestion_checkpoints.updated_at;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'intentId', intent.intent_id,
    'courseId', target_course_id,
    'sourceId', source_id,
    'ingestionJobId', job_id,
    'status', 'waiting',
    'nextCheckpoint', 'malware_scan',
    'promotionAllowed', false
  );
end;
$$;

create or replace function public.learning_list_quarantine_uploads()
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
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'intentId', ui.intent_id,
        'filename', ui.filename,
        'mediaType', ui.media_type,
        'declaredSizeBytes', ui.declared_size_bytes,
        'uploadStatus', ui.status,
        'expiresAt', ui.expires_at,
        'createdAt', ui.created_at,
        'ingestionJobId', ij.ingestion_job_id,
        'ingestionStatus', ij.status,
        'nextCheckpoint', ic.checkpoint_key
      )
      order by ui.created_at desc
    ),
    '[]'::jsonb
  ) into items
  from public.upload_intents ui
  left join public.learning_sources ls
    on ls.tenant_id = ui.tenant_id
   and ls.external_ref = ui.object_key
   and ls.source_type = 'upload'
  left join public.ingestion_jobs ij
    on ij.tenant_id = ui.tenant_id
   and ij.source_id = ls.source_id
  left join public.ingestion_checkpoints ic
    on ic.tenant_id = ui.tenant_id
   and ic.ingestion_job_id = ij.ingestion_job_id
   and ic.status in ('pending', 'running', 'failed')
  where ui.tenant_id = caller.tenant_id
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'items', items
  );
end;
$$;

revoke execute on function public.learning_create_upload_intent(
  uuid, uuid, text, text, bigint, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_confirm_quarantine_upload(
  uuid, uuid
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_list_quarantine_uploads()
  from public, anon, authenticated, service_role;
grant execute on function public.learning_create_upload_intent(
  uuid, uuid, text, text, bigint, text, timestamptz, jsonb
) to authenticated;
grant execute on function public.learning_confirm_quarantine_upload(
  uuid, uuid
) to authenticated;
grant execute on function public.learning_list_quarantine_uploads()
  to authenticated;

commit;
