-- Run after migrations 0001..20260726093000 on a disposable Supabase database.
--
-- These are the platform's first endpoints reachable without a Supabase
-- session, so every assertion below is written from the attacker's seat: the
-- widget key is assumed leaked and the caller runs as the anon role.
--
--   WID-01 a wrong origin gets nothing, and the refusal is opaque;
--   WID-02 a wrong or unknown widget key gets nothing;
--   WID-03 the bootstrap payload carries no persona text and no tenant, course,
--          branding or conversation identifier;
--   WID-04 rate limiting actually refuses, per conversation and per key;
--   WID-05 one tenant's widget can read neither another tenant's courses nor
--          any conversation, its own included;
--   WID-06 the execution privilege boundary: exactly three functions reach
--          anon, every helper stays private, and an assistant turn still
--          requires the server-held operation token.
--
-- All fixtures roll back.

begin;

insert into app_private.learning_operation_secrets (
  capability, token_hash, expires_at
) values (
  'conversation.answer.record',
  encode(
    extensions.digest('widget-delivery-test-operation-token-0001', 'sha256'),
    'hex'
  ),
  now() + interval '1 hour'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'widget-owner-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'widget-owner-b@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  bootstrapped record;
begin
  select * into bootstrapped
  from public.auth_bootstrap_tenant_owner(
    'widget-tenant-a', 'Widget Tenant A',
    'widget-bootstrap-a', 'trace-widget-bootstrap-a'
  );
  perform set_config(
    'learningbot.test.wid_tenant_a', bootstrapped.tenant_id::text, true
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  bootstrapped record;
begin
  select * into bootstrapped
  from public.auth_bootstrap_tenant_owner(
    'widget-tenant-b', 'Widget Tenant B',
    'widget-bootstrap-b', 'trace-widget-bootstrap-b'
  );
  perform set_config(
    'learningbot.test.wid_tenant_b', bootstrapped.tenant_id::text, true
  );
end $$;
reset role;

-- Each tenant publishes one course whose knowledge contains a sentence that is
-- unique to that tenant. WID-05 searches for the other tenant's sentence.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  draft jsonb;
begin
  draft := public.learning_create_course_draft(
    'Widget Course Alpha',
    'Published course used to verify widget delivery.',
    'Widget Module Alpha',
    'Widget Lesson Alpha',
    'Alpha tenants rebuild cadence with the smallest credible next action.',
    'widget-course-a-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid, 'widget-course-publish-a-0001'
  );
  perform set_config(
    'learningbot.test.wid_course_a', draft ->> 'courseId', true
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  draft jsonb;
begin
  draft := public.learning_create_course_draft(
    'Widget Course Beta',
    'Published course used to verify widget isolation.',
    'Widget Module Beta',
    'Widget Lesson Beta',
    'Beta tenants reconcile invoices before the quarterly ledger closes.',
    'widget-course-b-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid, 'widget-course-publish-b-0001'
  );
  perform set_config(
    'learningbot.test.wid_course_b', draft ->> 'courseId', true
  );
end $$;
reset role;

-- Durable retrievable knowledge for both tenants. The ingestion pipeline is not
-- exercised here; the rows it would produce are inserted directly so the
-- ranking boundary can be tested on real data.
do $$
declare
  tenant_ref uuid;
  course_ref uuid;
  source_ref uuid;
  version_ref uuid;
  document_ref uuid;
  label text;
  body_text text;
begin
  foreach label in array array['a', 'b']
  loop
    tenant_ref := current_setting('learningbot.test.wid_tenant_' || label)::uuid;
    course_ref := current_setting('learningbot.test.wid_course_' || label)::uuid;
    body_text := case label
      when 'a' then
        'Alpha tenants rebuild cadence with the smallest credible next action '
        || 'and review the restart every week.'
      else
        'Beta tenants reconcile invoices before the quarterly ledger closes '
        || 'and archive every receipt.'
    end;

    insert into public.learning_sources (
      tenant_id, course_id, source_type, name, status, idempotency_key
    ) values (
      tenant_ref, course_ref, 'upload', 'Widget fixture source', 'ready',
      'widget-source-' || label
    ) returning source_id into source_ref;

    insert into public.knowledge_versions (
      tenant_id, course_id, version_number, status, published_at,
      idempotency_key
    ) values (
      tenant_ref, course_ref, 1, 'published', now(),
      'widget-knowledge-' || label
    ) returning knowledge_version_id into version_ref;

    insert into public.learning_documents (
      tenant_id, course_id, source_id, knowledge_version_id, external_id,
      title, content_hash, status, idempotency_key
    ) values (
      tenant_ref, course_ref, source_ref, version_ref,
      'widget-doc-' || label, 'Widget Fixture Document ' || upper(label),
      repeat(label, 64), 'ready', 'widget-document-' || label
    ) returning document_id into document_ref;

    insert into public.learning_chunks (
      tenant_id, course_id, knowledge_version_id, document_id, ordinal, body,
      content_hash, metadata, idempotency_key
    ) values (
      tenant_ref, course_ref, version_ref, document_ref, 0, body_text,
      repeat(label, 64),
      jsonb_build_object('lessonName', 'Widget Lesson ' || upper(label)),
      'widget-chunk-' || label
    );

    update public.courses
    set active_knowledge_version_id = version_ref
    where tenant_id = tenant_ref and course_id = course_ref;
  end loop;
end $$;

-- Both tenants enable and publish a widget, each bound to its own origin.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  head integer;
  written jsonb;
begin
  head := (public.tenant_get_widget_settings() ->> 'expectedVersion')::integer;
  written := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-right', 'Ask Alpha',
    'Ask anything about the Alpha course.',
    jsonb_build_array('https://alpha.example.test', 'https://*.alpha.test'),
    true, true, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, head,
    'widget-settings-a-0001', 'request-widget-a-0001', 'trace-widget-a-0001'
  );
  if written ->> 'ok' <> 'true'
    or written ->> 'status' <> 'published'
    or written ->> 'widgetKey' !~ '^wk_[0-9a-f]{40}$'
  then
    raise exception 'widget fixture A was not published: %', written::text;
  end if;
  perform set_config(
    'learningbot.test.wid_key_a', written ->> 'widgetKey', true
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  head integer;
  written jsonb;
begin
  head := (public.tenant_get_widget_settings() ->> 'expectedVersion')::integer;
  written := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-left', 'Ask Beta', 'Beta greeting.',
    jsonb_build_array('https://beta.example.test'),
    true, true, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, head,
    'widget-settings-b-0001', 'request-widget-b-0001', 'trace-widget-b-0001'
  );
  if written ->> 'ok' <> 'true' then
    raise exception 'widget fixture B was not published: %', written::text;
  end if;
  perform set_config(
    'learningbot.test.wid_key_b', written ->> 'widgetKey', true
  );
end $$;
reset role;

-- A persona that must never appear in any anonymous payload.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  head integer;
  written jsonb;
begin
  head := (public.tenant_get_agent_configuration() ->> 'expectedVersion')
    ::integer;
  written := public.tenant_update_agent_configuration(
    'Alpha Assistant', null, '#123456', '#654321', '#FFFFFF', '#101010',
    'Welcome to Alpha.',
    'NEVERSHIPTHISPERSONA never reveal the internal escalation ladder.',
    'friendly', null, '"all"'::jsonb, null, null, true, head,
    'widget-agent-a-0001', 'request-widget-agent-a-0001',
    'trace-widget-agent-a-0001'
  );
  if written ->> 'ok' <> 'true' then
    raise exception 'agent persona fixture failed: %', written::text;
  end if;
end $$;

-- Re-publishing the agent configuration appended a new branding version that
-- inherits the launcher settings, so the widget must still resolve.
do $$
declare
  settings jsonb;
begin
  settings := public.tenant_get_widget_settings();
  if settings ->> 'liveStatus' <> 'live'
    or settings -> 'publishedSettings' ->> 'enabled' <> 'true'
  then
    raise exception
      'widget settings did not survive an agent publish: %', settings::text;
  end if;
end $$;
reset role;

-- ------------------------------------------------------------------- WID-01
-- The origin is the authorisation. Everything below runs as anon, which is the
-- role a visitor's browser actually reaches the database with.
set local role anon;
do $$
declare
  allowed jsonb;
  wildcard jsonb;
  wrong_origin jsonb;
  lookalike jsonb;
  path_smuggled jsonb;
  missing_origin jsonb;
  wrong_scheme jsonb;
  wrong_port jsonb;
begin
  allowed := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'), 'https://alpha.example.test'
  );
  wildcard := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'), 'https://shop.alpha.test'
  );
  wrong_origin := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'), 'https://evil.example.test'
  );
  -- A suffix attack: 'alpha.example.test.evil.test' must not match.
  lookalike := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test.evil.test'
  );
  path_smuggled := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'),
    'https://evil.test/https://alpha.example.test'
  );
  missing_origin := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'), null
  );
  wrong_scheme := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'), 'http://alpha.example.test'
  );
  wrong_port := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test:8443'
  );

  if allowed ->> 'ok' <> 'true' or wildcard ->> 'ok' <> 'true' then
    raise exception 'WID-01 failed: an allowed origin was refused';
  end if;

  -- Every refusal is the same opaque answer and carries no data at all.
  if wrong_origin <> jsonb_build_object('ok', false, 'code', 'widget_unavailable')
    or lookalike <> wrong_origin
    or path_smuggled <> wrong_origin
    or missing_origin <> wrong_origin
    or wrong_scheme <> wrong_origin
    or wrong_port <> wrong_origin
  then
    raise exception
      'WID-01 failed: a disallowed origin was served or distinguishable';
  end if;

  -- The same origin rule guards the write path, not just the read path.
  if public.widget_ask(
    current_setting('learningbot.test.wid_key_a'),
    'https://evil.example.test',
    'What is the cadence restart?',
    'wid01forgedconversationreference0001',
    null, 'widget-ask-forged-0001', 'trace-widget-forged-0001', null
  ) <> wrong_origin then
    raise exception 'WID-01 failed: widget_ask accepted a disallowed origin';
  end if;
