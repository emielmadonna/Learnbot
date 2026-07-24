-- Provider responses are replayed from the durable transcript after a client
-- retry. This prevents a lost HTTP response from causing another model call.

begin;

create or replace function public.learning_get_completed_turn(
  target_conversation_id uuid,
  assistant_idempotency_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  message_record public.messages%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_selection_required'
    );
  end if;
  if target_conversation_id is null
    or assistant_idempotency_key is null
    or length(assistant_idempotency_key) not between 18 and 200
    or assistant_idempotency_key not like 'assistant:%'
  then
    raise invalid_parameter_value using message = 'Invalid turn replay key';
  end if;

  if not exists (
    select 1
    from public.conversations c
    where c.tenant_id = caller.tenant_id
      and c.conversation_id = target_conversation_id
      and c.subject_user_id = auth.uid()
      and c.deleted_at is null
  ) then
    raise insufficient_privilege
      using message = 'The conversation is not accessible';
  end if;

  select m.*
  into message_record
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.conversation_id = target_conversation_id
    and m.idempotency_key = assistant_idempotency_key
    and m.actor_type = 'assistant'
    and m.status = 'final'
    and m.deleted_at is null;

  if not found then
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'completed', false,
      'conversationId', target_conversation_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'completed', true,
    'conversationId', message_record.conversation_id,
    'message', jsonb_build_object(
      'messageId', message_record.message_id,
      'role', 'assistant',
      'content', message_record.body,
      'createdAt', message_record.created_at,
      'sources', coalesce(
        message_record.structured_content -> 'sources',
        '[]'::jsonb
      )
    )
  );
end;
$$;

revoke all on function public.learning_get_completed_turn(uuid, text)
  from public, anon, service_role;
grant execute on function public.learning_get_completed_turn(uuid, text)
  to authenticated;
revoke execute on function public.learning_get_completed_turn(uuid, text)
  from service_role;

commit;
