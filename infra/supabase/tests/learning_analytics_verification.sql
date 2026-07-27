-- Run after migrations 0001..20260725121000. Verifies the durable learning
-- analytics RPCs: tenant isolation, role authorization, honest unknown
-- metrics and the course/module/lesson question distribution.
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
      'analytics-test-operation-token-000000000001',
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
    'a1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'analytics-owner-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1100000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'analytics-student-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2200000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'analytics-owner-b@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
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
    'analytics-a',
    'Analytics A',
    'analytics-bootstrap-a',
    'trace-analytics-bootstrap-a'
  );
  perform set_config(
    'learningbot.test.analytics_tenant_a',
    bootstrapped.tenant_id::text,
    true
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b2200000-0000-4000-8000-000000000001',
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
    'analytics-b',
    'Analytics B',
    'analytics-bootstrap-b',
    'trace-analytics-bootstrap-b'
  );
  perform set_config(
    'learningbot.test.analytics_tenant_b',
    bootstrapped.tenant_id::text,
    true
  );
end $$;
reset role;

-- A verified student of tenant A. Analytics must stay closed to this role.
insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject,
  idempotency_key
) values (
  'supabase-auth:a1100000-0000-4000-8000-000000000002',
  'human', 'host_signed', 'supabase-auth',
  'a1100000-0000-4000-8000-000000000002',
  'analytics-student-principal'
);
insert into app_private.supabase_auth_principal_links (
  auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
) values (
  'a1100000-0000-4000-8000-000000000002',
  'supabase-auth:a1100000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.analytics_tenant_a')::uuid,
  'analytics-student-link'
);
insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values (
  'supabase-auth-student:a1100000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.analytics_tenant_a')::uuid,
  'supabase-auth:a1100000-0000-4000-8000-000000000002',
  'student', 'active', 'manual', 'analytics-student-membership'
);
insert into app_private.supabase_auth_tenant_selections (
  auth_user_id, principal_id, tenant_id, membership_id
) values (
  'a1100000-0000-4000-8000-000000000002',
  'supabase-auth:a1100000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.analytics_tenant_a')::uuid,
  'supabase-auth-student:a1100000-0000-4000-8000-000000000002'
);

-- ANA-01: tenant A records real questions, answers and progress.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
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
    'Analytics Course',
    'Durable analytics verification.',
    'Analytics Module',
    'Analytics Lesson',
    'The restart loop begins with the smallest credible next action.',
    'analytics-course-create-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'analytics-course-publish-0001'
  );
  perform set_config(
    'learningbot.test.analytics_course_a',
    draft ->> 'courseId',
    true
  );
  perform set_config(
    'learningbot.test.analytics_lesson_a',
    draft ->> 'lessonId',
    true
  );

  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'analytics-conversation-a-0001'
  );
  perform set_config(
    'learningbot.test.analytics_conversation_a',
    started ->> 'conversationId',
    true
  );

  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'How do I restart after a difficult week?',
    'text',
    'trace-analytics-user-0001',
    'analytics-user-message-0001'
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'Choose one small action, complete it, and rebuild from evidence.',
    jsonb_build_array(
      jsonb_build_object(
        'chunkId', 'analytics-chunk-1',
        'courseTitle', 'Analytics Course',
        'lessonTitle', 'Analytics Lesson',
        'excerpt', 'The restart loop begins with the smallest action.'
      ),
      jsonb_build_object(
        'chunkId', 'analytics-chunk-2',
        'courseTitle', 'Analytics Course',
        'lessonTitle', 'Analytics Lesson',
        'excerpt', 'Evidence beats intention when rebuilding a rhythm.'
      )
    ),
    'openai',
    'response-analytics-0001',
    'trace-analytics-assistant-0001',
    'assistant:analytics-message-0001',
    'analytics-test-operation-token-000000000001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'What if I miss two weeks instead of one?',
    'voice_transcript',
    'trace-analytics-user-0002',
    'analytics-user-message-0002'
  );
  -- An answer with zero citations is the durable ungrounded signal.
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'The published course material does not cover that yet.',
    '[]'::jsonb,
    'openai',
    'response-analytics-0002',
    'trace-analytics-assistant-0002',
    'assistant:analytics-message-0002',
    'analytics-test-operation-token-000000000001'
  );

  perform public.learning_mark_lesson_progress(
    (draft ->> 'lessonId')::uuid,
    'completed',
    'analytics-progress-0001'
  );
end $$;

-- A student of tenant A asks one question of their own.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000002',
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
    current_setting('learningbot.test.analytics_course_a')::uuid,
    current_setting('learningbot.test.analytics_lesson_a')::uuid,
    'analytics-conversation-a-student'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Where do I find the minimum day checklist?',
    'text',
    'trace-analytics-student-0001',
    'analytics-student-message-0001'
  );
end $$;

-- ANA-06: analytics is closed to the student role even inside their tenant.
do $$
declare
  overview jsonb;
  distribution jsonb;
  quality jsonb;
  progress jsonb;
