-- ============================================================
-- 20260731090000_widget_self_reported_learner_identity.sql
-- Let an embedded widget question be attributed to a person, without ever
-- claiming that person was verified.
--
-- THE GAP THIS CLOSES
--
-- Insights reports distinct authenticated learners from the console path.
-- Every question asked through the embedded widget carries no person at all,
-- so "this learner is stuck", repeat-question detection and any per-learner
-- signal are blind on the surface that actually produces the questions.
--
-- Both ends of the wire already speak identity and the middle drops it:
--
--   * public.conversation_surfaces (20260726094000) has visitor_key and
--     visitor_identity, and app_private.surface_visitor_key HMACs a reference
--     with a per-install pepper so no raw identifier is ever stored.
--   * packages/widget-runtime declares
--     IdentityTier = "anonymous" | "self_reported" | "verified" and renders a
--     distinct label for each.
--   * public.widget_ask takes no visitor argument whatsoever, so nothing the
--     page knows can reach the database.
--
-- This migration adds that argument and records what arrives.
--
-- WHY THIS IS 'self_reported' AND NOT 'verified'
--
-- The only host integration in hand is Circle, which exposes window.circleUser
-- to a site code snippet. That is plain client-side data with no signature, no
-- nonce and no server-to-server exchange: anyone with devtools open can set it
-- to any value before the widget reads it. The chain from that object to this
-- function is browser -> /api/widget/ask -> widget_ask, and no link in it can
-- prove anything. public.widget_ask is granted to anon precisely because its
-- caller has no session to check.
--
-- So 'verified' is not merely unearned here, it is unreachable, and this
-- function refuses it as invalid_request rather than accepting a word it
-- cannot honour. 'verified' stays reserved for an identity the server can
-- actually prove, which is what makes the runtime's three-tier type worth
-- having.
--
-- WHY A NEW COLUMN INSTEAD OF A THIRD visitor_identity VALUE
--
-- This was the tempting shortcut and it would have quietly falsified six
-- shipped analytics functions.
--
-- conversation_surfaces.visitor_key does not mean "a person" today. Every
-- widget row's key is derived from the conversation idempotency key
-- ('widget:' || conversation_hash), which is a per-browser-session nonce the
-- embed keeps in sessionStorage. app_private.conversation_surface_view
-- computes exactly that, and app_private.widget_signal_detections says so in
-- the text it shows a customer: "An anonymous visitor reference identifies a
-- returning browser, not a person, and is never added to the verified-learner
-- count." That sentence is true, and six analytics bodies
-- (surface_question_totals, analytics_tenant_overview,
-- analytics_surface_breakdown, analytics_widget_engagement,
-- analytics_widget_content_gaps, widget_signal_detections) count
-- distinct visitor_key on the strength of it.
--
-- Writing a person-stable hash into that same column would have changed what
-- all six numbers mean without changing a line of any of them, and would have
-- made that customer-facing sentence false. Adding 'self_reported_learner' to
-- visitor_identity has the mirror-image failure: every one of those bodies
-- filters on the literals 'anonymous_visitor' and 'verified_learner', so the
-- new rows would have been silently dropped from both buckets.
--
-- So the person-stable pseudonym gets its own column, learner_key, with its
-- own trust label, learner_identity. visitor_identity keeps its two values and
-- an identified widget visitor is still recorded as 'anonymous_visitor',
-- which stays literally true: that column answers "did this platform verify a
-- learner", and the answer is no. learner_identity answers the separate
-- question "did the host page declare who this is, and how far can that be
-- trusted", and the answer is 'self_reported'. Neither statement borrows the
-- other's credibility, and no existing count moves by one.
--
-- The row this function writes is deliberately constructed so that
-- visitor_key holds precisely the value conversation_surface_view was already
-- synthesising for the same conversation. Recording a surface row therefore
-- cannot change any distinct-visitor count that a tenant has already seen.
--
-- WHAT DOES NOT CHANGE
--
-- The RLS boundary on public.conversation_surfaces is untouched:
-- conversation_surfaces_no_direct_access still refuses every authenticated
-- read, no RPC returns learner_key or visitor_key, and widget_ask reports only
-- whether a learner was counted, never which one. The raw visitor reference is
-- never stored in any column; only its peppered HMAC is.
-- ============================================================

