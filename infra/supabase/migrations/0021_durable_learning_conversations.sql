-- Durable learner conversations. User-authored messages remain bound to the
-- verified selected tenant. Assistant messages additionally require a
-- server-held operation token so a browser cannot forge provider output.

begin;

create table app_private.learning_operation_secrets (
  operation_secret_id uuid primary key default gen_random_uuid(),
  capability text not null
    check (capability in ('conversation.answer.record')),
  token_hash text not null
    check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (capability, token_hash),
  check (expires_at > created_at),
  check (revoked_at is null or status = 'revoked')
);
revoke all on table app_private.learning_operation_secrets
  from public, anon, authenticated, service_role;

create or replace function app_private.learning_operation_token_is_valid(
  requested_capability text,
  operation_token text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select operation_token is not null
    and length(operation_token) between 32 and 512
    and exists (
      select 1
      from app_private.learning_operation_secrets s
      where s.capability = requested_capability
        and s.status = 'active'
        and s.expires_at > statement_timestamp()
        and s.token_hash = encode(
          extensions.digest(operation_token, 'sha256'),
          'hex'
        )
    );
$$;
revoke execute on function app_private.learning_operation_token_is_valid(
  text,
  text
) from public, anon, authenticated, service_role;

create or replace function public.learning_start_conversation(
  target_course_id uuid,
  target_lesson_id uuid,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  target record;
  existing record;
  created public.conversations%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    raise insufficient_privilege
      using message = 'A selected authenticated tenant is required';
  end if;
  if idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid idempotency key';
  end if;

  select c.*
  into existing
  from public.conversations c
  where c.tenant_id = caller.tenant_id
    and c.idempotency_key = learning_start_conversation.idempotency_key
    and c.subject_user_id = auth.uid()
    and c.deleted_at is null;
  if found then
    if existing.course_id is distinct from target_course_id
      or existing.lesson_id is distinct from target_lesson_id
    then
      raise unique_violation
        using message = 'The idempotency key has different conversation input';
    end if;
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true,
      'conversationId', existing.conversation_id,
      'courseId', existing.course_id,
      'moduleId', existing.module_id,
      'lessonId', existing.lesson_id,
      'status', existing.status,
      'channelState', existing.channel_state
    );
  end if;

  if target_lesson_id is not null then
    select
      l.lesson_id,
      l.module_id,
      l.course_id,
      l.title as lesson_title,
      c.title as course_title
    into target
    from public.lessons l
    join public.modules m
      on m.tenant_id = l.tenant_id
     and m.module_id = l.module_id
    join public.courses c
      on c.tenant_id = l.tenant_id
     and c.course_id = l.course_id
    where l.tenant_id = caller.tenant_id
      and l.lesson_id = target_lesson_id
      and l.deleted_at is null
      and m.deleted_at is null
      and c.deleted_at is null
      and (target_course_id is null or c.course_id = target_course_id)
      and (
        caller.identity_role <> 'student'
        or (
          l.status = 'published'
          and m.status = 'published'
          and c.status = 'published'
        )
      );
  elsif target_course_id is not null then
    select
      null::uuid as lesson_id,
      null::uuid as module_id,
      c.course_id,
      null::text as lesson_title,
      c.title as course_title
    into target
    from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
      and (caller.identity_role <> 'student' or c.status = 'published');
  else
    select
      null::uuid as lesson_id,
      null::uuid as module_id,
      null::uuid as course_id,
      null::text as lesson_title,
      null::text as course_title
    into target;
  end if;

  if not found then
    raise insufficient_privilege
      using message = 'The requested learning context is not accessible';
  end if;

  insert into public.conversations (
    tenant_id,
    subject_user_id,
    course_id,
    module_id,
    lesson_id,
    channel_state,
    status,
    title,
    metadata,
    idempotency_key
  ) values (
    caller.tenant_id,
    auth.uid(),
    target.course_id,
    target.module_id,
    target.lesson_id,
    'text',
    'active',
    case
      when target.lesson_title is not null
        then 'Ask about ' || target.lesson_title
      when target.course_title is not null
        then 'Ask about ' || target.course_title
      else 'Learning conversation'
    end,
    jsonb_build_object(
      'dataMode', 'durable',
      'grounding', 'published_tenant_knowledge'
    ),
    idempotency_key
  )
  returning * into created;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'conversationId', created.conversation_id,
    'courseId', created.course_id,
    'moduleId', created.module_id,
    'lessonId', created.lesson_id,
    'status', created.status,
    'channelState', created.channel_state
  );
