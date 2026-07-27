-- Run after migrations 0001..20260726094000. Verifies the widget surface
-- dimension: correct and tenant-isolated attribution, anonymous visitors
-- counted as their own figure and never merged into verified learners, a
-- pseudonymous visitor key that cannot be read or reversed, unchanged JSON for
-- every existing analytics caller, and an honest answer - not a zero - for a
-- range that predates surface recording.
-- All fixtures roll back.

begin;

insert into app_private.learning_operation_secrets (
  capability,
  token_hash,
  expires_at
) values (
  'conversation.answer.record',
  encode(
    extensions.digest(
      'widget-analytics-operation-token-00000000001',
      'sha256'
    ),
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
    'c3300000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'widget-owner-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c3300000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'widget-student-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd4400000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'widget-owner-b@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000001',
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
    'widget-analytics-a',
    'Widget Analytics A',
    'widget-analytics-bootstrap-a',
    'trace-widget-analytics-bootstrap-a'
  );
  perform set_config(
    'learningbot.test.widget_tenant_a',
    bootstrapped.tenant_id::text,
    true
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd4400000-0000-4000-8000-000000000001',
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
    'widget-analytics-b',
    'Widget Analytics B',
    'widget-analytics-bootstrap-b',
    'trace-widget-analytics-bootstrap-b'
  );
  perform set_config(
    'learningbot.test.widget_tenant_b',
    bootstrapped.tenant_id::text,
    true
  );
end $$;
reset role;

-- A verified student of tenant A. The verified-learner figure must count this
-- person and nothing else.
insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject,
  idempotency_key
) values (
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  'human', 'host_signed', 'supabase-auth',
  'c3300000-0000-4000-8000-000000000002',
  'widget-student-principal'
);
insert into app_private.supabase_auth_principal_links (
  auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
) values (
  'c3300000-0000-4000-8000-000000000002',
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.widget_tenant_a')::uuid,
  'widget-student-link'
);
insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values (
  'supabase-auth-student:c3300000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.widget_tenant_a')::uuid,
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  'student', 'active', 'manual', 'widget-student-membership'
);
insert into app_private.supabase_auth_tenant_selections (
  auth_user_id, principal_id, tenant_id, membership_id
) values (
  'c3300000-0000-4000-8000-000000000002',
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.widget_tenant_a')::uuid,
  'supabase-auth-student:c3300000-0000-4000-8000-000000000002'
);

-- ---------------------------------------------------------------- fixtures
--
-- Tenant A ends up with four conversations:
--   console-1  console, never attributed  -> inferred_console
--   widget-1   widget, anonymous visitor ref R, three ungrounded answers
--   widget-2   widget, SAME anonymous visitor ref R (one visitor, two visits)
--   widget-3   widget, verified learner (the student)

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  draft jsonb;
  started jsonb;