begin;

-- ------------------------------------------------- storage

alter table public.conversation_surfaces
  add column learner_key text
    check (learner_key is null or learner_key ~ '^[0-9a-f]{64}$'),
  add column learner_identity text not null default 'unidentified'
    check (learner_identity in ('unidentified', 'self_reported_learner'));

-- The label and the pseudonym are one fact and may never disagree: a row
-- claiming a self-reported learner without a key would be an identity nobody
-- can count, and a key without the label would be a pseudonym with no recorded
-- provenance.
alter table public.conversation_surfaces
  add constraint conversation_surfaces_learner_pairing
    check ((learner_identity = 'self_reported_learner') = (learner_key is not null));

-- Only the embedded widget has a host page that can declare anything. The
-- console already knows who its learner is, from a session, and must never
-- acquire a weaker second identity alongside it.
alter table public.conversation_surfaces
  add constraint conversation_surfaces_learner_widget_only
    check (learner_identity = 'unidentified' or surface = 'widget');

create index conversation_surfaces_learner_idx
  on public.conversation_surfaces (tenant_id, learner_key)
  where deleted_at is null and learner_key is not null;

-- ------------------------------------------------- sanctioned reader

-- app_private.conversation_surface_view is the only sanctioned read path for
-- this table, so the new columns are added to it or they are unreachable by
-- construction. The return type changes, which create or replace cannot do, so
-- the function is dropped and rebuilt. Nothing else in it changes: the body
-- below is the 20260726094000 body with two expressions appended, and every
-- existing caller selects columns by name (v.surface, v.visitor_key, ...), so
-- appending is invisible to all sixteen of them.
drop function if exists app_private.conversation_surface_view(uuid);
create function app_private.conversation_surface_view(
  target_tenant_id uuid
)
returns table (
  conversation_id uuid,
  surface text,
  widget_key text,
  host_origin text,
  host_path text,
  host_page_title text,
  visitor_key text,
  visitor_identity text,
  attribution_source text,
  learner_key text,
  learner_identity text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    c.conversation_id,
    coalesce(
      s.surface,
      case
        when c.metadata ->> 'surface' in ('console', 'widget', 'api')
          then c.metadata ->> 'surface'
        -- 20260726093000 writes metadata.channel = 'widget' on every
        -- conversation public.widget_ask opens. That is the durable fact, so
        -- it is read rather than duplicated.
        when c.metadata ->> 'channel' in ('console', 'widget', 'api')
          then c.metadata ->> 'channel'
      end,
      'console'
    ),
    coalesce(s.widget_key, nullif(btrim(coalesce(c.metadata ->> 'widgetKey', '')), '')),
    coalesce(s.host_origin, nullif(lower(btrim(coalesce(c.metadata ->> 'hostOrigin', ''))), '')),
    coalesce(s.host_path, nullif(btrim(coalesce(c.metadata ->> 'hostPath', '')), '')),
    coalesce(s.host_page_title, nullif(btrim(coalesce(c.metadata ->> 'hostPageTitle', '')), '')),
    -- The delivery path stores the widget's conversation reference only as a
    -- salted digest, inside the conversation idempotency key. Re-digesting
    -- that under the analytics pepper yields a stable per-visitor count while
    -- holding neither the browser value nor anything that could reproduce it.
    coalesce(
      s.visitor_key,
      case
        when c.idempotency_key like 'widget:%'
          then app_private.surface_visitor_key(c.tenant_id, c.idempotency_key)
      end
    ),
    coalesce(
      s.visitor_identity,
      case
        when c.metadata ->> 'visitorIdentity'
          in ('verified_learner', 'anonymous_visitor')
          then c.metadata ->> 'visitorIdentity'
        -- 20260726093000 marks an unauthenticated widget visitor with
        -- identityTier = 'anonymous' and gives them a synthetic
        -- subject_user_id. That synthetic subject is exactly why the
        -- pre-existing learner count needs the caveat this file adds: without
        -- it, an anonymous browser would be indistinguishable from a person
        -- the platform authenticated.
        when c.metadata ->> 'identityTier' = 'anonymous'
          then 'anonymous_visitor'
      end,
      'verified_learner'
    ),
    case
      when s.surface_record_id is not null then s.attribution_source
      when c.metadata ->> 'surface' in ('console', 'widget', 'api')
        or c.metadata ->> 'channel' in ('console', 'widget', 'api')
        then 'conversation_metadata'
      when c.started_at < app_private.surface_attribution_epoch()
        then 'backfilled_console'
      else 'inferred_console'
    end,
    -- No fallback and no inference. A learner pseudonym exists only where a
    -- host page actually declared one and public.widget_ask recorded it; every
    -- other conversation reports null and 'unidentified' rather than a guess.
    s.learner_key,
    coalesce(s.learner_identity, 'unidentified')
  from public.conversations c
  left join public.conversation_surfaces s
    on s.tenant_id = c.tenant_id
   and s.conversation_id = c.conversation_id
   and s.deleted_at is null
  where c.tenant_id = target_tenant_id
    and c.deleted_at is null;
$$;
revoke execute on function app_private.conversation_surface_view(uuid)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------- delivery

-- public.widget_ask gains visitor_ref and visitor_tier.
--
-- The old eight-argument function is DROPPED rather than left in place. Adding
-- two defaulted arguments with create or replace would produce an overload,
-- and PostgREST calls this function by name with a named-argument object, so
-- an eight-key call would then be ambiguous ("function is not unique") and
-- every widget question would fail. Dropping first is what makes the change
-- safe, and the grants are restated below because a drop takes the ACL with
-- it.
drop function if exists public.widget_ask(
  text, text, text, text, text, text, text, text
);
create function public.widget_ask(
  widget_key text,
  origin text,
  question text,
  conversation_ref text,
  course_ref text,
  idempotency_key text,
  trace_id text,
  operation_token text default null,
  visitor_ref text default null,
  visitor_tier text default null
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
  normalized_visitor_ref text := nullif(btrim(coalesce(visitor_ref, '')), '');
  normalized_visitor_tier text :=
    nullif(btrim(lower(coalesce(visitor_tier, ''))), '');
  normalized_origin text;
  learner_hash text;
  -- A second name for the same conversation, used only inside the surface DML
  -- below. public.conversation_surfaces has a conversation_id column, and a
  -- plpgsql local of the same name is ambiguous the moment that table is in
  -- scope (plpgsql.variable_conflict defaults to error). Renaming here keeps
  -- the rest of this body byte-identical to 20260731070000.
  surface_conversation uuid;
  surface_exists boolean;
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
    -- 'verified' is refused, not downgraded. Nothing in this call path can
    -- establish it (see the header), so accepting the word and storing
    -- something weaker would leave a caller believing it had been honoured.
    or (normalized_visitor_tier is not null
      and normalized_visitor_tier not in ('anonymous', 'self_reported'))
    -- An opaque account handle: identifiers, slugs and UUIDs pass, anything
    -- with an at-sign or whitespace does not. That deliberately refuses a raw
    -- email address at the boundary, so a mistaken install cannot put a
    -- mailbox on the wire even though it would never have been stored. The
    -- 180-character ceiling keeps the namespaced input below the 200-character
    -- limit app_private.surface_visitor_key enforces, which would otherwise
    -- return null and drop the identity in silence.
    or (normalized_visitor_ref is not null
      and normalized_visitor_ref !~ '^[A-Za-z0-9_.:-]{3,180}$')
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

  -- A declared learner, recorded. Both halves must be present: a reference
  -- with no tier, or a tier of 'anonymous', records nothing at all and leaves
  -- this function behaving exactly as it did before this migration.
  --
  -- The reference is namespaced before it is hashed so a host account handle
  -- can never collide with the 'widget:<hash>' conversation digests the same
  -- pepper produces for the anonymous population.
  if normalized_visitor_tier = 'self_reported'
    and normalized_visitor_ref is not null
  then
    learner_hash := app_private.surface_visitor_key(
      resolved.tenant_id,
      'widget-learner' || chr(31) || normalized_visitor_ref
    );
  end if;

  if learner_hash is not null then
    normalized_origin := lower(btrim(coalesce(origin, '')));
    if normalized_origin !~ '^https?://[a-z0-9._:\-\[\]]{1,180}$' then
      normalized_origin := null;
    end if;

    surface_conversation := conversation_id;

    -- Update-then-insert rather than ON CONFLICT, matching
    -- public.learning_record_conversation_surface. Index inference would have
    -- to name conversation_id, which is also a local here, and a surface row
    -- is written at most once per conversation so the race window is a single
    -- visitor's own first two questions.
    update public.conversation_surfaces s
    set
      widget_key = coalesce(widget_ask.widget_key, s.widget_key),
      host_origin = coalesce(normalized_origin, s.host_origin),
      learner_key = learner_hash,
      learner_identity = 'self_reported_learner',
      attribution_source = 'recorded',
      last_seen_at = greatest(s.last_seen_at, now()),
      deleted_at = null
    -- visitor_key and visitor_identity are deliberately absent from the SET
    -- list. A conversation that already carries a recorded surface keeps the
    -- visitor accounting it was written with; this statement only ever adds
    -- the learner half. The surface predicate is the same refusal
    -- learning_record_conversation_surface makes: a conversation cannot change
    -- surface, so a contradicting row is left alone rather than rewritten.
    where s.tenant_id = resolved.tenant_id
      and s.conversation_id = surface_conversation
      and s.surface = 'widget';

    if not found then
      select true into surface_exists
      from public.conversation_surfaces s
      where s.tenant_id = resolved.tenant_id
        and s.conversation_id = surface_conversation;

      if surface_exists is not true then
        insert into public.conversation_surfaces (
          tenant_id,
          conversation_id,
          surface,
          widget_key,
          host_origin,
          visitor_key,
          visitor_identity,
          learner_key,
          learner_identity,
          attribution_source,
          idempotency_key
        ) values (
          resolved.tenant_id,
          surface_conversation,
          'widget',
          widget_ask.widget_key,
          normalized_origin,
          -- Exactly the digest app_private.conversation_surface_view already
          -- synthesises for this conversation, so materialising the row cannot
          -- move a distinct-visitor count a tenant has already been shown.
          app_private.surface_visitor_key(
            resolved.tenant_id, 'widget:' || conversation_hash
          ),
          'anonymous_visitor',
          learner_hash,
          'self_reported_learner',
          'recorded',
          'widget-surface:' || conversation_hash
        );
      end if;
    end if;
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
    -- What was recorded about the asker, and nothing that could identify them.
    -- The pseudonym itself never leaves the database; the caller learns only
    -- whether one was counted, which is what lets the page render an honest
    -- "identity not verified" label instead of guessing.
    'learnerIdentity', case
      when learner_hash is not null then 'self_reported_learner'
      else 'unidentified'
    end,
    'learnerCounted', learner_hash is not null,
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

-- The drop above took the ACL with it, so these are the grants rather than a
-- restatement of them. anon and nothing else, exactly as before: a visitor to
-- a customer page has no session, and no other role has any business calling
-- an origin-checked public entry point.
revoke execute on function public.widget_ask(
  text, text, text, text, text, text, text, text, text, text
) from public, authenticated, service_role;
grant execute on function public.widget_ask(
  text, text, text, text, text, text, text, text, text, text
) to anon;

commit;
