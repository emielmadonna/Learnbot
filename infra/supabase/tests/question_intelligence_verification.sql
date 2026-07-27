-- Run after migrations 0001..20260726091000. Verifies question intelligence:
-- label storage and its server-only write gate, upsert-on-reclassification,
-- the honest unclassified/unknown reporting contract, cross-tenant isolation
-- of both labels and signals, and the audited signal review lifecycle.
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
      'question-intelligence-test-operation-token-0001',
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
    'authenticated', 'authenticated', 'qin-owner-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c3300000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'qin-student-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd4400000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'qin-owner-b@example.test', '',
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
    'question-intel-a',
    'Question Intelligence A',
    'qin-bootstrap-a',
    'trace-qin-bootstrap-a'
  );
  perform set_config(
    'learningbot.test.qin_tenant_a',
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
    'question-intel-b',
    'Question Intelligence B',
    'qin-bootstrap-b',
    'trace-qin-bootstrap-b'
  );
  perform set_config(
    'learningbot.test.qin_tenant_b',
    bootstrapped.tenant_id::text,
    true
  );
end $$;
reset role;

-- A verified student of tenant A. This is the browser-role caller: it holds a
-- real membership and therefore a real learning RPC context, but never the
-- server-held operation token.
insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject,
  idempotency_key
) values (
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  'human', 'host_signed', 'supabase-auth',
  'c3300000-0000-4000-8000-000000000002',
  'qin-student-principal'
);
insert into app_private.supabase_auth_principal_links (
  auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
) values (
  'c3300000-0000-4000-8000-000000000002',
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.qin_tenant_a')::uuid,
  'qin-student-link'
);
insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values (
  'supabase-auth-student:c3300000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.qin_tenant_a')::uuid,
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  'student', 'active', 'manual', 'qin-student-membership'
);
insert into app_private.supabase_auth_tenant_selections (
  auth_user_id, principal_id, tenant_id, membership_id
) values (
  'c3300000-0000-4000-8000-000000000002',
  'supabase-auth:c3300000-0000-4000-8000-000000000002',
  current_setting('learningbot.test.qin_tenant_a')::uuid,
  'supabase-auth-student:c3300000-0000-4000-8000-000000000002'
);

-- Tenant A records three real questions. The first answer carries a citation,
-- the second and third carry none - the durable ungrounded signal.
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
  recorded jsonb;
begin
  draft := public.learning_create_course_draft(
    'Question Intelligence Course',
    'Durable question intelligence verification.',
    'Question Intelligence Module',
    'Question Intelligence Lesson',
    'A restart begins with the smallest credible next action.',
    'qin-course-create-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'qin-course-publish-0001'
  );
  perform set_config(
    'learningbot.test.qin_course_a', draft ->> 'courseId', true
  );
  perform set_config(
    'learningbot.test.qin_lesson_a', draft ->> 'lessonId', true
  );

  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'qin-conversation-a-0001'
  );
  perform set_config(
    'learningbot.test.qin_conversation_a',
    started ->> 'conversationId',
    true
  );

  recorded := public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'How do I restart the cadence after a difficult week?',
    'text',
    'trace-qin-user-0001',
    'qin-user-message-0001'
  );
  perform set_config(
    'learningbot.test.qin_question_one', recorded ->> 'messageId', true
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'Pick one small action, finish it, and rebuild from the evidence.',
    jsonb_build_array(
      jsonb_build_object(
        'chunkId', 'qin-chunk-1',
        'courseTitle', 'Question Intelligence Course',
        'lessonTitle', 'Question Intelligence Lesson',
        'excerpt', 'A restart begins with the smallest credible action.'
      )
    ),
    'openai',
    'response-qin-0001',
    'trace-qin-assistant-0001',
    'assistant:qin-message-0001',
    'question-intelligence-test-operation-token-0001'
  );

  recorded := public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'What should I do when the cadence breaks twice in a row?',
    'text',
    'trace-qin-user-0002',
    'qin-user-message-0002'
  );
  perform set_config(
    'learningbot.test.qin_question_two', recorded ->> 'messageId', true
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'The published course material does not cover that yet.',
    '[]'::jsonb,
    'openai',
    'response-qin-0002',
    'trace-qin-assistant-0002',
    'assistant:qin-message-0002',
    'question-intelligence-test-operation-token-0001'
  );

  recorded := public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Is billing covered anywhere in this course?',
    'text',
    'trace-qin-user-0003',
    'qin-user-message-0003'
  );
  perform set_config(
    'learningbot.test.qin_question_three', recorded ->> 'messageId', true
  );
  perform public.learning_record_assistant_message(
    (started ->> 'conversationId')::uuid,
    'The published learning does not establish anything about billing.',
    '[]'::jsonb,
    'openai',
    'response-qin-0003',
    'trace-qin-assistant-0003',
    'assistant:qin-message-0003',
    'question-intelligence-test-operation-token-0001'
  );