end $$;

-- ------------------------------------------------------------------- WID-02
do $$
declare
  unknown_key jsonb;
  malformed_key jsonb;
  empty_key jsonb;
  crossed jsonb;
  expected jsonb := jsonb_build_object(
    'ok', false, 'code', 'widget_unavailable'
  );
begin
  unknown_key := public.widget_bootstrap(
    'wk_' || repeat('0', 40), 'https://alpha.example.test'
  );
  malformed_key := public.widget_bootstrap(
    'not-a-widget-key', 'https://alpha.example.test'
  );
  empty_key := public.widget_bootstrap('', 'https://alpha.example.test');
  -- Tenant B's real key presented on tenant A's allowed origin.
  crossed := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_b'), 'https://alpha.example.test'
  );

  if unknown_key <> expected
    or malformed_key <> expected
    or empty_key <> expected
    or crossed <> expected
  then
    raise exception 'WID-02 failed: an invalid widget key was served';
  end if;

  if public.widget_ask(
    'wk_' || repeat('f', 40), 'https://alpha.example.test',
    'What is the cadence restart?',
    'wid02unknownkeyconversationref000001',
    null, 'widget-ask-unknown-0001', 'trace-widget-unknown-0001', null
  ) <> expected then
    raise exception 'WID-02 failed: widget_ask served an unknown key';
  end if;