begin
  overview := public.analytics_tenant_overview(null, null);
  distribution := public.analytics_question_distribution(null, null);
  quality := public.analytics_answer_quality(null, null);
  progress := public.analytics_learner_progress(null, null);
  if overview ->> 'code' <> 'access_denied'
    or distribution ->> 'code' <> 'access_denied'
    or quality ->> 'code' <> 'access_denied'
    or progress ->> 'code' <> 'access_denied'
    or overview ->> 'ok' <> 'false'
  then
    raise exception 'ANA-06 failed: a student read tenant analytics';
  end if;
end $$;

-- Tenant B records a single question of its own.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b2200000-0000-4000-8000-000000000001',
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
    'Tenant B analytics verification.',
    'Isolated Module B',
    'Isolated Lesson B',
    'Tenant B content that tenant A must never aggregate.',
    'analytics-course-create-b-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'analytics-course-publish-b-0001'
  );
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'analytics-conversation-b-0001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Tenant B question that must stay inside tenant B.',
    'text',
    'trace-analytics-user-b-0001',
    'analytics-user-message-b-0001'
  );
end $$;

-- ANA-01: tenant A overview counts every recorded question exactly once,
-- splits the channel from the recorded modality and refuses to invent latency.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  overview jsonb;
  volume jsonb;
  bucket_total bigint;
