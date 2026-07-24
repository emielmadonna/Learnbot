-- Run after migrations 0001..0017. Verifies tenant-bound durable learning,
-- authoring, publication, progress aggregation, idempotency and privileges.
-- All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'c1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'learning-owner-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'learning-owner-b@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'learning-owner-a',
  'Learning Owner A',
  'learning-bootstrap-a',
  'trace-learning-bootstrap-a'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'learning-owner-b',
  'Learning Owner B',
  'learning-bootstrap-b',
  'trace-learning-bootstrap-b'
);

-- DLW-01: an empty durable tenant returns no substituted fixture course.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  workspace jsonb;
begin
  workspace := public.learning_get_workspace();
  if workspace ->> 'ok' <> 'true'
    or workspace ->> 'dataMode' <> 'durable'
    or workspace -> 'tenant' ->> 'slug' <> 'learning-owner-a'
    or jsonb_array_length(workspace -> 'courses') <> 0
  then
    raise exception 'DLW-01 failed: empty workspace is not truthful';
  end if;
end $$;

-- DLW-02: course creation is atomic, durable and exactly replayable.
do $$
declare
  first_result jsonb;
  replay_result jsonb;
begin
  first_result := public.learning_create_course_draft(
    'Durable Course',
    'A durable course created through the authenticated learning RPC.',
    'Durable Module',
    'Durable Lesson',
    'This is the first durable lesson and contains enough content to publish.',
    'learning-create-course-a-0001'
  );
  replay_result := public.learning_create_course_draft(
    'Durable Course',
    'A durable course created through the authenticated learning RPC.',
    'Durable Module',
    'Durable Lesson',
    'This is the first durable lesson and contains enough content to publish.',
    'learning-create-course-a-0001'
  );
  if first_result ->> 'ok' <> 'true'
    or first_result ->> 'status' <> 'draft'
    or replay_result is distinct from first_result
  then
    raise exception 'DLW-02 failed: create/replay result is invalid';
  end if;
  perform set_config(
    'learningbot.test.course_id',
    first_result ->> 'courseId',
    true
  );
  perform set_config(
    'learningbot.test.lesson_id',
    first_result ->> 'lessonId',
    true
  );
end $$;

-- DLW-03: publication exposes the hierarchy and progress updates aggregate.
do $$
declare
  published jsonb;
  progress jsonb;
  workspace jsonb;
begin
  published := public.learning_publish_course(
    current_setting('learningbot.test.course_id')::uuid,
    'learning-publish-course-a-0001'
  );
  progress := public.learning_mark_lesson_progress(
    current_setting('learningbot.test.lesson_id')::uuid,
    'completed',
    'learning-progress-a-0001'
  );
  workspace := public.learning_get_workspace();
  if published ->> 'status' <> 'published'
    or progress -> 'courseProgress' ->> 'percentComplete' <> '100.00'
    or workspace -> 'courses' -> 0 ->> 'title' <> 'Durable Course'
    or workspace -> 'courses' -> 0 -> 'progress' ->> 'lessonsCompleted' <> '1'
    or workspace -> 'courses' -> 0 -> 'modules' -> 0
      -> 'lessons' -> 0 ->> 'progressState' <> 'completed'
  then
    raise exception 'DLW-03 failed: publish/progress workspace is invalid';
  end if;
end $$;

-- DLW-04: another selected tenant cannot see or mutate the first tenant.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  workspace jsonb;
begin
  workspace := public.learning_get_workspace();
  if workspace -> 'tenant' ->> 'slug' <> 'learning-owner-b'
    or jsonb_array_length(workspace -> 'courses') <> 0
  then
    raise exception 'DLW-04 failed: cross-tenant course was exposed';
  end if;
  begin
    perform public.learning_mark_lesson_progress(
      current_setting('learningbot.test.lesson_id')::uuid,
      'completed',
      'learning-progress-cross-tenant-0001'
    );
    raise exception 'DLW-04 failed: cross-tenant lesson mutation succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- DLW-05: public/anon/service roles cannot execute the learning entrypoints.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.learning_get_workspace()',
    'public.learning_mark_lesson_progress(uuid,text,text)',
    'public.learning_create_course_draft(text,text,text,text,text,text)',
    'public.learning_publish_course(uuid,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'DLW-05 failed: invalid privilege for %', signature;
    end if;
  end loop;
  if has_function_privilege(
    'authenticated',
    'app_private.learning_rpc_context()',
    'EXECUTE'
  ) then
    raise exception 'DLW-05 failed: private context helper is executable';
  end if;
end $$;

rollback;