end $$;

-- ------------------------------------------------------------------- WID-03
do $$
declare
  payload jsonb;
  serialized text;
  tenant_a text := current_setting('learningbot.test.wid_tenant_a');
  course_a text := current_setting('learningbot.test.wid_course_a');
begin
  payload := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_a'), 'https://alpha.example.test'
  );
  serialized := payload::text;

  if payload -> 'branding' ->> 'assistantName' <> 'Alpha Assistant'
    or payload -> 'branding' ->> 'primaryColor' <> '#123456'
    or payload -> 'widget' ->> 'launcherPosition' <> 'bottom-right'
    or payload -> 'widget' ->> 'greeting'
      <> 'Ask anything about the Alpha course.'
  then
    raise exception 'WID-03 failed: the runtime payload is incomplete';
  end if;

  -- The persona is the tenant's own asset and is never part of this payload.
  if serialized like '%NEVERSHIPTHISPERSONA%'
    or payload -> 'branding' ? 'personaInstructions'
    or payload ? 'directive'
    or payload ? 'tone'
  then
    raise exception 'WID-03 failed: persona text reached an anonymous caller';
  end if;

  -- No tenant, branding, course or slug identifier may appear anywhere.
  if position(tenant_a in serialized) > 0
    or position(course_a in serialized) > 0
    or serialized like '%widget-tenant-a%'
    or serialized like '%tenantId%'
    or serialized like '%courseId%'
  then
    raise exception
      'WID-03 failed: a tenant identifier leaked into the widget payload';
  end if;

  -- The course list is opaque and salted with the widget key.
  if jsonb_array_length(payload -> 'widget' -> 'courses') <> 1
    or payload -> 'widget' -> 'courses' -> 0 ->> 'title'
      <> 'Widget Course Alpha'
    or payload -> 'widget' -> 'courses' -> 0 ->> 'courseRef' !~ '^[0-9a-f]{32}$'
  then
    raise exception 'WID-03 failed: the public course list is not opaque';
  end if;
