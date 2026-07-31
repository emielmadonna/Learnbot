-- ============================================================
-- 20260731080000_widget_question_labels_and_ratable_answers.sql
-- The two widget-side analytics paths that were built at one end only.
--
-- WHAT THE DATA SAID
--
-- Grouped by surface, one tenant's 16 recorded questions split like this:
--
--   authenticated path   4 asked   4 labelled
--   widget / hosted     12 asked   0 labelled
--
-- Nought out of twelve is not a classifier that keeps failing. A classifier
-- that fails leaves a reason code behind, and there is none, because
-- /api/widget/ask never calls one: it records the question, answers it,
-- records the answer, and stops. `public.learning_record_question_label`
-- cannot be the missing call either -- it opens with
-- `app_private.learning_rpc_context()`, which needs a Supabase session, and
-- the widget client is anonymous by construction. So the widget half of
-- question intelligence needed a server-authorised write path of its own.
-- This file is that path, and nothing else about classification changes: a
-- fault still writes no label and still never guesses one.
--
-- WHY THIS FUNCTION TAKES AN IDEMPOTENCY KEY AND NOT A MESSAGE ID
--
-- The authenticated function is handed the question's `message_id`, because
-- the console legitimately holds one. The widget server does not: `widget_ask`
-- returns `conversationRef`, `sequence`, `assistantName`, `retrievalMode` and
-- the matches, and deliberately no UUID of any kind. Rather than widen that
-- return -- a third revision of a function that already has one pending, and a
-- new UUID on an anonymous surface -- this function re-derives the question
-- from the key the caller already minted: `widget_ask` stored the question
-- under `'widget-user:' || conversation_hash || ':' || idempotency_key`, and
-- the same (widget key, origin, conversation ref, idempotency key) tuple
-- reproduces it exactly. A tuple from another widget, another origin or
-- another conversation hashes differently and simply matches nothing.
--
-- The gate is `conversation.answer.record`, the same operation token that
-- already authorises `widget_record_answer`. A browser holding only the public
-- widget key cannot label anything: the token is server-held and never leaves
-- the application server.
--
-- WHY THE ANSWER RECORD NOW RETURNS ITS MESSAGE ID
--
-- 20260731061000 shipped `public.widget_record_answer_feedback(widget_key,
-- origin, conversation_ref, target_message_id uuid, requested_rating)` and
-- granted it to `anon` -- a complete, correct anonymous rating write. It has
-- never been reachable, because nothing tells the widget which message to
-- name. `widget_record_answer` returns only `conversationRef` and `sequence`,
-- and /api/widget/ask forwards neither as an id, so the runtime's only handle
-- on an answer is the client-minted `"w" + random` item id its own adapter
-- invented. The console had exactly this bug on the authenticated side: a
-- rating control keyed on a client-minted placeholder that the API rejected,
-- so every click 400'd. Adding `messageId` to this return is what makes the
-- widget rate an id the server will actually accept, rather than one it
-- refuses.
--
-- Returning that UUID to the page is safe for the same reason
-- 20260731070000 argues a visual asset id is: it has exactly one public use,
-- and that use re-checks ownership. `widget_record_answer_feedback` joins the
-- message to the conversation the caller proved it holds, so a message id from
-- someone else's conversation matches nothing. It is a write-scoped handle to
-- an answer the visitor was just shown, not a readable pointer into tenant
-- structure -- no endpoint returns a message body for one.
--
-- Nothing else in `widget_record_answer` changes: same token gate, same
-- resolve, same validation, same conversation lookup, same append.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Anonymous question labelling.
--
--    Mirrors public.learning_record_question_label field for field, including
--    the rule that matters most: the grounding outcome is READ from the
--    recorded answer, never asserted by the caller. The classifier's opinion
--    about topic, intent and importance is the only thing that travels.
-- ---------------------------------------------------------------------------