begin
  draft := public.learning_create_course_draft(
    'Widget Analytics Course',
    'Surface dimension verification.',
    'Widget Module',
    'Widget Lesson',
    'The restart loop begins with the smallest credible next action.',
    'widget-course-create-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'widget-course-publish-0001'
  );
  perform set_config(
    'learningbot.test.widget_course_a', draft ->> 'courseId', true
  );
  perform set_config(
    'learningbot.test.widget_lesson_a', draft ->> 'lessonId', true
  );

  -- console-1: no surface is ever recorded for it.
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'widget-conversation-console-0001'
  );
  perform set_config(
    'learningbot.test.widget_console_conversation',
    started ->> 'conversationId',
    true
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'How do I restart after a difficult week?',
    'text',
    'trace-widget-console-user-0001',
    'widget-console-user-message-0001'
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'Choose one small action, complete it, and rebuild from evidence.',
    jsonb_build_array(
      jsonb_build_object(
        'chunkId', 'widget-chunk-1',
        'courseTitle', 'Widget Analytics Course',
        'lessonTitle', 'Widget Lesson',
        'excerpt', 'The restart loop begins with the smallest action.'
      )
    ),
    'openai',
    'response-widget-console-0001',
    'trace-widget-console-assistant-0001',
    'assistant:widget-console-message-0001',
    'widget-analytics-operation-token-00000000001'
  );

  -- widget-1: an anonymous visitor, three questions, every answer ungrounded.
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'widget-conversation-widget-0001'
  );
  perform set_config(
    'learningbot.test.widget_conversation_one',
    started ->> 'conversationId',
    true
  );
  perform public.learning_record_conversation_surface(
    (started ->> 'conversationId')::uuid,
    'widget',
    'wk_widget_analytics_a',
    -- The query string and fragment must never reach the database.
    'https://School.Example.Test/courses/restart?utm_source=email&sid=SECRET#top',
    'Restart your week',
    'widget-visitor-reference-0001',
    true,
    'trace-widget-surface-0001',
    'widget-surface-record-0001',
    'widget-analytics-operation-token-00000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Do you cover refunds anywhere?',
    'text',
    'trace-widget-user-0001',
    'widget-user-message-0001'
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'The published course material does not cover that yet.',
    '[]'::jsonb,
    'openai',
    'response-widget-0001',
    'trace-widget-assistant-0001',
    'assistant:widget-message-0001',
    'widget-analytics-operation-token-00000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'What is your cancellation window?',
    'text',
    'trace-widget-user-0002',
    'widget-user-message-0002'
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'The published course material does not cover that yet.',
    '[]'::jsonb,
    'openai',
    'response-widget-0002',
    'trace-widget-assistant-0002',
    'assistant:widget-message-0002',
    'widget-analytics-operation-token-00000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Is there a printable checklist?',
    'text',
    'trace-widget-user-0003',
    'widget-user-message-0003'
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'The published course material does not cover that yet.',
    '[]'::jsonb,
    'openai',
    'response-widget-0003',
    'trace-widget-assistant-0003',
    'assistant:widget-message-0003',
    'widget-analytics-operation-token-00000000001'
  );

  -- widget-2: the SAME anonymous visitor returning. One visitor, two visits.
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'widget-conversation-widget-0002'
  );
  perform public.learning_record_conversation_surface(
    (started ->> 'conversationId')::uuid,
    'widget',
    'wk_widget_analytics_a',
    'https://school.example.test/courses/restart',
    'Restart your week',
    'widget-visitor-reference-0001',
    true,
    'trace-widget-surface-0002',
    'widget-surface-record-0002',
    'widget-analytics-operation-token-00000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Where do I start again?',
    'text',
    'trace-widget-user-0004',
    'widget-user-message-0004'
  );
end $$;

-- widget-3: the verified student, asking through the widget.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  started jsonb;
begin
  started := public.learning_start_conversation(
    current_setting('learningbot.test.widget_course_a')::uuid,
    current_setting('learningbot.test.widget_lesson_a')::uuid,
    'widget-conversation-widget-0003'
  );
  perform public.learning_record_conversation_surface(
    (started ->> 'conversationId')::uuid,
    'widget',
    'wk_widget_analytics_a',
    'https://school.example.test/lessons/minimum-day',
    'The minimum day',
    null,
    false,
    'trace-widget-surface-0003',
    'widget-surface-record-0003',
    'widget-analytics-operation-token-00000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Where do I find the minimum day checklist?',
    'text',
    'trace-widget-student-0001',
    'widget-student-message-0001'
  );
end $$;

-- Tenant B runs the same widget on its own site, with the same visitor
-- reference string, so cross-tenant leakage of either questions or visitor
-- identity would be visible.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd4400000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  draft jsonb;
  started jsonb;
begin
  draft := public.learning_create_course_draft(
    'Isolated Course B',
    'Tenant B material.',
    'Isolated Module B',
    'Isolated Lesson B',
    'Tenant B lesson body for isolation checks.',
    'widget-course-create-b-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'widget-course-publish-b-0001'
  );
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'widget-conversation-b-0001'
  );
  perform public.learning_record_conversation_surface(
    (started ->> 'conversationId')::uuid,
    'widget',
    'wk_widget_analytics_b',
    'https://other-tenant.example.test/help',
    'Tenant B help',
    'widget-visitor-reference-0001',
    true,
    'trace-widget-surface-b-0001',
    'widget-surface-record-b-0001',
    'widget-analytics-operation-token-00000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Tenant B question that must never appear in tenant A analytics.',
    'text',
    'trace-widget-user-b-0001',
    'widget-user-message-b-0001'
  );