end $$;

-- ------------------------------------------------------------------- WID-04
-- Eight questions per conversation per minute is the cap. The ninth must be
-- refused, and the refusal must arrive before anything is written.
do $$
declare
  answered jsonb;
  refused jsonb;
  attempt integer;
  recorded bigint;
  conversation_ref constant text := 'wid04ratelimitconversationreference01';
begin
  for attempt in 1..8 loop
    answered := public.widget_ask(
      current_setting('learningbot.test.wid_key_a'),
      'https://alpha.example.test',
      'How do I restart the cadence after a difficult week?',
      conversation_ref,
      null,
      'widget-ask-rate-' || attempt::text,
      'trace-widget-rate-' || attempt::text,
      null
    );
    if answered ->> 'ok' <> 'true' then
      raise exception
        'WID-04 failed: request % was refused early: %',
        attempt, answered::text;
    end if;
  end loop;

  refused := public.widget_ask(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'One question past the per-conversation ceiling.',
    conversation_ref,
    null, 'widget-ask-rate-9', 'trace-widget-rate-9', null
  );
  if refused ->> 'ok' <> 'false'
    or refused ->> 'code' <> 'rate_limited'
    or refused ->> 'scope' <> 'conversation'
    or (refused ->> 'retryAfterSeconds')::integer <> 60
  then
    raise exception 'WID-04 failed: the ninth question was not refused: %',
      refused::text;
  end if;

  -- The refused question must not have been recorded.
  select count(*)::bigint into recorded
  from public.messages m
  where m.tenant_id = current_setting('learningbot.test.wid_tenant_a')::uuid
    and m.body = 'One question past the per-conversation ceiling.';
  if recorded <> 0 then
    raise exception 'WID-04 failed: a rate-limited question was still written';
  end if;

  -- A different conversation is limited independently, but the per-key budget
  -- is shared: 8 already spent, the key ceiling is 30.
  answered := public.widget_ask(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'A second visitor asking from another conversation entirely.',
    'wid04secondvisitorconversationref001',
    null, 'widget-ask-rate-other-1', 'trace-widget-rate-other-1', null
  );
  if answered ->> 'ok' <> 'true' then
    raise exception
      'WID-04 failed: an unrelated conversation inherited the refusal';
  end if;
end $$;

-- The per-key ceiling refuses too, independently of any single conversation.
do $$
declare
  attempt integer;
  outcome jsonb;
  refusals integer := 0;