end;
$$;

create or replace function public.learning_get_conversations(
  target_conversation_id uuid default null
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
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_selection_required'
    );
  end if;

  select jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversations', coalesce(jsonb_agg(
      jsonb_build_object(
        'conversationId', c.conversation_id,
        'courseId', c.course_id,
        'moduleId', c.module_id,
        'lessonId', c.lesson_id,
        'title', c.title,
        'status', c.status,
        'channelState', c.channel_state,
        'startedAt', c.started_at,
        'updatedAt', c.updated_at,
        'messages', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'messageId', m.message_id,
              'actorType', m.actor_type,
              'modality', m.modality,
              'status', m.status,
              'body', m.body,
              'structuredContent', m.structured_content,
              'sequenceNumber', m.sequence_number,
              'createdAt', m.created_at
            )
            order by m.sequence_number
          )
          from public.messages m
          where m.tenant_id = c.tenant_id
            and m.conversation_id = c.conversation_id
            and m.deleted_at is null
        ), '[]'::jsonb)
      )
      order by c.updated_at desc, c.conversation_id
    ), '[]'::jsonb)
  )
  into result
  from (
    select candidate.*
    from public.conversations candidate
    where candidate.tenant_id = caller.tenant_id
      and candidate.subject_user_id = auth.uid()
      and candidate.deleted_at is null
      and (
        target_conversation_id is null
        or candidate.conversation_id = target_conversation_id
      )
    order by candidate.updated_at desc, candidate.conversation_id
    limit case when target_conversation_id is null then 20 else 1 end
  ) c;

  return result;
end;
$$;

create or replace function public.learning_record_user_message(
  target_conversation_id uuid,
  message_body text,
  message_modality text,
  trace_id text,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  conversation_record record;
  existing public.messages%rowtype;
  created public.messages%rowtype;
  actor_type_value text;
  next_sequence bigint;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    raise insufficient_privilege
      using message = 'A selected authenticated tenant is required';
  end if;
  message_body := btrim(message_body);
  if target_conversation_id is null
    or message_body is null
    or length(message_body) not between 1 and 8000
    or message_modality not in ('text', 'voice_transcript')
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid learner message';
  end if;

  select c.conversation_id
  into conversation_record
  from public.conversations c
  where c.tenant_id = caller.tenant_id
    and c.conversation_id = target_conversation_id
    and c.subject_user_id = auth.uid()
    and c.status = 'active'
    and c.deleted_at is null;
  if not found then
    raise insufficient_privilege
      using message = 'The conversation is not accessible';
  end if;

  select *
  into existing
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.idempotency_key = learning_record_user_message.idempotency_key;
  if found then
    if existing.conversation_id <> target_conversation_id
      or existing.actor_id is distinct from auth.uid()
      or existing.body is distinct from message_body
      or existing.modality is distinct from message_modality
    then
      raise unique_violation
        using message = 'The idempotency key has different message input';
    end if;
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true,
      'messageId', existing.message_id,
      'conversationId', existing.conversation_id,
      'sequenceNumber', existing.sequence_number
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_conversation_id::text, 0)
  );
  select coalesce(max(m.sequence_number), -1) + 1
  into next_sequence
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.conversation_id = target_conversation_id;

  actor_type_value := case caller.identity_role
    when 'tenant_owner' then 'owner'
    when 'tenant_admin' then 'owner'
    when 'creator' then 'creator'
    when 'teacher' then 'creator'
    else 'student'
  end;

  insert into public.messages (
    tenant_id,
    conversation_id,
    actor_id,
    actor_type,
    modality,
    status,
    body,
    trace_id,
    sequence_number,
    idempotency_key
  ) values (
    caller.tenant_id,
    target_conversation_id,
    auth.uid(),
    actor_type_value,
    message_modality,
    'final',
    message_body,
    trace_id,
    next_sequence,
    idempotency_key
  )
  returning * into created;

  update public.conversations
  set updated_at = statement_timestamp()
  where tenant_id = caller.tenant_id
    and conversation_id = target_conversation_id;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'messageId', created.message_id,
    'conversationId', created.conversation_id,
    'sequenceNumber', created.sequence_number
  );