end $$;

-- QIN-01: a label is stored against the exact message, inherits the recorded
-- course context, and takes its grounding outcome from the answer that was
-- actually recorded rather than from anything the caller asserted.
do $$
declare
  first_label jsonb;
  second_label jsonb;
  stored record;
begin
  first_label := public.learning_record_question_label(
    current_setting('learningbot.test.qin_question_one')::uuid,
    'restart-loop',
    'Restart loop',
    'how_to',
    'critical',
    'openai:gpt-test',
    'qin-classifier-v1',
    'trace-qin-label-0001',
    'qin-label-0001',
    'question-intelligence-test-operation-token-0001'
  );
  second_label := public.learning_record_question_label(
    current_setting('learningbot.test.qin_question_two')::uuid,
    'restart-loop',
    'Restart loop',
    'troubleshooting',
    'notable',
    'openai:gpt-test',
    'qin-classifier-v1',
    'trace-qin-label-0002',
    'qin-label-0002',
    'question-intelligence-test-operation-token-0001'
  );

  if first_label ->> 'ok' <> 'true'
    or first_label ->> 'groundingOutcome' <> 'grounded'
    or (first_label ->> 'replaced')::boolean is true
    or second_label ->> 'ok' <> 'true'
    or second_label ->> 'groundingOutcome' <> 'ungrounded'
  then
    raise exception
      'QIN-01 failed: label write or grounding resolution is invalid';
  end if;

  select * into stored
  from public.question_labels ql
  where ql.tenant_id = current_setting('learningbot.test.qin_tenant_a')::uuid
    and ql.message_id
      = current_setting('learningbot.test.qin_question_one')::uuid;

  if not found
    or stored.course_id
      <> current_setting('learningbot.test.qin_course_a')::uuid
    or stored.lesson_id
      <> current_setting('learningbot.test.qin_lesson_a')::uuid
    or stored.question_intent <> 'how_to'
    or stored.importance <> 'critical'
    or stored.importance_rank <> 3
    or stored.record_version <> 1
  then
    raise exception 'QIN-01 failed: stored label context is invalid';
  end if;
end $$;

-- QIN-02: re-classifying the same question replaces its label instead of
-- appending a second, contradictory one.
do $$
declare
  replaced jsonb;
  label_rows bigint;
  stored record;
begin
  replaced := public.learning_record_question_label(
    current_setting('learningbot.test.qin_question_one')::uuid,
    'restart-cadence',
    'Restart cadence',
    'definition',
    'notable',
    'openai:gpt-test',
    'qin-classifier-v2',
    'trace-qin-label-0001',
    'qin-label-0001',
    'question-intelligence-test-operation-token-0001'
  );

  select count(*)::bigint
  into label_rows
  from public.question_labels ql
  where ql.tenant_id = current_setting('learningbot.test.qin_tenant_a')::uuid
    and ql.message_id
      = current_setting('learningbot.test.qin_question_one')::uuid;

  select * into stored
  from public.question_labels ql
  where ql.tenant_id = current_setting('learningbot.test.qin_tenant_a')::uuid
    and ql.message_id
      = current_setting('learningbot.test.qin_question_one')::uuid;

  if replaced ->> 'ok' <> 'true'
    or (replaced ->> 'replaced')::boolean is not true
    or label_rows <> 1
    or stored.topic_key <> 'restart-cadence'
    or stored.question_intent <> 'definition'
    or stored.importance_rank <> 2
    or stored.classifier_version <> 'qin-classifier-v2'
    or stored.record_version <> 2
  then
    raise exception
      'QIN-02 failed: re-classification duplicated instead of replacing';
  end if;
end $$;

-- QIN-03: a browser-role caller cannot forge a label. The operation token is
-- the gate, and the table itself refuses a direct write from authenticated.
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
  forged jsonb;
  forged_by_owner jsonb;
  direct_write_denied boolean := false;
  label_rows bigint;
