-- The shared learning RPC context intentionally exposes only verified tenant,
-- principal and role facts. Resolve the exact active membership before writing
-- usage rows instead of assuming the context record contains a membership id.

begin;

create or replace function public.learning_record_usage_event(
  requested_event_name text,
  requested_idempotency_key text,
  requested_properties jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  caller_membership_id text;
  allowed_property_keys constant text[] := array[
    'courseId', 'lessonId', 'conversationId', 'modality', 'intent',
    'status', 'durationMs', 'sourceCount', 'errorCode', 'reconnectCount'
  ];
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select m.membership_id
  into caller_membership_id
  from public.identity_memberships m
  where m.tenant_id = caller.tenant_id
    and m.principal_id = caller.principal_id
    and m.role = caller.identity_role
    and m.status = 'active'
    and m.deleted_at is null
  limit 1;
  if caller_membership_id is null then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_event_name not in (
    'auth.sign_in',
    'auth.password_changed',
    'account.provisioned',
    'learning.workspace_opened',
    'learning.course_started',
    'learning.course_completed',
    'learning.lesson_opened',
    'learning.lesson_completed',
    'conversation.started',
    'conversation.turn_completed',
    'learning.source_opened',
    'voice.session_started',
    'voice.session_ended',
    'voice.interrupted',
    'voice.reconnected',
    'voice.error',
    'upload.intent_created',
    'upload.quarantine_confirmed'
  )
    or requested_idempotency_key is null
    or length(requested_idempotency_key) not between 8 and 200
    or jsonb_typeof(coalesce(requested_properties, '{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(requested_properties, '{}'::jsonb)) > 4096
    or exists (
      select 1
      from jsonb_object_keys(coalesce(requested_properties, '{}'::jsonb)) k
      where k <> all(allowed_property_keys)
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  insert into public.learning_usage_events (
    tenant_id, principal_id, membership_id, identity_role, event_name,
    properties, idempotency_key
  ) values (
    caller.tenant_id,
    caller.principal_id,
    caller_membership_id,
    caller.identity_role,
    requested_event_name,
    coalesce(requested_properties, '{}'::jsonb),
    requested_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) do nothing;

  insert into public.telemetry_outbox (
    outbox_id, tenant_id, idempotency_key, topic, payload,
    payload_fingerprint, available_at
  ) values (
    'usage:' || requested_idempotency_key,
    caller.tenant_id,
    'usage:' || requested_idempotency_key,
    'learning.usage',
    jsonb_build_object(
      'eventName', requested_event_name,
      'properties', coalesce(requested_properties, '{}'::jsonb)
    ),
    encode(
      extensions.digest(
        convert_to(
          requested_event_name || ':' ||
          coalesce(requested_properties, '{}'::jsonb)::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    clock_timestamp()
  )
  on conflict (tenant_id, idempotency_key) do nothing;

  return jsonb_build_object('ok', true, 'dataMode', 'durable');
end;
$$;

revoke execute on function public.learning_record_usage_event(
  text, text, jsonb
) from public, anon, service_role;
grant execute on function public.learning_record_usage_event(
  text, text, jsonb
) to authenticated;

commit;
