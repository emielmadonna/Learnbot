-- Release-gate hardening for external course sources.
--
-- 1. Blank source-course creation now uses the exact authoring role gate.
--    The original migration admitted teachers at the database RPC even though
--    the application and every structural authoring RPC exclude them.
-- 2. Circle projection proves the supplied Vault reference belongs to the
--    active connection for the same tenant before storing it on a source.
--    This prevents a service-layer regression from attaching another tenant's
--    opaque credential reference to an otherwise tenant-scoped source row.

begin;

create or replace function public.learning_create_source_course(
  requested_title text,
  requested_source_kind text,
  requested_external_ref text,
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  normalized_title text := btrim(coalesce(requested_title, ''));
  normalized_kind text := lower(btrim(coalesce(requested_source_kind, '')));
  normalized_external text := btrim(coalesce(requested_external_ref, ''));
  normalized_request text := btrim(coalesce(requested_idempotency_key, ''));
  fingerprint text;
  new_course_id uuid := gen_random_uuid();
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if length(normalized_title) not between 3 and 160
    or normalized_kind not in ('youtube', 'circle')
    or length(normalized_external) not between 1 and 500
    or normalized_request !~ '^[A-Za-z0-9:_-]{8,200}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        normalized_title,
        normalized_kind,
        normalized_external
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'learning.source-course.create',
    normalized_request,
    fingerprint,
    'learning_create_source_course'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  insert into public.courses (
    course_id,
    tenant_id,
    external_id,
    title,
    description,
    status,
    metadata,
    idempotency_key
  ) values (
    new_course_id,
    caller.tenant_id,
    normalized_kind || ':' || normalized_external,
    normalized_title,
    'Created from a connected ' || normalized_kind ||
      ' source. No sample lessons were added.',
    'draft',
    jsonb_build_object(
      'source', 'external_connector',
      'sourceKind', normalized_kind,
      'externalRef', normalized_external,
      'blankAtCreation', true
    ),
    'source-course:' || normalized_request
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'created', true,
    'courseId', new_course_id,
    'title', normalized_title,
    'status', 'draft',
    'lessonCount', 0
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'learning.source-course.create',
    normalized_request,
    result
  );
  perform app_private.ingestion_append_audit(
    caller.tenant_id,
    caller.identity_role,
    'learning.source-course.create',
    new_course_id::text,
    normalized_request
  );
  return result;
end;
$$;

revoke execute on function public.learning_create_source_course(
  text, text, text, text
) from public, anon, service_role;
grant execute on function public.learning_create_source_course(
  text, text, text, text
) to authenticated;

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
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  normalized_kind text := lower(btrim(coalesce(source_kind, '')));
begin
  if normalized_kind = 'circle'
    and not exists (
      select 1
      from app_private.learning_source_connections connection
      where connection.tenant_id = target_tenant_id
        and connection.provider = 'circle'
        and connection.status = 'active'
        and connection.revoked_at is null
        and 'vault://' || connection.vault_secret_id::text =
          source_credential_vault_ref
    )
  then
    return jsonb_build_object(
      'ok', false, 'code', 'credential_scope_mismatch'
    );
  end if;

  return app_private.project_learning_source_connector(
    caller_auth_user_id, target_tenant_id, target_course_id, source_kind,
    external_ref, source_name, source_configuration, source_documents,
    source_content_hash, replace_active_knowledge,
    requested_idempotency_key, source_credential_vault_ref
  );
end;
$$;

revoke execute on function public.learning_source_connector_sync(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.learning_source_connector_sync(
  uuid, uuid, uuid, text, text, text, jsonb, jsonb, text, boolean, text, text
) to service_role;

commit;