begin
  forged := public.learning_record_question_label(
    current_setting('learningbot.test.qin_question_three')::uuid,
    'forged-topic',
    'Forged topic',
    'definition',
    'critical',
    'browser:forgery',
    'forged-v1',
    'trace-qin-forge-0001',
    'qin-forge-0001',
    'a-browser-supplied-token-that-is-not-real-0001'
  );
  if forged ->> 'code' <> 'access_denied' or forged ->> 'ok' <> 'false' then
    raise exception 'QIN-03 failed: a browser session forged a label';
  end if;

  begin
    insert into public.question_labels (
      tenant_id, message_id, conversation_id, subject_user_id, topic_key,
      topic_label, question_intent, importance, importance_rank,
      grounding_outcome, classifier_key, classifier_version, asked_at,
      trace_id, idempotency_key
    ) values (
      current_setting('learningbot.test.qin_tenant_a')::uuid,
      current_setting('learningbot.test.qin_question_three')::uuid,
      current_setting('learningbot.test.qin_conversation_a')::uuid,
      'c3300000-0000-4000-8000-000000000002',
      'direct-write', 'Direct write', 'definition', 'critical', 3,
      'grounded', 'browser:direct', 'direct-v1', now(),
      'trace-qin-direct-0001', 'qin-direct-0001'
    );
  exception
    when others then
      direct_write_denied := true;
  end;

  select count(*)::bigint
  into label_rows
  from public.question_labels ql
  where ql.message_id
    = current_setting('learningbot.test.qin_question_three')::uuid;

  if not direct_write_denied or label_rows <> 0 then
    raise exception
      'QIN-03 failed: a direct table write bypassed the operation token';
  end if;
end $$;

-- The same forgery attempt from a tenant owner is refused too: the gate is the
-- token, not the role.
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
  forged jsonb;
begin
  forged := public.learning_record_question_label(
    current_setting('learningbot.test.qin_question_three')::uuid,
    'forged-topic',
    'Forged topic',
    'definition',
    'critical',
    'console:forgery',
    'forged-v1',
    'trace-qin-forge-0002',
    'qin-forge-0002',
    'an-owner-supplied-token-that-is-not-real-0002'
  );
  if forged ->> 'code' <> 'access_denied' then
    raise exception 'QIN-03 failed: a tenant owner forged a label';
  end if;
end $$;

-- QIN-04: the read path reports the unclassified remainder instead of hiding
-- it, and never renders an absent classification as an empty distribution.
do $$
declare
  labels jsonb;
  coverage jsonb;
  topics jsonb;
  intents jsonb;
  important jsonb;
begin
  labels := public.analytics_question_labels(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  coverage := labels -> 'metrics' -> 'classificationCoverage';
  topics := labels -> 'metrics' -> 'topicDistribution';
  intents := labels -> 'metrics' -> 'intentDistribution';
  important := labels -> 'metrics' -> 'importantQuestions';

  if labels ->> 'ok' <> 'true'
    or labels ->> 'dataMode' <> 'durable'
    or (coverage -> 'value' ->> 'questions')::bigint <> 3
    or (coverage -> 'value' ->> 'classifiedQuestions')::bigint <> 2
    or (coverage -> 'value' ->> 'unclassifiedQuestions')::bigint <> 1
    or coverage ->> 'state' <> 'partial'
    or jsonb_array_length(coverage -> 'limitations') < 1
  then
    raise exception 'QIN-04 failed: classification coverage is invalid';
  end if;

  if topics ->> 'state' <> 'partial'
    or jsonb_array_length(topics -> 'value' -> 'topics') <> 2
    or (topics -> 'value' ->> 'classifiedQuestions')::bigint <> 2
    or (topics -> 'value' -> 'unclassified' ->> 'questions')::bigint <> 1
    or topics::text not like '%restart-cadence%'
    or topics::text not like '%restart-loop%'
    or jsonb_array_length(topics -> 'limitations') < 1
  then
    raise exception 'QIN-04 failed: topic distribution is invalid';
  end if;

  -- The intent taxonomy is closed, so all six members are reported. A zero
  -- here is a measured zero, unlike an absent classification.
  if jsonb_array_length(intents -> 'value' -> 'intents') <> 6
    or (intents -> 'value' -> 'unclassified' ->> 'questions')::bigint <> 1
  then
    raise exception 'QIN-04 failed: intent distribution is invalid';
  end if;

  if jsonb_array_length(important -> 'value' -> 'questions') <> 2
    or important::text not like '%restart the cadence after a difficult week%'
    or important -> 'value' -> 'questions' -> 0 ->> 'groundingOutcome'
      not in ('grounded', 'ungrounded')
  then
    raise exception 'QIN-04 failed: important questions are invalid';
  end if;
end $$;

-- Tenant B records one question and never classifies it. Its distribution must
-- say so rather than render an empty chart implying nobody asked anything.
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
    'Tenant B question intelligence verification.',
    'Isolated Module B',
    'Isolated Lesson B',
    'Tenant B content that tenant A must never aggregate.',
    'qin-course-create-b-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'qin-course-publish-b-0001'
  );
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'qin-conversation-b-0001'
  );
  perform public.learning_record_user_message(
    (started ->> 'conversationId')::uuid,
    'Tenant B question that must stay inside tenant B.',
    'text',
    'trace-qin-user-b-0001',
    'qin-user-message-b-0001'
  );