end;
$$;

create or replace function public.learning_record_assistant_message(
  target_conversation_id uuid,
  message_body text,
  sources jsonb,
  provider_key text,
  provider_request_ref text,
  trace_id text,
  idempotency_key text,
  operation_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  conversation_record record;
  existing public.messages%rowtype;
  created public.messages%rowtype;
  next_sequence bigint;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    raise insufficient_privilege
      using message = 'A selected authenticated tenant is required';
  end if;
  message_body := btrim(message_body);
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    operation_token
  ) then
    raise insufficient_privilege using message = 'Invalid operation token';
  end if;
  if target_conversation_id is null
    or message_body is null
    or length(message_body) not between 1 and 16000
    or sources is null
    or jsonb_typeof(sources) <> 'array'
    or jsonb_array_length(sources) > 12
    or provider_key is null
    or length(provider_key) not between 1 and 100
    or provider_request_ref is null
    or length(provider_request_ref) not between 1 and 256
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid assistant message';
  end if;

  select c.conversation_id
  into conversation_record
  from public.conversations c
  where c.tenant_id = caller.tenant_id
    and c.conversation_id = target_conversation_id
    and c.subject_user_id = auth.uid()
    and c.status = 'active'
    and c.deleted_at is null;
  if not found then
    raise insufficient_privilege
      using message = 'The conversation is not accessible';
  end if;

  select *
  into existing
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.idempotency_key =
      learning_record_assistant_message.idempotency_key;
  if found then
    if existing.conversation_id <> target_conversation_id
      or existing.actor_type <> 'assistant'
      or existing.body is distinct from message_body
      or existing.structured_content is distinct from jsonb_build_object(
        'sources',
        sources,
        'grounding',
        'published_tenant_knowledge'
      )
    then
      raise unique_violation
        using message = 'The idempotency key has different assistant input';
    end if;
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'replayed', true,
      'messageId', existing.message_id,
      'conversationId', existing.conversation_id,
      'sequenceNumber', existing.sequence_number
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_conversation_id::text, 0)
  );
  select coalesce(max(m.sequence_number), -1) + 1
  into next_sequence
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.conversation_id = target_conversation_id;

  insert into public.messages (
    tenant_id,
    conversation_id,
    actor_id,
    actor_type,
    modality,
    status,
    body,
    structured_content,
    provider_key,
    provider_request_ref,
    trace_id,
    sequence_number,
    idempotency_key
  ) values (
    caller.tenant_id,
    target_conversation_id,
    null,
    'assistant',
    'text',
    'final',
    message_body,
    jsonb_build_object(
      'sources',
      sources,
      'grounding',
      'published_tenant_knowledge'
    ),
    provider_key,
    provider_request_ref,
    trace_id,
    next_sequence,
    idempotency_key
  )
  returning * into created;

  update public.conversations
  set updated_at = statement_timestamp()
  where tenant_id = caller.tenant_id
    and conversation_id = target_conversation_id;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'messageId', created.message_id,
    'conversationId', created.conversation_id,
    'sequenceNumber', created.sequence_number
  );
end;
$$;

revoke all on function public.learning_start_conversation(uuid, uuid, text)
  from public, anon, service_role;
revoke all on function public.learning_get_conversations(uuid)
  from public, anon, service_role;
revoke all on function public.learning_record_user_message(
  uuid,
  text,
  text,
  text,
  text
) from public, anon, service_role;
revoke all on function public.learning_record_assistant_message(
  uuid,
  text,
  jsonb,
  text,
  text,
  text,
  text,
  text
) from public, anon, service_role;

grant execute on function public.learning_start_conversation(uuid, uuid, text)
  to authenticated;
grant execute on function public.learning_get_conversations(uuid)
  to authenticated;
grant execute on function public.learning_record_user_message(
  uuid,
  text,
  text,
  text,
  text
) to authenticated;
grant execute on function public.learning_record_assistant_message(
  uuid,
  text,
  jsonb,
  text,
  text,
  text,
  text,
  text
) to authenticated;

commit;