end $$;
reset role;

-- WAN-01: surface attribution is correct, the host page is stored without its
-- query string, the widget dimension reaches the signal family, and none of it
-- crosses a tenant boundary.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  breakdown jsonb;
  engagement jsonb;
  gaps jsonb;
  widget_row jsonb;
  console_row jsonb;
  page_row jsonb;
  signals jsonb;
  widget_signal jsonb;
begin
  breakdown := public.analytics_surface_breakdown(null, null);
  if breakdown ->> 'ok' <> 'true' then
    raise exception 'WAN-01 failed: the surface breakdown was refused';
  end if;

  select value into widget_row
  from jsonb_array_elements(
    breakdown -> 'metrics' -> 'surfaceVolume' -> 'value' -> 'surfaces'
  )
  where value ->> 'surface' = 'widget';
  select value into console_row
  from jsonb_array_elements(
    breakdown -> 'metrics' -> 'surfaceVolume' -> 'value' -> 'surfaces'
  )
  where value ->> 'surface' = 'console';

  -- Four widget questions (three anonymous, one verified) and one console one.
  if widget_row is null
    or (widget_row ->> 'questions')::bigint <> 5
    or (widget_row ->> 'conversations')::bigint <> 3
  then
    raise exception
      'WAN-01 failed: widget questions were not attributed (%)', widget_row;
  end if;
  if console_row is null
    or (console_row ->> 'questions')::bigint <> 1
    or (console_row ->> 'inferredAttributions')::bigint <> 1
  then
    raise exception
      'WAN-01 failed: the console question was not attributed or was ' ||
      'reported as recorded rather than inferred (%)', console_row;
  end if;

  engagement := public.analytics_widget_engagement(null, null);
  if engagement ->> 'ok' <> 'true' then
    raise exception 'WAN-01 failed: widget engagement was refused';
  end if;
  select value into page_row
  from jsonb_array_elements(
    engagement -> 'metrics' -> 'hostPageQuestions' -> 'value' -> 'pages'
  )
  where value ->> 'hostPath' = '/courses/restart';
  if page_row is null
    or page_row ->> 'hostOrigin' <> 'https://school.example.test'
    or (page_row ->> 'questions')::bigint <> 4
  then
    raise exception
      'WAN-01 failed: the host page was not recorded correctly (%)', page_row;
  end if;
  -- The query string and fragment must have been discarded before storage,
  -- and the origin must have been normalised to lower case.
  if engagement::text like '%utm_source%'
    or engagement::text like '%SECRET%'
    or engagement::text like '%School.Example%'
    or engagement::text like '%#top%'
  then
    raise exception
      'WAN-01 failed: a host page query string reached the database';
  end if;

  -- Deflections: the three ungrounded widget answers are the content signal.
  gaps := public.analytics_widget_content_gaps(null, null);
  if gaps ->> 'ok' <> 'true'
    or (
      gaps -> 'metrics' -> 'widgetGroundingCoverage' -> 'value'
        ->> 'ungroundedAnswers'
    )::bigint <> 3
    or (
      gaps -> 'metrics' -> 'widgetDeflections' -> 'value'
        ->> 'deflectedQuestions'
    )::bigint < 3
  then
    raise exception
      'WAN-01 failed: widget grounding or deflection was not derived (%)',
      gaps -> 'metrics' -> 'widgetGroundingCoverage';
  end if;

  -- The widget detectors are composed onto the existing signal family, so
  -- public.analytics_signals returns them with no change of its own.
  signals := public.analytics_signals(null, null);
  select value into widget_signal
  from jsonb_array_elements(
    signals -> 'metrics' -> 'detectedSignals' -> 'value' -> 'signals'
  )
  where value ->> 'kind' = 'widget_page_ungrounded';
  if widget_signal is null
    or widget_signal -> 'evidence' ->> 'hostPath' <> '/courses/restart'
  then
    raise exception
      'WAN-01 failed: the widget signal did not reach analytics_signals';
  end if;

  -- Nothing from tenant B may appear anywhere on tenant A's surface.
  if breakdown::text like '%other-tenant.example.test%'
    or engagement::text like '%other-tenant.example.test%'
    or gaps::text like '%other-tenant.example.test%'
    or engagement::text like '%wk_widget_analytics_b%'
  then
    raise exception 'WAN-01 failed: cross-tenant widget data was exposed';
  end if;
