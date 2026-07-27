-- Run after migrations 0001..20260726092000 on a disposable Supabase database.
-- Verifies the publish-visibility contract the console now promises:
--   APV-01 children added to an already published course are created as drafts
--          and stay invisible to learners until the course is republished, while
--          their author keeps seeing them,
--   APV-02 public.learning_publish_course promotes exactly those drafts, reports
--          how many modules and lessons it made visible, and the learner sees
--          them immediately afterwards,
--   APV-03 republishing never resurrects content an author deliberately
--          archived, so the reported counts are the whole truth,
--   APV-04 learning_get_workspace.canAuthor equals the authoring gate itself for
--          every role, and publishing is refused for a role outside it.
-- All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'apv-owner-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'apv-creator-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a3300000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'apv-teacher-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a4400000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'apv-student-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
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
select * from public.auth_bootstrap_tenant_owner(
  'apv-owner-a',
  'Publish Visibility Owner A',
  'apv-bootstrap-a',
  'trace-apv-bootstrap-a'
);
reset role;

select set_config(
  'learningbot.test.tenant_a',
  (select t.tenant_id::text from public.tenants t where t.slug = 'apv-owner-a'),
  true
);

-- A creator, a teacher and a learner inside the same tenant.
insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject
) values
  (
    'principal-apv-creator', 'human', 'oidc',
    'https://apv.example.test', 'apv-creator'
  ),
  (
    'principal-apv-teacher', 'human', 'oidc',
    'https://apv.example.test', 'apv-teacher'
  ),
  (
    'principal-apv-student', 'human', 'oidc',
    'https://apv.example.test', 'apv-student'
  );
insert into app_private.supabase_auth_principal_links (
  auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
) values
  (
    'a2200000-0000-4000-8000-000000000002', 'principal-apv-creator',
    current_setting('learningbot.test.tenant_a')::uuid, 'link-apv-creator'
  ),
  (
    'a3300000-0000-4000-8000-000000000003', 'principal-apv-teacher',
    current_setting('learningbot.test.tenant_a')::uuid, 'link-apv-teacher'
  ),
  (
    'a4400000-0000-4000-8000-000000000004', 'principal-apv-student',
    current_setting('learningbot.test.tenant_a')::uuid, 'link-apv-student'
  );
insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values
  (
    'membership-apv-creator',
    current_setting('learningbot.test.tenant_a')::uuid,
    'principal-apv-creator', 'creator', 'active', 'manual',
    'membership-apv-creator'
  ),
  (
    'membership-apv-teacher',
    current_setting('learningbot.test.tenant_a')::uuid,
    'principal-apv-teacher', 'teacher', 'active', 'manual',
    'membership-apv-teacher'
  ),
  (
    'membership-apv-student',
    current_setting('learningbot.test.tenant_a')::uuid,
    'principal-apv-student', 'student', 'active', 'manual',
    'membership-apv-student'
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_select_tenant(
  current_setting('learningbot.test.tenant_a')::uuid,
  'apv-select-creator',
  'trace-apv-select-creator'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a3300000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_select_tenant(
  current_setting('learningbot.test.tenant_a')::uuid,
  'apv-select-teacher',
  'trace-apv-select-teacher'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a4400000-0000-4000-8000-000000000004',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_select_tenant(
  current_setting('learningbot.test.tenant_a')::uuid,
  'apv-select-student',
  'trace-apv-select-student'
);
reset role;

-- A published course with one module and one lesson, exactly as an author who
-- has finished a first pass would leave it.
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
  created jsonb;
  published jsonb;
begin
  created := public.learning_create_course_draft(
    'Publish Visibility Course',
    'A course used to prove that later edits reach learners.',
    'First Module',
    'First Lesson',
    'The first durable lesson body with enough content to publish.',
    'apv-create-course-0001'
  );
  perform set_config(
    'learningbot.test.course_id', created ->> 'courseId', true
  );
  perform set_config(
    'learningbot.test.module_one', created ->> 'moduleId', true
  );
  published := public.learning_publish_course(
    (created ->> 'courseId')::uuid,
    'apv-publish-course-0001'
  );
  if published ->> 'status' <> 'published'
    or (published ->> 'publishedModules')::integer <> 1
    or (published ->> 'publishedLessons')::integer <> 1
  then
    raise exception
      'APV-02 failed: first publish reported %', published::text;
  end if;
end $$;
reset role;

select set_config(
  'learningbot.test.version',
  (
    select c.record_version::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_id')::uuid
  ),
  true
);

-- APV-01: a module and a lesson added to the already published course are
-- created as drafts. Their author sees them; a learner cannot.
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
  added_module jsonb;
  added_lesson jsonb;
  workspace jsonb;
begin
  added_module := public.learning_create_module(
    current_setting('learningbot.test.course_id')::uuid,
    'Second Module',
    current_setting('learningbot.test.version')::bigint,
    'apv-module-create-0001'
  );
  added_lesson := public.learning_create_lesson(
    (added_module ->> 'moduleId')::uuid,
    'Second Lesson',
    'The second durable lesson body, added after the course went live.',
    (added_module ->> 'recordVersion')::bigint,
    'apv-lesson-create-0001'
  );
  if added_module ->> 'status' <> 'draft'
    or added_lesson ->> 'status' <> 'draft'
  then
    raise exception 'APV-01 failed: new children were not created as drafts';
  end if;
  perform set_config(
    'learningbot.test.module_two', added_module ->> 'moduleId', true
  );

  workspace := public.learning_get_workspace();
  if jsonb_array_length(workspace -> 'courses' -> 0 -> 'modules') <> 2 then
    raise exception 'APV-01 failed: the author cannot see the draft module';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a4400000-0000-4000-8000-000000000004',
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
  if jsonb_array_length(workspace -> 'courses') <> 1
    or jsonb_array_length(workspace -> 'courses' -> 0 -> 'modules') <> 1
  then
    raise exception
      'APV-01 failed: a learner saw unpublished content in a live course';
  end if;
end $$;
reset role;

-- APV-02: republishing promotes exactly those drafts, says how many of each it
-- promoted, and the learner sees them straight away.
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
  republished jsonb;
begin
  republished := public.learning_publish_course(
    current_setting('learningbot.test.course_id')::uuid,
    'apv-publish-course-0002'
  );
  if republished ->> 'ok' <> 'true'
    or (republished ->> 'publishedModules')::integer <> 1
    or (republished ->> 'publishedLessons')::integer <> 1
  then
    raise exception
      'APV-02 failed: republish reported %', republished::text;
  end if;
end $$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a4400000-0000-4000-8000-000000000004',
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
  if jsonb_array_length(workspace -> 'courses' -> 0 -> 'modules') <> 2
    or jsonb_array_length(
      workspace -> 'courses' -> 0 -> 'modules' -> 1 -> 'lessons'
    ) <> 1
  then
    raise exception
      'APV-02 failed: the republished module never reached the learner';
  end if;
end $$;
reset role;

select set_config(
  'learningbot.test.version',
  (
    select c.record_version::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_id')::uuid
  ),
  true
);

-- APV-03: archiving is a decision, not a draft. A later publish promotes the
-- new draft lesson and leaves the archived module archived, so the counts the
-- console shows before publishing remain the whole truth afterwards.
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
  archived jsonb;
  added_lesson jsonb;
  republished jsonb;
begin
  archived := public.learning_update_module(
    current_setting('learningbot.test.module_two')::uuid,
    null,
    'archived',
    current_setting('learningbot.test.version')::bigint,
    'apv-module-archive-0001'
  );
  added_lesson := public.learning_create_lesson(
    current_setting('learningbot.test.module_one')::uuid,
    'Third Lesson',
    'A third durable lesson body added while a module sits archived.',
    (archived ->> 'recordVersion')::bigint,
    'apv-lesson-create-0002'
  );
  republished := public.learning_publish_course(
    current_setting('learningbot.test.course_id')::uuid,
    'apv-publish-course-0003'
  );
  if (republished ->> 'publishedModules')::integer <> 0
    or (republished ->> 'publishedLessons')::integer <> 1
    or added_lesson ->> 'status' <> 'draft'
  then
    raise exception
      'APV-03 failed: publish reported %', republished::text;
  end if;
end $$;
reset role;

do $$
declare
  archived_status text;
begin
  select m.status
  into archived_status
  from public.modules m
  where m.module_id = current_setting('learningbot.test.module_two')::uuid;
  if archived_status <> 'archived' then
    raise exception
      'APV-03 failed: publish resurrected an archived module as %',
      archived_status;
  end if;
end $$;

-- APV-04: canAuthor is the authoring gate itself, not a guess about seniority.
-- Both sides are read here for the same caller and must agree for every role.
-- The block runs as the migration owner because app_private.authoring_rpc_context
-- is deliberately not executable by `authenticated`; the caller it resolves comes
-- from the request claims, so switching the database role would change nothing
-- about which principal is being asked.
do $$
declare
  subject text;
  expectation boolean;
  workspace jsonb;
  gate boolean;
begin
  foreach subject in array array[
    'a1100000-0000-4000-8000-000000000001',
    'a2200000-0000-4000-8000-000000000002',
    'a3300000-0000-4000-8000-000000000003',
    'a4400000-0000-4000-8000-000000000004'
  ]
  loop
    expectation := subject in (
      'a1100000-0000-4000-8000-000000000001',
      'a2200000-0000-4000-8000-000000000002'
    );
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub', subject,
        'role', 'authenticated',
        'is_anonymous', false,
        'app_metadata', '{}'::jsonb
      )::text,
      true
    );
    workspace := public.learning_get_workspace();
    gate := exists (select 1 from app_private.authoring_rpc_context());
    if (workspace -> 'identity' ->> 'canAuthor')::boolean <> expectation
      or gate <> expectation
    then
      raise exception
        'APV-04 failed: % reported canAuthor=% gate=% expected=%',
        workspace -> 'identity' ->> 'role',
        workspace -> 'identity' ->> 'canAuthor',
        gate,
        expectation;
    end if;
  end loop;
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a3300000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  begin
    perform public.learning_publish_course(
      current_setting('learningbot.test.course_id')::uuid,
      'apv-publish-course-teacher-0001'
    );
    raise exception 'APV-04 failed: a teacher published a course';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- The two replaced entrypoints keep the execution boundary they were given.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.learning_get_workspace()',
    'public.learning_publish_course(uuid,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'APV-04 failed: invalid privilege for %', signature;
    end if;
  end loop;
end $$;

rollback;
