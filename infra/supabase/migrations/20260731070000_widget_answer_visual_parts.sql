-- ============================================================
-- 20260731070000_widget_answer_visual_parts.sql
-- Carry visual identity through widget retrieval, so an anonymous answer can
-- actually show the visual it was grounded on.
--
-- THE GAP THIS CLOSES
--
-- 20260731045059 taught the shared ranker to enrich each match's `source`
-- envelope with presentation-safe visual metadata
-- (`app_private.visual_source_for_match`: visualAssetId, mediaType,
-- visualKind, altText). The authenticated route reads exactly those keys and
-- builds an inline image or video from them
-- (api/learning/respond/route.ts, normalizeSources).
--
-- 20260731060000 then built the anonymous delivery half: a disclosure ledger,
-- a widget-scoped reader, and a streaming route at
-- /api/widget/visuals/:id/content.
--
-- Both halves were correct and neither could ever fire, because the one
-- function joining them threw the fields away. `public.widget_ask`
-- (20260726093000, the only definition) re-projects each enriched match into a
-- narrow object:
--
--     'sourceRef', match ->> 'contentHash',
--     'courseTitle', ..., 'documentTitle', ...,
--     'lessonTitle', match -> 'source' ->> 'lessonName',
--     'sectionName', match -> 'source' ->> 'sectionName',
--     'excerpt', ..., 'contentHash', ...
--
-- `source -> 'visualAssetId'` is not in that list. So the answering server
-- never learned that a cited chunk WAS a visual, never recorded a disclosure,
-- and therefore could never mint a readable media URL: every read would have
-- failed the disclosure predicate with `visual_not_found`. The narrow
-- projection was deliberate -- the widget must never see course, document or
-- lesson UUIDs -- and this migration keeps that rule. It adds back exactly the
-- four keys 20260731045059 already declared presentation-safe, and nothing
-- else.
--
-- WHY A VISUAL ASSET ID IS SAFE TO RETURN HERE AND A LESSON ID IS NOT
--
-- A lesson id is a durable handle into tenant-private structure with no
-- public read path; leaking one is pure downside. A visual asset id has
-- exactly one public read path -- /api/widget/visuals/:id/content -- and that
-- path already refuses to serve anything without a matching disclosure row
-- for the caller's own conversation. So the id is only useful to the visitor
-- the assistant just showed it to, which is precisely the intended audience.
-- The id it returns is also, by construction, one the tenant has published and
-- marked `show_in_answers`: `visual_source_for_match` filters on
-- `course.status = 'published'`, `visual.status = 'active'`,
-- `show_in_answers`, and a completed `server_media_inspection_v1` validation
-- before it will emit a single key.
--
-- Nothing else in the function changes: the same resolve, the same
-- anonymous-questions gate, the same rate limit before any write, the same
-- course-ref re-derivation, the same message recording, the same retrieval
-- call, the same operation-token-gated directive.
-- ============================================================

begin;