end $$;

-- WAN-02: an anonymous visitor is its own figure and is never merged into the
-- verified-learner count.
do $$
declare
  breakdown jsonb;
  engagement jsonb;
  overview jsonb;
  widget_row jsonb;
begin
  breakdown := public.analytics_surface_breakdown(null, null);
  select value into widget_row
  from jsonb_array_elements(
    breakdown -> 'metrics' -> 'surfaceVolume' -> 'value' -> 'surfaces'
  )
  where value ->> 'surface' = 'widget';

  -- Two conversations, one returning visitor reference: exactly one visitor.
  if (widget_row ->> 'anonymousVisitors')::bigint <> 1 then
    raise exception
      'WAN-02 failed: the same visitor reference was not counted once (%)',
      widget_row ->> 'anonymousVisitors';
  end if;
  -- Four anonymous questions, and exactly one verified learner beside them.
  if (widget_row ->> 'anonymousQuestions')::bigint <> 4
    or (widget_row ->> 'verifiedLearners')::bigint <> 1
  then
    raise exception
      'WAN-02 failed: anonymous and verified askers were not separated (%)',
      widget_row;
  end if;

  engagement := public.analytics_widget_engagement(null, null);
  if (
    engagement -> 'metrics' -> 'widgetEngagement' -> 'value'
      ->> 'anonymousVisitors'
  )::bigint <> 1
    or (
      engagement -> 'metrics' -> 'widgetEngagement' -> 'value'
        ->> 'verifiedLearners'
    )::bigint <> 1
    or (
      engagement -> 'metrics' -> 'widgetEngagement' -> 'value'
        ->> 'anonymousConversations'
    )::bigint <> 2
  then
    raise exception
      'WAN-02 failed: widget engagement merged or lost the anonymous figure';
  end if;

  -- The pre-existing learner count is unchanged by the presence of anonymous
  -- visitors: it still counts verified conversation subjects only, and there
  -- are exactly two of them (the owner and the student).
  overview := public.analytics_tenant_overview(null, null);
  if (overview -> 'metrics' -> 'activeLearners' -> 'value' ->> 'learners')
    ::bigint <> 2
  then
    raise exception
      'WAN-02 failed: anonymous visitors leaked into the learner count (%)',
      overview -> 'metrics' -> 'activeLearners';
  end if;
  -- That count is distinct conversation subjects, and the widget gives an
  -- anonymous visitor a synthetic subject. The number is unchanged for its
  -- existing callers, but it may no longer be read without the caveat.
  if overview -> 'metrics' -> 'activeLearners' ->> 'state' <> 'partial'
    or overview -> 'metrics' -> 'activeLearners' -> 'limitations' ->> 0
      not like '%anonymous widget visitors%'
  then
    raise exception
      'WAN-02 failed: the learner count did not disclose its anonymous share';
  end if;

  -- And the honesty statement about what an anonymous visitor is must travel
  -- with the number.
  if breakdown -> 'metrics' -> 'surfaceVolume' -> 'limitations' is null
    or breakdown::text not like '%never added%'
  then
    raise exception
      'WAN-02 failed: the anonymous-visitor limitation was not reported';
  end if;
end $$;

-- WAN-03: the pseudonymous key cannot be read, reversed, or correlated across
-- tenants.
reset role;
do $$
declare
  key_a text;
  key_b text;
  signature text;