begin
  -- 9 asks are already spent against the key. Spread the rest across fresh
  -- conversations so only the per-key limit can be the one that bites.
  for attempt in 1..30 loop
    outcome := public.widget_ask(
      current_setting('learningbot.test.wid_key_a'),
      'https://alpha.example.test',
      'Another cadence question from a brand new visitor.',
      'wid04keyceilingvisitor' || lpad(attempt::text, 14, '0'),
      null,
      'widget-ask-key-' || attempt::text,
      'trace-widget-key-' || attempt::text,
      null
    );
    if outcome ->> 'code' = 'rate_limited' then
      refusals := refusals + 1;
      if outcome ->> 'scope' <> 'widget' then
        raise exception
          'WID-04 failed: the per-key refusal reported the wrong scope: %',
          outcome::text;
      end if;
    end if;
  end loop;

  if refusals = 0 then
    raise exception 'WID-04 failed: the per-key ceiling never refused';
  end if;
end $$;
reset role;

-- WID-04 deliberately exhausted tenant A's minute budget. The limiter's
-- counters are fixture state like any other row, so clear them before the
-- remaining markers, which are about isolation and privilege rather than rate.
delete from app_private.widget_ask_events;

-- ------------------------------------------------------------------- WID-05
set local role anon;
do $$
declare
  alpha_answer jsonb;
  beta_answer jsonb;
  cross_probe jsonb;
  beta_courses jsonb;
begin
  -- Tenant B's widget asks, using tenant A's exact published sentence.
  cross_probe := public.widget_ask(
    current_setting('learningbot.test.wid_key_b'),
    'https://beta.example.test',
    'Alpha tenants rebuild cadence with the smallest credible next action',
    'wid05crosstenantprobeconversation001',
    null, 'widget-ask-cross-0001', 'trace-widget-cross-0001', null
  );
  if cross_probe ->> 'ok' <> 'true' then
    raise exception 'WID-05 failed: tenant B could not ask at all: %',
      cross_probe::text;
  end if;
  if cross_probe::text like '%Alpha tenants rebuild cadence%'
    or cross_probe::text like '%Widget Course Alpha%'
    or cross_probe::text like '%Widget Lesson Alpha%'
    or jsonb_array_length(cross_probe -> 'matches') <> 0
  then
    raise exception
      'WID-05 failed: tenant B retrieved tenant A knowledge: %',
      cross_probe::text;
  end if;

  -- The same question inside tenant B's own knowledge does return evidence,
  -- so the empty result above is isolation and not a broken search path.
  beta_answer := public.widget_ask(
    current_setting('learningbot.test.wid_key_b'),
    'https://beta.example.test',
    'How do Beta tenants reconcile invoices before the ledger closes?',
    'wid05betaowncontentconversation00001',
    null, 'widget-ask-beta-0001', 'trace-widget-beta-0001', null
  );
  if jsonb_array_length(beta_answer -> 'matches') < 1
    or beta_answer -> 'matches' -> 0 ->> 'courseTitle' <> 'Widget Course Beta'
    or beta_answer ->> 'retrievalMode' <> 'lexical_degraded'
  then
    raise exception 'WID-05 failed: tenant B cannot search its own course: %',
      beta_answer::text;
  end if;

  -- Tenant B's public course list shows only tenant B.
  beta_courses := public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_b'), 'https://beta.example.test'
  ) -> 'widget' -> 'courses';
  if beta_courses::text like '%Widget Course Alpha%'
    or jsonb_array_length(beta_courses) <> 1
  then
    raise exception 'WID-05 failed: a widget listed another tenant''s courses';
  end if;

  -- No widget entrypoint ever returns a stored message, so a guessed
  -- conversation ref is not a read capability for anybody's transcript.
  alpha_answer := public.widget_ask(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'Replaying the conversation reference used earlier in this file.',
    'wid04ratelimitconversationreference01',
    null, 'widget-ask-replay-0001', 'trace-widget-replay-0001', null
  );
  if alpha_answer ? 'messages'
    or alpha_answer ? 'conversation'
    or alpha_answer ? 'history'
    or alpha_answer::text like '%How do I restart the cadence%'
  then
    raise exception
      'WID-05 failed: a guessed conversation ref returned stored messages: %',
      alpha_answer::text;
  end if;

  -- And anon can read none of the underlying rows directly: the tables refuse
  -- the privilege outright rather than merely filtering the result.
  declare
    table_name text;
    read_refused boolean;
    visible bigint;
  begin
    foreach table_name in array array[
      'public.conversations', 'public.messages', 'public.courses',
      'public.tenant_widget_keys', 'public.tenant_branding'
    ]
    loop
      if has_table_privilege('anon', table_name, 'SELECT') then
        raise exception 'WID-05 failed: anon holds SELECT on %', table_name;
      end if;
      read_refused := false;
      begin
        execute 'select count(*) from ' || table_name into visible;
      exception
        when insufficient_privilege then
          read_refused := true;
      end;
      if not read_refused then
        raise exception 'WID-05 failed: anon read % directly', table_name;
      end if;
    end loop;
  end;