create or replace function public.widget_ask(
  widget_key text,
  origin text,
  question text,
  conversation_ref text,
  course_ref text,
  idempotency_key text,
  trace_id text,
  operation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  settings jsonb;
  conversation_hash text;
  conversation_id uuid;
  scoped_course_id uuid;
  limited jsonb;
  retrieval jsonb;
  recorded public.messages%rowtype;
  normalized_question text := btrim(coalesce(question, ''));
  trusted_server boolean;
begin
  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;
  settings := resolved.settings;

  -- Anonymous asking is opt-in per tenant, and the refusal is the same opaque
  -- code so a disabled tenant is not distinguishable from an unknown key.
  if not coalesce((settings ->> 'anonymousQuestions')::boolean, false) then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if length(normalized_question) not between 2 and 2000
    or conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or (course_ref is not null and course_ref !~ '^[0-9a-f]{32}$')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  -- Before any write and before any retrieval. See A6.
  limited := app_private.widget_rate_limit(
    resolved.tenant_widget_key_id, conversation_hash
  );
  if limited is not null then
    return limited;
  end if;

  -- A course ref is resolved by re-deriving it, so a ref from another widget
  -- or another tenant simply matches nothing.
  if course_ref is not null then
    select c.course_id
    into scoped_course_id
    from public.courses c
    where c.tenant_id = resolved.tenant_id
      and c.deleted_at is null
      and c.status = 'published'
      and app_private.widget_course_ref(widget_key, c.course_id) = course_ref
    limit 1;
    if scoped_course_id is null then
      return jsonb_build_object('ok', false, 'code', 'invalid_request');
    end if;
  end if;

  conversation_id := app_private.widget_conversation(
    resolved.tenant_id, conversation_hash, scoped_course_id
  );
  if conversation_id is null then
    return jsonb_build_object('ok', false, 'code', 'request_denied');
  end if;

  recorded := app_private.widget_append_message(
    resolved.tenant_id,
    conversation_id,
    'student',
    'text',
    normalized_question,
    jsonb_build_object('channel', 'widget'),
    null,
    null,
    trace_id,
    'widget-user:' || conversation_hash || ':' || idempotency_key
  );

  -- The widget has no embedding worker of its own, so this is the lexical half
  -- of the shared ranking and it says so rather than claiming hybrid recall.
  retrieval := app_private.learning_chunk_matches(
    resolved.tenant_id,
    normalized_question,
    null::extensions.vector(384),
    scoped_course_id,
    6,
    case
      when settings -> 'courseScope' is null then resolved.agent_course_scope
      else settings -> 'courseScope'
    end
  );

  trusted_server := app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversationRef', conversation_ref,
    'sequence', recorded.sequence_number,
    'assistantName', resolved.assistant_name,
    'retrievalMode', coalesce(retrieval ->> 'retrievalMode', 'unavailable'),
    'matches', coalesce(
      (
        select jsonb_agg(
          -- Unchanged, and deliberately NOT strip_nulls'd: `lessonTitle` and
          -- `sectionName` have always been present-and-null for a match that
          -- has neither, and the TypeScript contract reads them as
          -- `string | null`.
          jsonb_build_object(
            'sourceRef', match ->> 'contentHash',
            'courseTitle', match ->> 'courseTitle',
            'documentTitle', match ->> 'documentTitle',
            'lessonTitle', match -> 'source' ->> 'lessonName',
            'sectionName', match -> 'source' ->> 'sectionName',
            'excerpt', match ->> 'excerpt',
            'contentHash', match ->> 'contentHash'
          )
          -- The four presentation-safe visual keys, and only those. They are
          -- absent (stripped) for every non-visual match, which is what lets
          -- the answering server tell the two apart without ever seeing a
          -- course, document or lesson UUID.
          || jsonb_strip_nulls(jsonb_build_object(
            'visualAssetId', match -> 'source' ->> 'visualAssetId',
            'visualKind', match -> 'source' ->> 'visualKind',
            'mediaType', match -> 'source' ->> 'mediaType',
            'altText', match -> 'source' ->> 'altText'
          ))
        )
        from jsonb_array_elements(coalesce(retrieval -> 'matches', '[]'::jsonb))
          as match
      ),
      '[]'::jsonb
    )
  ) || case
    when trusted_server then jsonb_build_object(
      'directive', jsonb_build_object(
        'personaInstructions', resolved.persona_instructions,
        'tone', resolved.agent_tone
      )
    )
    else '{}'::jsonb
  end;
end;
$$;

-- `create or replace` preserves the existing ACL, but the grants are restated
-- so this file is readable on its own and so a future replacement that does
-- create the function fresh (which would grant PUBLIC execute by default) is
-- closed here rather than silently opened.
revoke execute on function public.widget_ask(
  text, text, text, text, text, text, text, text
) from public, authenticated, service_role;
grant execute on function public.widget_ask(
  text, text, text, text, text, text, text, text
) to anon;

commit;