begin
  key_a := app_private.surface_visitor_key(
    current_setting('learningbot.test.widget_tenant_a')::uuid,
    'widget-visitor-reference-0001'
  );
  key_b := app_private.surface_visitor_key(
    current_setting('learningbot.test.widget_tenant_b')::uuid,
    'widget-visitor-reference-0001'
  );
  perform set_config('learningbot.test.widget_visitor_key', key_a, true);

  if key_a is null or key_a !~ '^[0-9a-f]{64}$' then
    raise exception 'WAN-03 failed: no pseudonymous key was derived';
  end if;
  -- The same browser reference on two tenants must not produce one identity.
  if key_a = key_b then
    raise exception
      'WAN-03 failed: one visitor reference correlates across tenants';
  end if;
  -- The digest is what is stored. The reference itself never is, and there is
  -- no column that could hold an identifying input.
  if exists (
    select 1
    from public.conversation_surfaces s
    where s.visitor_key = 'widget-visitor-reference-0001'
       or s.host_page_title = 'widget-visitor-reference-0001'
       or s.widget_key = 'widget-visitor-reference-0001'
  ) then
    raise exception 'WAN-03 failed: the raw visitor reference was stored';
  end if;
  if not exists (
    select 1
    from public.conversation_surfaces s
    where s.visitor_key = key_a
  ) then
    raise exception 'WAN-03 failed: the visitor was not counted at all';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'conversation_surfaces'
      and a.attnum > 0
      and not a.attisdropped
      and a.attname in ('visitor_ref', 'visitor_reference', 'fingerprint',
                        'ip_address', 'user_agent', 'session_id')
  ) then
    raise exception
      'WAN-03 failed: an identifying column exists on conversation_surfaces';
  end if;

  -- No client role can read the table the key lives in, or the pepper, or the
  -- derivation function.
  if has_table_privilege(
      'authenticated', 'public.conversation_surfaces', 'SELECT'
    )
    or has_table_privilege('anon', 'public.conversation_surfaces', 'SELECT')
    or has_table_privilege(
      'service_role', 'public.conversation_surfaces', 'SELECT'
    )
  then
    raise exception
      'WAN-03 failed: a client role can read public.conversation_surfaces';
  end if;
  if has_table_privilege(
      'authenticated', 'app_private.surface_attribution_settings', 'SELECT'
    )
    or has_table_privilege(
      'service_role', 'app_private.surface_attribution_settings', 'SELECT'
    )
  then
    raise exception 'WAN-03 failed: the visitor pepper is readable';
  end if;
  foreach signature in array array[
    'app_private.surface_visitor_key(uuid,text)',
    'app_private.surface_attribution_epoch()',
    'app_private.conversation_surface_view(uuid)',
    'app_private.conversation_surface_name(uuid,uuid)',
    'app_private.surface_window_coverage(timestamptz,timestamptz)',
    'app_private.surface_question_totals(uuid,timestamptz,timestamptz,text)',
    'app_private.analytics_surface_filter(text)',
    'app_private.widget_signal_detections(timestamptz,timestamptz)',
    'app_private.question_signal_detections_base(timestamptz,timestamptz)'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'WAN-03 failed: surface helper % is exposed', signature;
    end if;
  end loop;
end $$;

-- No analytics response ever carries the key itself, only counts of it.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  key_a constant text :=
    current_setting('learningbot.test.widget_visitor_key');
  breakdown jsonb;
  engagement jsonb;
  gaps jsonb;
begin
  breakdown := public.analytics_surface_breakdown(null, null);
  engagement := public.analytics_widget_engagement(null, null);
  gaps := public.analytics_widget_content_gaps(null, null);
  if breakdown::text like '%' || key_a || '%'
    or engagement::text like '%' || key_a || '%'
    or gaps::text like '%' || key_a || '%'
    or breakdown::text like '%widget-visitor-reference%'
    or engagement::text like '%widget-visitor-reference%'
    or gaps::text like '%widget-visitor-reference%'
  then
    raise exception
      'WAN-03 failed: a pseudonymous key or visitor reference was emitted';
  end if;
end $$;
reset role;

-- WAN-04: every existing analytics caller gets its original JSON shape, its
-- original two-argument signature and its original privileges. The surface
-- filter is additive and a bad filter fails closed instead of silently
-- returning the unfiltered total.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  overview jsonb;
  distribution jsonb;
  quality jsonb;
  progress jsonb;
  widget_overview jsonb;
  rejected jsonb;
  metric_name text;
begin
  overview := public.analytics_tenant_overview(null, null);
  distribution := public.analytics_question_distribution(null, null);
  quality := public.analytics_answer_quality(null, null);
  progress := public.analytics_learner_progress(null, null);

  if overview ->> 'ok' <> 'true'
    or overview ->> 'dataMode' <> 'durable'
    or overview -> 'range' ->> 'timeZone' <> 'UTC'
    or overview -> 'range' ->> 'bucket' <> 'day'
    or jsonb_typeof(overview -> 'definitions') <> 'object'
    or jsonb_typeof(overview -> 'metrics' -> 'questionVolume' -> 'value' -> 'buckets')
      <> 'array'
  then
    raise exception 'WAN-04 failed: the overview envelope changed shape';
  end if;
  foreach metric_name in array array[
    'questionVolume', 'activeLearners', 'channelSplit',
    'answerLatencyMs', 'turnRecordingIntervalMs'
  ]
  loop
    if overview -> 'metrics' -> metric_name is null
      or (overview -> 'metrics' -> metric_name ->> 'state')
        not in ('known', 'partial', 'unknown')
    then
      raise exception 'WAN-04 failed: overview metric % is gone', metric_name;
    end if;
  end loop;
  -- An unknown metric still carries no value at all.
  if overview -> 'metrics' -> 'answerLatencyMs' ? 'value' then
    raise exception 'WAN-04 failed: an unknown metric gained a value';
  end if;

  if distribution ->> 'ok' <> 'true'
    or jsonb_typeof(distribution -> 'limits') <> 'object'
    or (distribution -> 'limits' ->> 'courses')::int <> 50
    or jsonb_typeof(distribution -> 'distribution' -> 'value' -> 'courses')
      <> 'array'
    or distribution -> 'distribution' -> 'value' -> 'unattributed' is null
  then
    raise exception 'WAN-04 failed: the distribution envelope changed shape';
  end if;

  if quality ->> 'ok' <> 'true'
    or quality -> 'metrics' -> 'groundingCoverage' is null
    or quality -> 'metrics' -> 'retrievalConfidence' is null
    or quality -> 'metrics' -> 'contentGapSignals' is null
    or jsonb_typeof(
      quality -> 'metrics' -> 'groundingCoverage' -> 'value'
        -> 'sourceCountBuckets'
    ) <> 'array'
  then
    raise exception 'WAN-04 failed: the answer-quality envelope changed shape';
  end if;

  if progress ->> 'ok' <> 'true'
    or progress -> 'metrics' -> 'courseFunnel' is null
  then
    raise exception 'WAN-04 failed: learner progress changed shape';
  end if;

  -- The unfiltered call and the two surface-filtered calls partition the same
  -- total, so the filter restricts rather than re-counts.
  widget_overview := public.analytics_tenant_overview(
    null::timestamptz, null::timestamptz, 'widget'::text
  );
  if (widget_overview -> 'metrics' -> 'questionVolume' -> 'value'
      ->> 'totalQuestions')::bigint <> 5
    or (overview -> 'metrics' -> 'questionVolume' -> 'value'
      ->> 'totalQuestions')::bigint <> 6
    or (public.analytics_tenant_overview(
      null::timestamptz, null::timestamptz, 'console'::text
    )
      -> 'metrics' -> 'questionVolume' -> 'value' ->> 'totalQuestions')::bigint
      <> 1
  then
    raise exception 'WAN-04 failed: the surface filter did not partition';
  end if;
  if widget_overview -> 'surface' ->> 'requested' <> 'widget'
    or overview -> 'surface' ->> 'applied' <> 'all'
  then
    raise exception 'WAN-04 failed: surface provenance was not reported';
  end if;

  rejected := public.analytics_question_distribution(
    null::timestamptz, null::timestamptz, 'mobile'::text
  );
  if rejected ->> 'ok' <> 'false'
    or rejected ->> 'code' <> 'invalid_surface'
  then
    raise exception 'WAN-04 failed: an unknown surface filter was accepted';
  end if;
end $$;
reset role;

do $$
declare
  signature text;
begin
  -- The original two-argument signatures still exist with exactly their
  -- original privileges, so no existing caller has to change.
  foreach signature in array array[
    'public.analytics_tenant_overview(timestamptz,timestamptz)',
    'public.analytics_question_distribution(timestamptz,timestamptz)',
    'public.analytics_answer_quality(timestamptz,timestamptz)',
    'public.analytics_learner_progress(timestamptz,timestamptz)',
    'public.analytics_tenant_overview(timestamptz,timestamptz,text)',
    'public.analytics_question_distribution(timestamptz,timestamptz,text)',
    'public.analytics_answer_quality(timestamptz,timestamptz,text)',
    'public.analytics_surface_breakdown(timestamptz,timestamptz,text)',
    'public.analytics_widget_engagement(timestamptz,timestamptz)',
    'public.analytics_widget_content_gaps(timestamptz,timestamptz)',
    'public.learning_record_conversation_surface(' ||
      'uuid,text,text,text,text,text,boolean,text,text,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'WAN-04 failed: invalid privilege for %', signature;
    end if;
  end loop;

  -- The three-argument overload must not carry a default for its third
  -- parameter: a defaulted one would make every existing two-argument call
  -- ambiguous and PostgREST would fail them all.
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'analytics_tenant_overview',
        'analytics_question_distribution',
        'analytics_answer_quality'
      )
      and p.pronargs = 3
      and p.pronargdefaults > 0
  ) then
    raise exception
      'WAN-04 failed: a surface overload defaults its third argument';
  end if;
