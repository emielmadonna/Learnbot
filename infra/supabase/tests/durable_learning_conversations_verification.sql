-- Run after migrations 0001..0022. Verifies durable learner conversation
-- ownership, idempotency, server-authenticated assistant writes and isolation.
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
      'conversation-test-operation-token-000000000001',
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
    'd1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'conversation-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'conversation-b@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'conversation-a',
  'Conversation A',
  'conversation-bootstrap-a',
  'trace-conversation-bootstrap-a'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'conversation-b',
  'Conversation B',
  'conversation-bootstrap-b',
  'trace-conversation-bootstrap-b'
);

-- DLC-01: create the published course and conversation in tenant A.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1100000-0000-4000-8000-000000000001',
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
  replay jsonb;
begin
  draft := public.learning_create_course_draft(
    'Conversation Course',
    'Grounded conversation verification.',
    'Conversation Module',
    'Conversation Lesson',
    'The restart loop begins with the smallest credible next action.',
    'conversation-course-create-0001'
  );
  perform public.learning_publish_course(
    (draft ->> 'courseId')::uuid,
    'conversation-course-publish-0001'
  );
  started := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'conversation-start-0001'
  );
  replay := public.learning_start_conversation(
    (draft ->> 'courseId')::uuid,
    (draft ->> 'lessonId')::uuid,
    'conversation-start-0001'
  );
  if started ->> 'ok' <> 'true'
    or started ->> 'replayed' <> 'false'
    or replay ->> 'replayed' <> 'true'
    or replay ->> 'conversationId' <> started ->> 'conversationId'
  then
    raise exception 'DLC-01 failed: conversation create/replay is invalid';
  end if;
  perform set_config(
    'learningbot.test.conversation_id',
    started ->> 'conversationId',
    true
  );
end $$;

-- DLC-02: the learner turn is idempotent and forged assistant writes fail.
do $$
declare
  learner jsonb;
  learner_replay jsonb;
begin
  learner := public.learning_record_user_message(
    current_setting('learningbot.test.conversation_id')::uuid,
    'How do I restart after a difficult week?',
    'text',
    'trace-conversation-user-0001',
    'conversation-user-message-0001'
  );
  learner_replay := public.learning_record_user_message(
    current_setting('learningbot.test.conversation_id')::uuid,
    'How do I restart after a difficult week?',
    'text',
    'trace-conversation-user-0001',
    'conversation-user-message-0001'
  );
  if learner ->> 'replayed' <> 'false'
    or learner_replay ->> 'replayed' <> 'true'
  then
    raise exception 'DLC-02 failed: learner message replay is invalid';
  end if;

  begin
    perform public.learning_record_assistant_message(
      current_setting('learningbot.test.conversation_id')::uuid,
      'A forged answer.',
      '[]'::jsonb,
      'forged-provider',
      'forged-request',
      'trace-conversation-forged-0001',
      'conversation-forged-message-0001',
      'wrong-operation-token-0000000000000000'
    );
    raise exception 'DLC-02 failed: forged assistant message succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

-- DLC-03: a trusted answer with bounded citations is durable.
do $$
declare
  assistant jsonb;
  transcript jsonb;
begin
  assistant := public.learning_record_assistant_message(
    current_setting('learningbot.test.conversation_id')::uuid,
    'Choose one small action, complete it, and rebuild from evidence.',
    jsonb_build_array(jsonb_build_object(
      'chunkId', 'test-chunk',
      'courseTitle', 'Conversation Course',
      'lessonTitle', 'Conversation Lesson',
      'excerpt', 'The restart loop begins with the smallest credible action.'
    )),
    'openai',
    'response-test-0001',
    'trace-conversation-assistant-0001',
    'assistant:conversation-message-0001',
    'conversation-test-operation-token-000000000001'
  );
  transcript := public.learning_get_conversations(
    current_setting('learningbot.test.conversation_id')::uuid
  );
  if assistant ->> 'ok' <> 'true'
    or jsonb_array_length(transcript -> 'conversations') <> 1
    or jsonb_array_length(
      transcript -> 'conversations' -> 0 -> 'messages'
    ) <> 2
    or transcript -> 'conversations' -> 0 -> 'messages' -> 1
      ->> 'actorType' <> 'assistant'
    or transcript -> 'conversations' -> 0 -> 'messages' -> 1
      -> 'structuredContent' ->> 'grounding'
      <> 'published_tenant_knowledge'
  then
    raise exception 'DLC-03 failed: durable transcript is invalid';
  end if;
end $$;

-- DLC-04: another selected tenant cannot read tenant A's conversation.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  transcript jsonb;
begin
  transcript := public.learning_get_conversations(
    current_setting('learningbot.test.conversation_id')::uuid
  );
  if jsonb_array_length(transcript -> 'conversations') <> 0 then
    raise exception 'DLC-04 failed: cross-tenant transcript was exposed';
  end if;
  begin
    perform public.learning_record_user_message(
      current_setting('learningbot.test.conversation_id')::uuid,
      'Cross tenant write',
      'text',
      'trace-conversation-cross-tenant',
      'conversation-cross-tenant-message'
    );
    raise exception 'DLC-04 failed: cross-tenant message succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- DLC-05: a completed provider turn replays without another provider call.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  replay jsonb;
begin
  replay := public.learning_get_completed_turn(
    current_setting('learningbot.test.conversation_id')::uuid,
    'assistant:conversation-message-0001'
  );
  if replay ->> 'completed' <> 'true'
    or replay -> 'message' ->> 'role' <> 'assistant'
    or jsonb_array_length(replay -> 'message' -> 'sources') <> 1
  then
    raise exception 'DLC-05 failed: completed provider turn did not replay';
  end if;
end $$;
reset role;

-- DLC-06: only authenticated users execute public entrypoints, and the
-- operation-secret table/helper remain private.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.learning_start_conversation(uuid,uuid,text)',
    'public.learning_get_conversations(uuid)',
    'public.learning_record_user_message(uuid,text,text,text,text)',
    'public.learning_record_assistant_message(uuid,text,jsonb,text,text,text,text,text)',
    'public.learning_get_completed_turn(uuid,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'DLC-06 failed: invalid privilege for %', signature;
    end if;
  end loop;
  if has_table_privilege(
    'authenticated',
    'app_private.learning_operation_secrets',
    'SELECT'
  ) or has_function_privilege(
    'authenticated',
    'app_private.learning_operation_token_is_valid(text,text)',
    'EXECUTE'
  ) then
    raise exception 'DLC-06 failed: operation secret boundary is exposed';
  end if;
end $$;

rollback;
