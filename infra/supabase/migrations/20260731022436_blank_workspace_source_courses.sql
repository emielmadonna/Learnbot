-- A blank workspace must be able to choose a real external source before it
-- has any authored course. This RPC creates only an empty destination shell;
-- it never inserts sample lessons or copied tenant knowledge.

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
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
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

commit;