create or replace function public.widget_record_question_label(
  widget_key text,
  origin text,
  conversation_ref text,
  question_idempotency_key text,
  topic_key text,
  topic_label text,
  question_intent text,
  importance text,
  classifier_key text,
  classifier_version text,
  trace_id text,
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
  question record;
  answer_sources jsonb;
  answer_found boolean;
  resolved_grounding text;
  normalized_topic_key text := lower(
    btrim(coalesce(widget_record_question_label.topic_key, ''))
  );
  normalized_topic_label text := btrim(
    coalesce(widget_record_question_label.topic_label, '')
  );
  normalized_intent text := lower(
    btrim(coalesce(widget_record_question_label.question_intent, ''))
  );
  normalized_importance text := lower(
    btrim(coalesce(widget_record_question_label.importance, ''))
  );
  written public.question_labels%rowtype;
begin
  -- The token first, so an unauthorised caller learns nothing about whether
  -- the key, the origin or the conversation was the part that did not match.
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or question_idempotency_key is null
    or length(question_idempotency_key) not between 8 and 200
    or normalized_topic_key !~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'
    or length(normalized_topic_label) not between 1 and 80
    or not (normalized_intent = any (app_private.question_intent_taxonomy()))
    or app_private.question_importance_rank(normalized_importance) is null
    or classifier_key is null
    or length(classifier_key) not between 1 and 100
    or classifier_version is null
    or length(classifier_version) not between 1 and 40
    or trace_id is null
    or length(trace_id) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  -- The question is re-derived from the key widget_ask wrote it under. It must
  -- still be a real, final, visitor-authored message inside a live widget
  -- conversation belonging to this tenant.
  select
    m.message_id,
    m.conversation_id,
    m.created_at,
    m.sequence_number,
    conv.subject_user_id,
    conv.course_id,
    conv.module_id,
    conv.lesson_id
  into question
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  where m.tenant_id = resolved.tenant_id
    and m.idempotency_key =
      'widget-user:' || conversation_hash || ':' || question_idempotency_key
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type = 'student'
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null
    and conv.idempotency_key = 'widget:' || conversation_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'question_not_found');
  end if;

  select m.structured_content -> 'sources'
  into answer_sources
  from public.messages m
  where m.tenant_id = resolved.tenant_id
    and m.conversation_id = question.conversation_id
    and m.sequence_number > question.sequence_number
    and m.actor_type = 'assistant'
    and m.status = 'final'
    and m.deleted_at is null
  order by m.sequence_number
  limit 1;
  answer_found := found;

  -- The no-answer branch comes first on purpose, exactly as in the
  -- authenticated function: an answer carrying no sources array at all is
  -- 'not_recorded', never 'grounded'.
  resolved_grounding := case
    when not answer_found then 'no_answer'
    when answer_sources is null
      or jsonb_typeof(answer_sources) <> 'array' then 'not_recorded'
    when jsonb_array_length(answer_sources) = 0 then 'ungrounded'
    else 'grounded'
  end;

  insert into public.question_labels (
    tenant_id, message_id, conversation_id, subject_user_id, course_id,
    module_id, lesson_id, topic_key, topic_label, question_intent, importance,
    importance_rank, grounding_outcome, classifier_key, classifier_version,
    asked_at, labelled_at, trace_id, idempotency_key
  ) values (
    resolved.tenant_id,
    question.message_id,
    question.conversation_id,
    question.subject_user_id,
    question.course_id,
    question.module_id,
    question.lesson_id,
    normalized_topic_key,
    normalized_topic_label,
    normalized_intent,
    normalized_importance,
    app_private.question_importance_rank(normalized_importance),
    resolved_grounding,
    widget_record_question_label.classifier_key,
    widget_record_question_label.classifier_version,
    question.created_at,
    statement_timestamp(),
    widget_record_question_label.trace_id,
    'widget-label:' || conversation_hash || ':' || question_idempotency_key
  )
  on conflict (tenant_id, message_id) do update
  set topic_key = excluded.topic_key,
      topic_label = excluded.topic_label,
      question_intent = excluded.question_intent,
      importance = excluded.importance,
      importance_rank = excluded.importance_rank,
      grounding_outcome = excluded.grounding_outcome,
      classifier_key = excluded.classifier_key,
      classifier_version = excluded.classifier_version,
      labelled_at = excluded.labelled_at,
      trace_id = excluded.trace_id,
      idempotency_key = excluded.idempotency_key,
      deleted_at = null
  returning * into written;

  -- No topic, no intent and no message id travel back to the browser. The
  -- caller is the application server, and all it needs to know is that the
  -- label landed.
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'groundingOutcome', written.grounding_outcome,
    'recordVersion', written.record_version,
    'replaced', written.record_version > 1
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The recorded answer names itself, so it can be rated.
--
--    Byte-for-byte the 20260726093000 body with one key added to the returned
--    object. Restated in full rather than patched, because there is no way to
--    patch a plpgsql body in place.
-- ---------------------------------------------------------------------------

create or replace function public.widget_record_answer(
  widget_key text,
  origin text,
  conversation_ref text,
  answer_body text,
  sources jsonb,
  provider_key text,
  provider_request_ref text,
  idempotency_key text,
  trace_id text,
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
  conversation_id uuid;
  recorded public.messages%rowtype;
  normalized_answer text := btrim(coalesce(answer_body, ''));
begin
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if length(normalized_answer) not between 1 and 16000
    or conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or sources is null
    or jsonb_typeof(sources) <> 'array'
    or jsonb_array_length(sources) > 12
    or provider_key is null
    or length(provider_key) not between 1 and 100
    or provider_request_ref is null
    or length(provider_request_ref) not between 1 and 256
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
    or trace_id is null
    or length(trace_id) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  select c.conversation_id
  into conversation_id
  from public.conversations c
  where c.tenant_id = resolved.tenant_id
    and c.idempotency_key = 'widget:' || conversation_hash
    and c.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  recorded := app_private.widget_append_message(
    resolved.tenant_id,
    conversation_id,
    'assistant',
    'text',
    normalized_answer,
    jsonb_build_object(
      'sources', sources,
      'grounding', 'published_tenant_knowledge',
      'channel', 'widget'
    ),
    provider_key,
    provider_request_ref,
    trace_id,
    'widget-assistant:' || conversation_hash || ':' || idempotency_key
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversationRef', conversation_ref,
    'sequence', recorded.sequence_number,
    -- The one addition. A replayed idempotency key returns the ORIGINAL row
    -- here (widget_append_message returns `existing`), so a retried turn
    -- rates the answer the visitor actually saw rather than a second copy.
    'messageId', recorded.message_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants. Closed first, then opened only to the caller that exists.
--
--    `anon` because the application server calls these with the browser-safe
--    publishable key and no session, exactly as it calls widget_ask and
--    widget_record_answer. The real gate on both is the operation token, which
--    a browser never holds.
-- ---------------------------------------------------------------------------

revoke execute on function public.widget_record_question_label(
  text, text, text, text, text, text, text, text, text, text, text, text
) from public, authenticated, service_role;
grant execute on function public.widget_record_question_label(
  text, text, text, text, text, text, text, text, text, text, text, text
) to anon;

revoke execute on function public.widget_record_answer(
  text, text, text, text, jsonb, text, text, text, text, text
) from public, authenticated, service_role;
grant execute on function public.widget_record_answer(
  text, text, text, text, jsonb, text, text, text, text, text
) to anon;

commit;