end $$;
reset role;

-- The durable rows the widget wrote stayed inside tenant A.
do $$
declare
  alpha_conversations bigint;
  beta_conversations bigint;
begin
  select count(*)::bigint into alpha_conversations
  from public.conversations c
  where c.tenant_id = current_setting('learningbot.test.wid_tenant_a')::uuid
    and c.metadata ->> 'channel' = 'widget';
  select count(*)::bigint into beta_conversations
  from public.conversations c
  where c.tenant_id = current_setting('learningbot.test.wid_tenant_b')::uuid
    and c.metadata ->> 'channel' = 'widget';

  if alpha_conversations < 2 or beta_conversations <> 2 then
    raise exception
      'WID-05 failed: widget conversations were misattributed (a=%, b=%)',
      alpha_conversations, beta_conversations;
  end if;
end $$;

-- ------------------------------------------------------------------- WID-06
set local role anon;
do $$
declare
  forged jsonb;
  recorded jsonb;
  with_token jsonb;
  without_token jsonb;
begin
  -- An assistant turn cannot be forged from the page. The gate is the
  -- server-held operation token, not the widget key.
  forged := public.widget_record_answer(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'wid04ratelimitconversationreference01',
    'A fabricated answer attributed to the assistant.',
    '[]'::jsonb, 'browser:forgery', 'forged-request-0001',
    'widget-answer-forged-0001', 'trace-widget-answer-forged-0001',
    'a-browser-supplied-token-that-is-not-real-0001'
  );
  if forged ->> 'code' <> 'access_denied' then
    raise exception 'WID-06 failed: a browser forged an assistant turn';
  end if;

  recorded := public.widget_record_answer(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'wid04ratelimitconversationreference01',
    'A grounded answer recorded by the application server.',
    jsonb_build_array(
      jsonb_build_object('sourceRef', repeat('a', 64), 'excerpt', 'Evidence.')
    ),
    'openai:test', 'response-widget-0001',
    'widget-answer-0001', 'trace-widget-answer-0001',
    'widget-delivery-test-operation-token-0001'
  );
  if recorded ->> 'ok' <> 'true' then
    raise exception 'WID-06 failed: the server could not record an answer: %',
      recorded::text;
  end if;

  -- The persona reaches the answer path only with the same server-held token.
  without_token := public.widget_ask(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'A question asked without the server operation token.',
    'wid06personagatewithouttoken0000001',
    null, 'widget-ask-persona-0001', 'trace-widget-persona-0001', null
  );
  with_token := public.widget_ask(
    current_setting('learningbot.test.wid_key_a'),
    'https://alpha.example.test',
    'A question asked with the server operation token.',
    'wid06personagatewithtoken000000001x',
    null, 'widget-ask-persona-0002', 'trace-widget-persona-0002',
    'widget-delivery-test-operation-token-0001'
  );
  if without_token ? 'directive'
    or without_token::text like '%NEVERSHIPTHISPERSONA%'
  then
    raise exception 'WID-06 failed: the persona leaked without a token';
  end if;
  if with_token -> 'directive' ->> 'personaInstructions' not like
    '%NEVERSHIPTHISPERSONA%'
    or with_token -> 'directive' ->> 'tone' <> 'friendly'
  then
    raise exception 'WID-06 failed: the server could not read the persona';
  end if;
end $$;
reset role;