end $$;

-- QIN-05: an unclassified range is unknown, not empty; and tenant B can never
-- see tenant A's labels, topics or signals through any path.
do $$
declare
  labels jsonb;
  topics jsonb;
  signals jsonb;
  visible_labels bigint;
  visible_signals bigint;
begin
  labels := public.analytics_question_labels(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  topics := labels -> 'metrics' -> 'topicDistribution';
  signals := public.analytics_signals(
    now() - interval '1 day',
    now() + interval '1 hour'
  );

  if (
    labels -> 'metrics' -> 'classificationCoverage' -> 'value'
      ->> 'questions'
  )::bigint <> 1
    or (
      labels -> 'metrics' -> 'classificationCoverage' -> 'value'
        ->> 'classifiedQuestions'
    )::bigint <> 0
  then
    raise exception 'QIN-05 failed: tenant B totals are invalid';
  end if;

  -- The honesty rule: no classification means unknown with a reason, never a
  -- value carrying an empty topic list.
  if topics ->> 'state' <> 'unknown'
    or topics ? 'value'
    or jsonb_array_length(topics -> 'limitations') < 1
    or labels -> 'metrics' -> 'intentDistribution' ->> 'state' <> 'unknown'
    or labels -> 'metrics' -> 'importantQuestions' ->> 'state' <> 'unknown'
  then
    raise exception
      'QIN-05 failed: an absent classification was rendered as empty';
  end if;

  if labels::text like '%restart-cadence%'
    or labels::text like '%restart-loop%'
    or labels::text like '%Question Intelligence Lesson%'
    or signals::text like '%Question Intelligence Lesson%'
    or jsonb_array_length(
      signals -> 'metrics' -> 'detectedSignals' -> 'value' -> 'signals'
    ) <> 0
  then
    raise exception 'QIN-05 failed: cross-tenant intelligence was exposed';
  end if;

  select count(*)::bigint into visible_labels from public.question_labels;
  select count(*)::bigint into visible_signals from public.question_signals;
  if visible_labels <> 0 or visible_signals <> 0 then
    raise exception
      'QIN-05 failed: tenant B read another tenant''s rows directly';
  end if;
end $$;

-- QIN-06: signals carry their evidence, review moves forward only, an
-- undetected fingerprint is refused, and every decision is audited.
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
  signals jsonb;
  detected jsonb;
  gap jsonb;
  fingerprint text;
  acknowledged jsonb;
  actioned jsonb;
  repeated jsonb;
  unknown_signal jsonb;
  reviewed jsonb;
  audit_allow bigint;
  audit_deny bigint;
  stored_rows bigint;
begin
  signals := public.analytics_signals(
    now() - interval '1 day',
    now() + interval '1 hour'
  );
  detected := signals -> 'metrics' -> 'detectedSignals';
  gap := detected -> 'value' -> 'signals' -> 0;
  fingerprint := gap ->> 'signalFingerprint';

  if signals ->> 'ok' <> 'true'
    or (detected -> 'value' ->> 'detectedSignals')::bigint < 1
    or gap ->> 'kind' <> 'content_gap'
    or (gap -> 'evidence' ->> 'ungroundedAnswers')::bigint <> 2
    or jsonb_array_length(gap -> 'evidenceRefs') < 1
    or gap -> 'review' ->> 'status' <> 'new'
    or signals -> 'metrics' -> 'undetectableSignals' ->> 'state' <> 'unknown'
    or signals -> 'metrics' -> 'undetectableSignals' ? 'value'
  then
    raise exception 'QIN-06 failed: signal detection or evidence is invalid';
  end if;

  acknowledged := public.analytics_signal_review(
    fingerprint, 'acknowledged', 'Reviewed by the course team.',
    now() - interval '1 day', now() + interval '1 hour',
    'qin-review-0001', 'request-qin-review-0001', 'trace-qin-review-0001'
  );
  actioned := public.analytics_signal_review(
    fingerprint, 'actioned', 'Lesson content queued for a rewrite.',
    now() - interval '1 day', now() + interval '1 hour',
    'qin-review-0002', 'request-qin-review-0002', 'trace-qin-review-0002'
  );
  -- Backwards is not a transition: the lifecycle is forward-only.
  repeated := public.analytics_signal_review(
    fingerprint, 'acknowledged', null,
    now() - interval '1 day', now() + interval '1 hour',
    'qin-review-0003', 'request-qin-review-0003', 'trace-qin-review-0003'
  );
  unknown_signal := public.analytics_signal_review(
    repeat('0', 64), 'acknowledged', null,
    now() - interval '1 day', now() + interval '1 hour',
    'qin-review-0004', 'request-qin-review-0004', 'trace-qin-review-0004'
  );

  if acknowledged ->> 'ok' <> 'true'
    or acknowledged ->> 'reviewStatus' <> 'acknowledged'
    or acknowledged ->> 'previousStatus' <> 'new'
    or actioned ->> 'ok' <> 'true'
    or actioned ->> 'reviewStatus' <> 'actioned'
    or actioned ->> 'previousStatus' <> 'acknowledged'
    or repeated ->> 'code' <> 'invalid_transition'
    or repeated ->> 'currentStatus' <> 'actioned'
    or unknown_signal ->> 'code' <> 'signal_not_found'
  then
    raise exception 'QIN-06 failed: the review lifecycle is invalid';
  end if;

  select count(*)::bigint
  into stored_rows
  from public.question_signals qs
  where qs.tenant_id = current_setting('learningbot.test.qin_tenant_a')::uuid
    and qs.signal_fingerprint = fingerprint
    and qs.review_status = 'actioned';
  if stored_rows <> 1 then
    raise exception
      'QIN-06 failed: the reviewed signal was not persisted exactly once';
  end if;

  select
    count(*) filter (where a.policy_decision = 'allow')::bigint,
    count(*) filter (where a.policy_decision = 'deny')::bigint
  into audit_allow, audit_deny
  from public.audit_ledger a
  where a.tenant_id = current_setting('learningbot.test.qin_tenant_a')::uuid
    and a.action = 'question.signal.review'
    and a.resource_type = 'question_signal';
  if audit_allow < 2 or audit_deny < 2 then
    raise exception 'QIN-06 failed: signal review was not audited';
  end if;

  -- The persisted review is visible on the next read of the same signal.
  reviewed := public.analytics_signals(
    now() - interval '1 day',
    now() + interval '1 hour'
  ) -> 'metrics' -> 'detectedSignals' -> 'value' -> 'signals' -> 0;
  if reviewed ->> 'signalFingerprint' <> fingerprint
    or reviewed -> 'review' ->> 'status' <> 'actioned'
    or reviewed -> 'review' ->> 'reviewedAt' is null
  then
    raise exception 'QIN-06 failed: a recorded review was not surfaced';
  end if;
end $$;
reset role;

-- QIN-03: only authenticated callers reach the entrypoints, and every helper
-- that could be used to fabricate a label or a signal stays private.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.learning_record_question_label(uuid,text,text,text,text,text,' ||
      'text,text,text,text)',
    'public.analytics_question_labels(timestamptz,timestamptz)',
    'public.analytics_signals(timestamptz,timestamptz)',
    'public.analytics_signal_review(text,text,text,timestamptz,timestamptz,' ||
      'text,text,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'QIN-03 failed: invalid privilege for %', signature;
    end if;
  end loop;

  foreach signature in array array[
    'app_private.question_signal_detections(timestamptz,timestamptz)',
    'app_private.question_signal_fingerprint(uuid,text,text)',
    'app_private.question_intent_taxonomy()',
    'app_private.question_importance_rank(text)',
    'app_private.question_severity_rank(text)',
    'app_private.question_intelligence_audit(uuid,text,text,text,text,text,' ||
      'text,text,text)'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception
        'QIN-03 failed: question intelligence helper % is exposed', signature;
    end if;
  end loop;

  for signature in
    select t.table_name
    from information_schema.tables t
    where t.table_schema = 'public'
      and t.table_name in ('question_labels', 'question_signals')
  loop
    if has_table_privilege('authenticated', 'public.' || signature, 'INSERT')
      or has_table_privilege('authenticated', 'public.' || signature, 'UPDATE')
      or has_table_privilege('authenticated', 'public.' || signature, 'DELETE')
      or has_table_privilege('anon', 'public.' || signature, 'SELECT')
    then
      raise exception 'QIN-03 failed: % accepts a direct write', signature;
    end if;
  end loop;
end $$;

rollback;