begin
  overview := public.analytics_tenant_overview(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  volume := overview -> 'metrics' -> 'questionVolume';
  select coalesce(sum((b ->> 'questions')::bigint), 0)
  into bucket_total
  from jsonb_array_elements(volume -> 'value' -> 'buckets') b;

  if overview ->> 'ok' <> 'true'
    or overview ->> 'dataMode' <> 'durable'
    or (volume -> 'value' ->> 'totalQuestions')::bigint <> 3
    or (volume -> 'value' ->> 'studentQuestions')::bigint <> 1
    or (volume -> 'value' ->> 'staffQuestions')::bigint <> 2
    or bucket_total <> 3
    or (
      overview -> 'metrics' -> 'activeLearners' -> 'value' ->> 'learners'
    )::bigint <> 2
    or (
      overview -> 'metrics' -> 'channelSplit' -> 'value' ->> 'textQuestions'
    )::bigint <> 2
    or (
      overview -> 'metrics' -> 'channelSplit' -> 'value' ->> 'voiceQuestions'
    )::bigint <> 1
  then
    raise exception 'ANA-01 failed: tenant overview totals are invalid';
  end if;

  if overview -> 'metrics' -> 'answerLatencyMs' ->> 'state' <> 'unknown'
    or overview -> 'metrics' -> 'answerLatencyMs' ? 'value'
    or jsonb_array_length(
      overview -> 'metrics' -> 'answerLatencyMs' -> 'limitations'
    ) < 1
  then
    raise exception
      'ANA-01 failed: answer latency was reported instead of unknown';
  end if;
end $$;

-- ANA-02: the headline distribution attributes every question to its
-- course, module and lesson with an explicit share of the total.
do $$
declare
  distribution jsonb;
  course jsonb;
  module_entry jsonb;
  lesson jsonb;
begin
  distribution := public.analytics_question_distribution(
    now() - interval '1 day',
    now() + interval '1 hour'
  ) -> 'distribution';
  course := distribution -> 'value' -> 'courses' -> 0;
  module_entry := course -> 'modules' -> 0;
  lesson := module_entry -> 'lessons' -> 0;

  if (distribution -> 'value' ->> 'totalQuestions')::bigint <> 3
    or (distribution -> 'value' ->> 'attributedQuestions')::bigint <> 3
    or jsonb_array_length(distribution -> 'value' -> 'courses') <> 1
    or course ->> 'courseTitle' <> 'Analytics Course'
    or (course ->> 'questions')::bigint <> 3
    or (course ->> 'share')::numeric <> 1
    or (course ->> 'learners')::bigint <> 2
    or (module_entry ->> 'moduleTitle') <> 'Analytics Module'
    or (module_entry ->> 'questions')::bigint <> 3
    or (module_entry ->> 'shareOfCourse')::numeric <> 1
    or (lesson ->> 'lessonTitle') <> 'Analytics Lesson'
    or (lesson ->> 'questions')::bigint <> 3
    or (distribution -> 'value' -> 'unattributed' ->> 'questions')::bigint <> 0
  then
    raise exception 'ANA-02 failed: question distribution is invalid';
  end if;
end $$;

-- ANA-03: grounding coverage is measured, retrieval confidence is unknown.
do $$
declare
  quality jsonb;
  coverage jsonb;
  clusters jsonb;
begin
  quality := public.analytics_answer_quality(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  coverage := quality -> 'metrics' -> 'groundingCoverage';
  clusters := quality -> 'metrics' -> 'contentGapSignals' -> 'value'
    -> 'clusters';

  if (coverage -> 'value' ->> 'answers')::bigint <> 2
    or (coverage -> 'value' ->> 'groundedAnswers')::bigint <> 1
    or (coverage -> 'value' ->> 'ungroundedAnswers')::bigint <> 1
    or (coverage -> 'value' ->> 'answersWithoutSourceRecord')::bigint <> 0
    or (coverage -> 'value' ->> 'averageSourceCount')::numeric <> 1
    or jsonb_array_length(clusters) <> 1
    or (clusters -> 0 ->> 'ungroundedAnswers')::bigint <> 1
    or clusters -> 0 ->> 'lessonTitle' <> 'Analytics Lesson'
  then
    raise exception 'ANA-03 failed: answer quality coverage is invalid';
  end if;

  if quality -> 'metrics' -> 'retrievalConfidence' ->> 'state' <> 'unknown'
    or quality -> 'metrics' -> 'retrievalConfidence' ? 'value'
    or jsonb_array_length(
      quality -> 'metrics' -> 'retrievalConfidence' -> 'limitations'
    ) < 1
  then
    raise exception
      'ANA-03 failed: retrieval confidence was invented instead of unknown';
  end if;
end $$;

-- ANA-04: the completion funnel reports recorded progress and declares that
-- no completion timestamp exists.
do $$
declare
  progress jsonb;
  funnel jsonb;
  course jsonb;
begin
  progress := public.analytics_learner_progress(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  funnel := progress -> 'metrics' -> 'courseFunnel';
  course := funnel -> 'value' -> 'courses' -> 0;

  if (progress ->> 'stalledThresholdDays')::integer <> 14
    or jsonb_array_length(funnel -> 'value' -> 'courses') <> 1
    or course ->> 'courseTitle' <> 'Analytics Course'
    or (course ->> 'learnersWithProgress')::bigint <> 1
    or (course ->> 'learnersStarted')::bigint <> 1
    or (course ->> 'learnersCompleted')::bigint <> 1
    or (course ->> 'stalledLearners')::bigint <> 0
    or (course ->> 'lessonsCompletedInRange')::bigint <> 1
    or funnel ->> 'state' <> 'partial'
    or jsonb_array_length(funnel -> 'limitations') < 1
  then
    raise exception 'ANA-04 failed: learner progress funnel is invalid';
  end if;

  if progress -> 'metrics' -> 'courseCompletionTiming' ->> 'state'
      <> 'unknown'
    or progress -> 'metrics' -> 'courseCompletionTiming' ? 'value'
  then
    raise exception
      'ANA-04 failed: course completion timing was reported as known';
  end if;
end $$;

-- ANA-05: tenant B sees only its own question and never tenant A's course.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b2200000-0000-4000-8000-000000000001',
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
begin
  overview := public.analytics_tenant_overview(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  distribution := public.analytics_question_distribution(
    now() - interval '1 day',
    now() + interval '1 hour'
  ) -> 'distribution';
  quality := public.analytics_answer_quality(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  progress := public.analytics_learner_progress(
    now() - interval '1 day',
    now() + interval '1 hour'
  );

  if (
    overview -> 'metrics' -> 'questionVolume' -> 'value'
      ->> 'totalQuestions'
  )::bigint <> 1
    or (
      overview -> 'metrics' -> 'activeLearners' -> 'value' ->> 'learners'
    )::bigint <> 1
    or (distribution -> 'value' ->> 'totalQuestions')::bigint <> 1
    or jsonb_array_length(distribution -> 'value' -> 'courses') <> 1
    or distribution -> 'value' -> 'courses' -> 0 ->> 'courseTitle'
      <> 'Isolated Course B'
    or distribution::text like '%Analytics Course%'
    or distribution::text like '%Analytics Lesson%'
    or (
      quality -> 'metrics' -> 'groundingCoverage' -> 'value' ->> 'answers'
    )::bigint <> 0
    or jsonb_array_length(
      progress -> 'metrics' -> 'courseFunnel' -> 'value' -> 'courses'
    ) <> 0
  then
    raise exception 'ANA-05 failed: cross-tenant analytics were exposed';
  end if;
end $$;
reset role;

-- ANA-06: only authenticated callers execute the analytics entrypoints, and
-- the analytics helpers stay private.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.analytics_tenant_overview(timestamptz,timestamptz)',
    'public.analytics_question_distribution(timestamptz,timestamptz)',
    'public.analytics_answer_quality(timestamptz,timestamptz)',
    'public.analytics_learner_progress(timestamptz,timestamptz)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'ANA-06 failed: invalid privilege for %', signature;
    end if;
  end loop;

  foreach signature in array array[
    'app_private.analytics_context()',
    'app_private.analytics_window(timestamptz,timestamptz)',
    'app_private.analytics_metric(text,jsonb,timestamptz,jsonb,jsonb)',
    'app_private.analytics_metric_state(text[])'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'ANA-06 failed: analytics helper % is exposed',
        signature;
    end if;
  end loop;
end $$;

-- ANA-07: an unbounded or reversed range fails closed instead of scanning.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  reversed jsonb;
  oversized jsonb;
begin
  reversed := public.analytics_tenant_overview(
    now(),
    now() - interval '1 day'
  );
  oversized := public.analytics_question_distribution(
    now() - interval '400 days',
    now()
  );
  if reversed ->> 'code' <> 'invalid_range'
    or oversized ->> 'code' <> 'invalid_range'
  then
    raise exception 'ANA-07 failed: an invalid range was accepted';
  end if;
end $$;
reset role;

rollback;