-- Exactly three functions reach anon, the administrative pair stays
-- authenticated-only, and every helper stays private.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.widget_bootstrap(text,text)',
    -- Ten arguments since 20260731090000, which dropped the eight-argument
    -- form rather than overloading it: PostgREST calls this by name, and two
    -- candidates would have made every widget question ambiguous.
    'public.widget_ask(text,text,text,text,text,text,text,text,text,text)',
    'public.widget_record_answer(text,text,text,text,jsonb,text,text,text,' ||
      'text,text)'
  ]
  loop
    if not has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'WID-06 failed: invalid public widget privilege for %',
        signature;
    end if;
  end loop;

  foreach signature in array array[
    'public.tenant_get_widget_settings()',
    'public.tenant_update_widget_settings(boolean,text,text,text,text,jsonb,' ||
      'boolean,boolean,jsonb,text,boolean,text,text,text,text,text,boolean,' ||
      'boolean,integer,text,text,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'WID-06 failed: invalid admin widget privilege for %',
        signature;
    end if;
  end loop;

  foreach signature in array array[
    'app_private.widget_resolve(text,text)',
    'app_private.widget_normalize_origin(text)',
    'app_private.widget_origin_allowed(jsonb,text)',
    'app_private.widget_generate_key()',
    'app_private.tenant_active_widget_key(uuid)',
    'app_private.widget_rate_limit(uuid,text)',
    'app_private.widget_append_message(uuid,uuid,text,text,text,jsonb,text,' ||
      'text,text,text)',
    'app_private.widget_conversation(uuid,text,uuid)',
    'app_private.widget_course_ref(text,uuid)',
    'app_private.widget_conversation_hash(text,text)',
    'app_private.widget_visitor_id(text)',
    'app_private.widget_settings_defaults()',
    'app_private.widget_settings_effective(jsonb)',
    'app_private.widget_audit(uuid,text,text,text,text,text,text,text,text)',
    'app_private.learning_chunk_matches(uuid,text,extensions.vector,uuid,' ||
      'integer,jsonb)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'WID-06 failed: widget helper % is exposed', signature;
    end if;
  end loop;

  -- The one helper the storage policies must call takes no tenant parameter,
  -- so it cannot be turned into a cross-tenant key oracle.
  if not has_function_privilege(
    'authenticated', 'app_private.current_tenant_widget_key()', 'EXECUTE'
  ) or has_function_privilege(
    'anon', 'app_private.current_tenant_widget_key()', 'EXECUTE'
  ) then
    raise exception 'WID-06 failed: the storage key helper is misgranted';
  end if;

  if has_table_privilege('anon', 'public.tenant_widget_keys', 'SELECT')
    or has_table_privilege('anon', 'public.tenant_widget_keys', 'INSERT')
    or has_table_privilege('authenticated', 'public.tenant_widget_keys', 'INSERT')
    or has_table_privilege('authenticated', 'public.tenant_widget_keys', 'UPDATE')
    or has_table_privilege('authenticated', 'public.tenant_widget_keys', 'DELETE')
    or has_table_privilege('anon', 'app_private.widget_ask_events', 'SELECT')
    or has_table_privilege('authenticated', 'app_private.widget_ask_events', 'SELECT')
  then
    raise exception 'WID-06 failed: a widget table accepts a direct caller';
  end if;
end $$;

-- Administrative writes stay behind the tenant admin role, keep optimistic
-- concurrency, and replay rather than duplicate.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  stale jsonb;
  bad_origin jsonb;
  replayed jsonb;
  rotated jsonb;
  head integer;
  previous_key text := current_setting('learningbot.test.wid_key_b');
begin
  head := (public.tenant_get_widget_settings() ->> 'expectedVersion')::integer;

  stale := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-left', 'Ask Beta', 'Beta greeting.',
    jsonb_build_array('https://beta.example.test'),
    true, true, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, head - 1,
    'widget-settings-b-stale', 'request-widget-b-stale',
    'trace-widget-b-stale'
  );
  if stale ->> 'code' <> 'version_conflict' then
    raise exception 'WID-06 failed: a stale version was accepted';
  end if;

  bad_origin := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-left', 'Ask Beta', 'Beta greeting.',
    jsonb_build_array('https://*.test'),
    true, true, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, head,
    'widget-settings-b-badorigin', 'request-widget-b-badorigin',
    'trace-widget-b-badorigin'
  );
  if bad_origin ->> 'code' <> 'invalid_origin' then
    raise exception 'WID-06 failed: a public-suffix wildcard was accepted';
  end if;

  rotated := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-left', 'Ask Beta', 'Beta greeting.',
    jsonb_build_array('https://beta.example.test'),
    true, true, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, true, true, head,
    'widget-settings-b-rotate', 'request-widget-b-rotate',
    'trace-widget-b-rotate'
  );
  replayed := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-left', 'Ask Beta', 'Beta greeting.',
    jsonb_build_array('https://beta.example.test'),
    true, true, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, true, true, head,
    'widget-settings-b-rotate', 'request-widget-b-rotate',
    'trace-widget-b-rotate'
  );

  if rotated ->> 'ok' <> 'true'
    or rotated ->> 'widgetKey' = previous_key
    or replayed <> rotated
  then
    raise exception 'WID-06 failed: key rotation or replay is not durable';
  end if;
  perform set_config(
    'learningbot.test.wid_key_b_rotated', rotated ->> 'widgetKey', true
  );
