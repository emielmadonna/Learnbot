-- ---------------------------------------------------------------------------
-- Widget conversation history
--
-- WHY THIS EXISTS
--
-- `api/widget/ask/route.ts` passed `history: []` to `groundedAnswerRequest`,
-- hardcoded, while the authenticated console path passes the real transcript
-- (`api/learning/respond/route.ts`, `normalizeHistory(transcript)`). The two
-- surfaces implement the same feature and only one of them was conversational.
--
-- The visible symptom: a visitor asks a full question, gets a grounded answer,
-- types "what" as a follow-up, and is told "I couldn't find this in the
-- published learning yet." Every turn arrived as a cold, isolated query.
--
-- The console reads the transcript with the caller's own session. The widget
-- has no session - the visitor is anonymous - so it needs a definer RPC that
-- re-checks the (key, origin) pair exactly as `widget_ask` and
-- `widget_record_answer` do, and returns only that one conversation's turns.
--
-- Deliberately reuses the `conversation.answer.record` capability rather than
-- introducing a new one: `app_private.learning_operation_secrets` constrains
-- `capability` with `check (capability in ('conversation.answer.record'))`
-- (0021), so a new scope would be a second schema change with a second
-- rotation procedure for no additional isolation. This function is a read of
-- turns the same secret already lets the caller write.
--
-- ASCII only, on purpose. The Supabase SQL editor mangles non-ASCII on paste,
-- and a corrupted character inside a $$-quoted body is a silent behaviour
-- change rather than a syntax error.
-- ---------------------------------------------------------------------------

begin;

create or replace function public.widget_conversation_history(
  widget_key text,
  origin text,
  conversation_ref text,
  turn_limit integer,
  operation_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  conversation_hash text;
  target_conversation_id uuid;
  -- The provider window is the last 8 turns (`conversationMessages` in
  -- lib/learning-provider.ts slices to 8), so anything above that is fetched
  -- and discarded. 16 is the hard ceiling regardless of what the caller asks
  -- for, and a null or nonsense value lands on the 8 the provider will use.
  effective_limit integer := least(greatest(coalesce(turn_limit, 8), 1), 16);
  turns jsonb;
begin
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    -- Same opaque code as every other widget entry point. An unknown key, a
    -- revoked key, a disabled widget and an origin that is not on the list
    -- are deliberately indistinguishable from each other here.
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  select c.conversation_id
  into target_conversation_id
  from public.conversations c
  where c.tenant_id = resolved.tenant_id
    and c.idempotency_key = 'widget:' || conversation_hash
    and c.deleted_at is null;

  if not found then
    -- The first turn of a new thread has no conversation row yet. That is the
    -- normal opening state, not a failure, and it must not read as one: an
    -- empty turn list is the correct answer and the caller proceeds.
    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'conversationRef', conversation_ref,
      'turns', '[]'::jsonb
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('actorType', recent.actor_type, 'body', recent.body)
      order by recent.sequence_number
    ),
    '[]'::jsonb
  )
  into turns
  from (
    select m.actor_type, m.body, m.sequence_number
    from public.messages m
    where m.tenant_id = resolved.tenant_id
      and m.conversation_id = target_conversation_id
      and m.deleted_at is null
      and m.status = 'final'
      and m.body is not null
      and btrim(m.body) <> ''
      -- 'creator', 'owner' and 'system' rows are not part of what the learner
      -- said or was told, and must never be replayed to the provider as if
      -- they were. The widget only ever writes 'student' and 'assistant'.
      and m.actor_type in ('student', 'assistant')
    order by m.sequence_number desc
    limit effective_limit
  ) recent;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversationRef', conversation_ref,
    'turns', coalesce(turns, '[]'::jsonb)
  );
end;
$$;

-- Closed first, then opened only to the caller that exists. `anon` because the
-- application server calls this with the browser-safe publishable key and no
-- session, exactly as it calls widget_ask and widget_record_answer. The real
-- gate is the operation token, which a browser never holds.
revoke execute on function public.widget_conversation_history(
  text, text, text, integer, text
) from public, authenticated, service_role;
grant execute on function public.widget_conversation_history(
  text, text, text, integer, text
) to anon;

commit;