end $$;

-- WAN-05: a range that predates surface recording is reported as unknown with
-- the reason, never as zero widget usage.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c3300000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  historic_start constant timestamptz := now() - interval '300 days';
  historic_end constant timestamptz := now() - interval '200 days';
  breakdown jsonb;
  engagement jsonb;
  gaps jsonb;
  overview jsonb;
begin
  breakdown := public.analytics_surface_breakdown(
    historic_start, historic_end
  );
  engagement := public.analytics_widget_engagement(
    historic_start, historic_end
  );
  gaps := public.analytics_widget_content_gaps(historic_start, historic_end);
  overview := public.analytics_tenant_overview(historic_start, historic_end);

  if breakdown ->> 'ok' <> 'true'
    or engagement ->> 'ok' <> 'true'
    or gaps ->> 'ok' <> 'true'
  then
    raise exception 'WAN-05 failed: a historic range was refused outright';
  end if;

  -- Unknown, and carrying no value at all - a zero here would assert that
  -- nobody used the widget, which the rows do not support.
  if breakdown -> 'metrics' -> 'surfaceVolume' ->> 'state' <> 'unknown'
    or breakdown -> 'metrics' -> 'surfaceVolume' ? 'value'
    or engagement -> 'metrics' -> 'widgetEngagement' ->> 'state' <> 'unknown'
    or engagement -> 'metrics' -> 'widgetEngagement' ? 'value'
    or engagement -> 'metrics' -> 'hostPageQuestions' ? 'value'
    or gaps -> 'metrics' -> 'widgetGroundingCoverage' ->> 'state' <> 'unknown'
    or gaps -> 'metrics' -> 'widgetDeflections' ? 'value'
    or overview -> 'metrics' -> 'surfaceSplit' ->> 'state' <> 'unknown'
    or overview -> 'metrics' -> 'surfaceSplit' ? 'value'
  then
    raise exception
      'WAN-05 failed: a pre-widget range reported a value instead of unknown';
  end if;

  -- The reason has to be stated, not merely implied by the absent value.
  if breakdown::text not like '%Surface attribution began at%'
    or engagement::text not like '%Surface attribution began at%'
    or breakdown::text not like '%rather than as zero%'
  then
    raise exception
      'WAN-05 failed: the reason for the unknown was not reported';
  end if;

  -- The surface-independent metrics in the same envelope are unaffected: this
  -- is honesty about one dimension, not a refusal to answer.
  if overview -> 'metrics' -> 'questionVolume' ->> 'state' = 'unknown' then
    raise exception
      'WAN-05 failed: surface coverage suppressed an unrelated metric';
  end if;

  -- And the provenance block names the epoch so a reader can check the claim.
  if breakdown -> 'surface' ->> 'coverage' <> 'none'
    or breakdown -> 'surface' ->> 'attributionStartedAt' is null
  then
    raise exception 'WAN-05 failed: surface coverage was not reported';
  end if;
end $$;
reset role;

rollback;