end $$;
reset role;

-- A rotated key retires the old one immediately: a leaked key stops working.
set local role anon;
do $$
declare
  expected jsonb := jsonb_build_object(
    'ok', false, 'code', 'widget_unavailable'
  );
begin
  if public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_b'), 'https://beta.example.test'
  ) <> expected then
    raise exception 'WID-06 failed: a revoked widget key still resolves';
  end if;
  if public.widget_bootstrap(
    current_setting('learningbot.test.wid_key_b_rotated'),
    'https://beta.example.test'
  ) ->> 'ok' <> 'true' then
    raise exception 'WID-06 failed: the rotated widget key does not resolve';
  end if;
end $$;
reset role;

-- A non-admin member cannot change widget delivery at all.
insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject,
  idempotency_key
) values (
  'supabase-auth:e3300000-0000-4000-8000-000000000003',
  'human', 'host_signed', 'supabase-auth',
  'e3300000-0000-4000-8000-000000000003',
  'widget-student-principal'
);
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'e3300000-0000-4000-8000-000000000003',
  'authenticated', 'authenticated', 'widget-student-a@example.test', '',
  now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
  now(), now()
);
insert into app_private.supabase_auth_principal_links (
  auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
) values (
  'e3300000-0000-4000-8000-000000000003',
  'supabase-auth:e3300000-0000-4000-8000-000000000003',
  current_setting('learningbot.test.wid_tenant_a')::uuid,
  'widget-student-link'
);
insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values (
  'supabase-auth-student:e3300000-0000-4000-8000-000000000003',
  current_setting('learningbot.test.wid_tenant_a')::uuid,
  'supabase-auth:e3300000-0000-4000-8000-000000000003',
  'student', 'active', 'manual', 'widget-student-membership'
);
insert into app_private.supabase_auth_tenant_selections (
  auth_user_id, principal_id, tenant_id, membership_id
) values (
  'e3300000-0000-4000-8000-000000000003',
  'supabase-auth:e3300000-0000-4000-8000-000000000003',
  current_setting('learningbot.test.wid_tenant_a')::uuid,
  'supabase-auth-student:e3300000-0000-4000-8000-000000000003'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e3300000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  denied_read jsonb;
  denied_write jsonb;
  visible_keys bigint;
begin
  denied_read := public.tenant_get_widget_settings();
  denied_write := public.tenant_update_widget_settings(
    true, 'launcher', 'bottom-right', 'Ask', 'Student greeting.',
    jsonb_build_array('https://student.example.test'),
    true, false, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, 1,
    'widget-settings-student', 'request-widget-student',
    'trace-widget-student'
  );
  select count(*)::bigint into visible_keys from public.tenant_widget_keys;

  if denied_read ->> 'code' <> 'access_denied'
    or denied_write ->> 'code' <> 'access_denied'
    or visible_keys <> 0
  then
    raise exception 'WID-06 failed: a student reached widget delivery';
  end if;
end $$;
reset role;

rollback;
