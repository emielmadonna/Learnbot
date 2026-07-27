-- Run after migrations 0001..20260725122000 on a disposable Supabase database.
-- Verifies CED-01 authored mutations append immutable revisions and audit
-- evidence, CED-02 stale optimistic versions are rejected, CED-03 cross-tenant
-- editing is denied, CED-04 learner and teacher roles cannot mutate, CED-05
-- reordering is atomic and leaves no duplicate positions, CED-06 soft deletes
-- disappear from the learner workspace, CED-07 rollback restores the prior
-- revision, and CED-08 the execution boundary. All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'edit-owner-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'edit-owner-b@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e3300000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'edit-creator-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e4400000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'edit-teacher-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e5500000-0000-4000-8000-000000000005',
    'authenticated', 'authenticated', 'edit-student-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  );

-- Bootstrap two isolated owner tenants through the verified 0011 bridge.
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
select * from public.auth_bootstrap_tenant_owner(
  'edit-owner-a',
  'Edit Owner A',
  'edit-bootstrap-a',
  'trace-edit-bootstrap-a'
);
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
select * from public.auth_bootstrap_tenant_owner(
  'edit-owner-b',
  'Edit Owner B',
  'edit-bootstrap-b',
  'trace-edit-bootstrap-b'
);
reset role;

select set_config(
  'learningbot.test.tenant_a',
  (select t.tenant_id::text from public.tenants t where t.slug = 'edit-owner-a'),
  true
);

-- A creator, a teacher and a learner inside the same tenant.
insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject
) values
  (
    'principal-edit-creator', 'human', 'oidc',
    'https://edit.example.test', 'edit-creator'
  ),
  (
    'principal-edit-teacher', 'human', 'oidc',
    'https://edit.example.test', 'edit-teacher'
  ),
  (
    'principal-edit-student', 'human', 'oidc',
    'https://edit.example.test', 'edit-student'
  );
insert into app_private.supabase_auth_principal_links (
  auth_user_id, principal_id, bootstrap_tenant_id, idempotency_key
) values
  (
    'e3300000-0000-4000-8000-000000000003', 'principal-edit-creator',
    current_setting('learningbot.test.tenant_a')::uuid, 'link-edit-creator'
  ),
  (
    'e4400000-0000-4000-8000-000000000004', 'principal-edit-teacher',
    current_setting('learningbot.test.tenant_a')::uuid, 'link-edit-teacher'
  ),
  (
    'e5500000-0000-4000-8000-000000000005', 'principal-edit-student',
    current_setting('learningbot.test.tenant_a')::uuid, 'link-edit-student'
  );
insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values
  (
    'membership-edit-creator',
    current_setting('learningbot.test.tenant_a')::uuid,
    'principal-edit-creator', 'creator', 'active', 'manual',
    'membership-edit-creator'
  ),
  (
    'membership-edit-teacher',
    current_setting('learningbot.test.tenant_a')::uuid,
    'principal-edit-teacher', 'teacher', 'active', 'manual',
    'membership-edit-teacher'
  ),
  (
    'membership-edit-student',
    current_setting('learningbot.test.tenant_a')::uuid,
    'principal-edit-student', 'student', 'active', 'manual',
    'membership-edit-student'
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
select * from public.auth_select_tenant(
  current_setting('learningbot.test.tenant_a')::uuid,
  'edit-select-creator',
  'trace-edit-select-creator'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e4400000-0000-4000-8000-000000000004',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_select_tenant(
  current_setting('learningbot.test.tenant_a')::uuid,
  'edit-select-teacher',
  'trace-edit-select-teacher'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e5500000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_select_tenant(
  current_setting('learningbot.test.tenant_a')::uuid,
  'edit-select-student',
  'trace-edit-select-student'
);
reset role;

-- CED-01: a creator may correct an existing course. Every accepted mutation
-- advances the single course concurrency token by exactly one, appends one
-- immutable revision through the compare-and-swap head, and appends one
-- audit_ledger entry.
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
  created jsonb;
  updated jsonb;
  replayed jsonb;
  module_two jsonb;
  lesson_two jsonb;
  block_added jsonb;
  block_edited jsonb;
begin
  created := public.learning_create_course_draft(
    'Editable Course',
    'The first durable description of an editable course.',
    'First Module',
    'First Lesson',
    'The first durable lesson body with enough content to publish.',
    'edit-create-course-0001'
  );
  perform set_config(
    'learningbot.test.course_id', created ->> 'courseId', true
  );
  perform set_config(
    'learningbot.test.module_one', created ->> 'moduleId', true
  );

  updated := public.learning_update_course(
    (created ->> 'courseId')::uuid,
    'Editable Course Two',
    'A corrected description of an editable course.',
    1,
    'edit-course-update-0001'
  );
  replayed := public.learning_update_course(
    (created ->> 'courseId')::uuid,
    'Editable Course Two',
    'A corrected description of an editable course.',
    1,
    'edit-course-update-0001'
  );
  if updated ->> 'ok' <> 'true'
    or (updated ->> 'recordVersion')::bigint <> 2
    or (updated -> 'revision' ->> 'revisionNumber')::bigint <> 1
    or updated -> 'revision' ->> 'revisionKind' <> 'edited'
    or replayed is distinct from updated
  then
    raise exception 'CED-01 failed: course update or replay is invalid';
  end if;

  module_two := public.learning_create_module(
    (created ->> 'courseId')::uuid, 'Second Module', 2,
    'edit-module-create-0001'
  );
  lesson_two := public.learning_create_lesson(
    (module_two ->> 'moduleId')::uuid,
    'Second Lesson',
    'The second durable lesson body used by the editing verification.',
    3,
    'edit-lesson-create-0001'
  );
  block_added := public.learning_create_content_block(
    (lesson_two ->> 'lessonId')::uuid,
    'rich_text',
    jsonb_build_object('text', 'An appended block.', 'format', 'plain_text'),
    4,
    'edit-block-create-0001'
  );
  block_edited := public.learning_update_content_block(
    (block_added ->> 'contentBlockId')::uuid,
    'rich_text',
    jsonb_build_object('text', 'A corrected block.', 'format', 'plain_text'),
    5,
    'edit-block-update-0001'
  );
  if (module_two ->> 'recordVersion')::bigint <> 3
    or (lesson_two ->> 'recordVersion')::bigint <> 4
    or (block_added ->> 'recordVersion')::bigint <> 5
    or (block_edited ->> 'recordVersion')::bigint <> 6
    or (block_edited -> 'revision' ->> 'revisionNumber')::bigint <> 5
  then
    raise exception 'CED-01 failed: authored mutations are not sequenced';
  end if;

  perform set_config(
    'learningbot.test.module_two', module_two ->> 'moduleId', true
  );
  perform set_config(
    'learningbot.test.lesson_two', lesson_two ->> 'lessonId', true
  );
  perform set_config('learningbot.test.version', '6', true);
end $$;
reset role;

do $$
declare
  revision_count integer;
  audit_count integer;
  head_number bigint;
begin
  select count(*)::integer
  into revision_count
  from public.course_revisions r
  where r.course_id = current_setting('learningbot.test.course_id')::uuid;
  select count(*)::integer
  into audit_count
  from public.audit_ledger a
  where a.resource_type = 'course'
    and a.resource_id = current_setting('learningbot.test.course_id')
    and a.policy_decision = 'allow'
    and a.actor_type = 'creator';
  select h.current_revision_number
  into head_number
  from public.course_revision_heads h
  where h.course_id = current_setting('learningbot.test.course_id')::uuid;
  if revision_count <> 5 or audit_count <> 5 or head_number <> 5 then
    raise exception
      'CED-01 failed: revisions=% audits=% head=%',
      revision_count, audit_count, head_number;
  end if;
end $$;

-- CED-02: a stale expected_version is rejected and appends nothing.
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
begin
  begin
    perform public.learning_update_course(
      current_setting('learningbot.test.course_id')::uuid,
      'A stale correction',
      null,
      1,
      'edit-stale-course-0001'
    );
    raise exception 'CED-02 failed: stale course update succeeded';
  exception
    when serialization_failure then null;
  end;
  begin
    perform public.learning_delete_lesson(
      current_setting('learningbot.test.lesson_two')::uuid,
      99,
      'edit-stale-lesson-0001'
    );
    raise exception 'CED-02 failed: stale lesson delete succeeded';
  exception
    when serialization_failure then null;
  end;
end $$;
reset role;

do $$
declare
  revision_count integer;
begin
  select count(*)::integer
  into revision_count
  from public.course_revisions r
  where r.course_id = current_setting('learningbot.test.course_id')::uuid;
  if revision_count <> 5 then
    raise exception 'CED-02 failed: a rejected edit appended a revision';
  end if;
end $$;

-- CED-03: another tenant owner cannot read or edit this course.
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
  revisions jsonb;
begin
  begin
    perform public.learning_update_course(
      current_setting('learningbot.test.course_id')::uuid,
      'A hostile title',
      null,
      6,
      'edit-cross-tenant-course-0001'
    );
    raise exception 'CED-03 failed: cross-tenant course update succeeded';
  exception
    when no_data_found then null;
  end;
  begin
    perform public.learning_create_module(
      current_setting('learningbot.test.course_id')::uuid,
      'A hostile module',
      6,
      'edit-cross-tenant-module-0001'
    );
    raise exception 'CED-03 failed: cross-tenant module create succeeded';
  exception
    when no_data_found then null;
  end;
  begin
    perform public.learning_reorder(
      'course',
      current_setting('learningbot.test.course_id')::uuid,
      array[current_setting('learningbot.test.module_two')::uuid],
      6,
      'edit-cross-tenant-reorder-0001'
    );
    raise exception 'CED-03 failed: cross-tenant reorder succeeded';
  exception
    when no_data_found then null;
  end;
  revisions := public.learning_list_course_revisions(
    current_setting('learningbot.test.course_id')::uuid
  );
  if revisions ->> 'ok' <> 'false'
    or revisions ->> 'code' <> 'course_not_found'
  then
    raise exception 'CED-03 failed: cross-tenant revision history was exposed';
  end if;
end $$;
reset role;

-- CED-04: a teacher may teach and a learner may learn, but neither may
-- restructure an authored course.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e4400000-0000-4000-8000-000000000004',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  begin
    perform public.learning_update_course(
      current_setting('learningbot.test.course_id')::uuid,
      'A teacher correction',
      null,
      6,
      'edit-teacher-course-0001'
    );
    raise exception 'CED-04 failed: a teacher edited a course';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.learning_reorder(
      'course',
      current_setting('learningbot.test.course_id')::uuid,
      array[
        current_setting('learningbot.test.module_two')::uuid,
        current_setting('learningbot.test.module_one')::uuid
      ],
      6,
      'edit-teacher-reorder-0001'
    );
    raise exception 'CED-04 failed: a teacher reordered a course';
  exception
    when insufficient_privilege then null;
  end;
end $$;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e5500000-0000-4000-8000-000000000005',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  begin
    perform public.learning_create_module(
      current_setting('learningbot.test.course_id')::uuid,
      'A learner module',
      6,
      'edit-student-module-0001'
    );
    raise exception 'CED-04 failed: a learner created a module';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.learning_delete_module(
      current_setting('learningbot.test.module_two')::uuid,
      6,
      'edit-student-delete-0001'
    );
    raise exception 'CED-04 failed: a learner deleted a module';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- CED-05: reordering is applied atomically and never leaves a duplicate or a
-- gapped position, and a partial order is rejected without any effect.
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
  reordered jsonb;
begin
  reordered := public.learning_reorder(
    'course',
    current_setting('learningbot.test.course_id')::uuid,
    array[
      current_setting('learningbot.test.module_two')::uuid,
      current_setting('learningbot.test.module_one')::uuid
    ],
    6,
    'edit-reorder-modules-0001'
  );
  if reordered ->> 'ok' <> 'true'
    or (reordered ->> 'recordVersion')::bigint <> 7
    or (reordered -> 'revision' ->> 'revisionNumber')::bigint <> 6
  then
    raise exception 'CED-05 failed: reorder result is invalid';
  end if;
  begin
    perform public.learning_reorder(
      'course',
      current_setting('learningbot.test.course_id')::uuid,
      array[current_setting('learningbot.test.module_two')::uuid],
      7,
      'edit-reorder-partial-0001'
    );
    raise exception 'CED-05 failed: a partial reorder succeeded';
  exception
    when invalid_parameter_value then null;
  end;
  perform set_config('learningbot.test.version', '7', true);
end $$;
reset role;

do $$
declare
  module_one_position integer;
  module_two_position integer;
  total_modules integer;
  distinct_positions integer;
  max_position integer;
begin
  select m.position into module_one_position
  from public.modules m
  where m.module_id = current_setting('learningbot.test.module_one')::uuid;
  select m.position into module_two_position
  from public.modules m
  where m.module_id = current_setting('learningbot.test.module_two')::uuid;
  select
    count(*)::integer,
    count(distinct m.position)::integer,
    max(m.position)
  into total_modules, distinct_positions, max_position
  from public.modules m
  where m.course_id = current_setting('learningbot.test.course_id')::uuid;
  if module_two_position <> 0
    or module_one_position <> 1
    or total_modules <> distinct_positions
    or max_position <> total_modules - 1
  then
    raise exception
      'CED-05 failed: positions collided (rows=% distinct=% max=%)',
      total_modules, distinct_positions, max_position;
  end if;
end $$;

-- CED-06: publish, capture the published revision, then prove that a soft
-- deleted module and its lessons stop resolving in the learner workspace.
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
  published jsonb;
  checkpoint jsonb;
  history jsonb;
begin
  published := public.learning_publish_course(
    current_setting('learningbot.test.course_id')::uuid,
    'edit-publish-course-0001'
  );
  if published ->> 'status' <> 'published' then
    raise exception 'CED-06 failed: the course was not published';
  end if;
  -- Publishing does not itself append a revision, so record the published
  -- shape as the rollback checkpoint.
  checkpoint := public.learning_update_course(
    current_setting('learningbot.test.course_id')::uuid,
    'Editable Course Two',
    'A corrected description of an editable course.',
    8,
    'edit-checkpoint-course-0001'
  );
  history := public.learning_list_course_revisions(
    current_setting('learningbot.test.course_id')::uuid
  );
  if history ->> 'ok' <> 'true'
    or (history ->> 'headRevisionNumber')::bigint <> 7
    or history ->> 'headRevisionId'
      <> checkpoint -> 'revision' ->> 'revisionId'
  then
    raise exception 'CED-06 failed: revision history head is invalid';
  end if;
  perform set_config(
    'learningbot.test.checkpoint_revision',
    checkpoint -> 'revision' ->> 'revisionId',
    true
  );
  perform set_config('learningbot.test.version', '9', true);
end $$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e5500000-0000-4000-8000-000000000005',
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
    or jsonb_array_length(workspace -> 'courses' -> 0 -> 'modules') <> 2
    or workspace::text not like '%Second Module%'
    or workspace::text not like '%Second Lesson%'
  then
    raise exception 'CED-06 failed: the learner cannot see the published tree';
  end if;
end $$;
reset role;

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
  removed jsonb;
begin
  removed := public.learning_delete_module(
    current_setting('learningbot.test.module_two')::uuid,
    9,
    'edit-delete-module-0001'
  );
  if removed ->> 'ok' <> 'true'
    or removed ->> 'deleted' <> 'true'
    or (removed ->> 'recordVersion')::bigint <> 10
  then
    raise exception 'CED-06 failed: module removal result is invalid';
  end if;
  perform set_config('learningbot.test.version', '10', true);
end $$;
reset role;

do $$
declare
  live_lessons integer;
  live_blocks integer;
begin
  select count(*)::integer into live_lessons
  from public.lessons l
  where l.module_id = current_setting('learningbot.test.module_two')::uuid
    and l.deleted_at is null;
  select count(*)::integer into live_blocks
  from public.content_blocks cb
  where cb.lesson_id = current_setting('learningbot.test.lesson_two')::uuid
    and cb.deleted_at is null;
  if live_lessons <> 0 or live_blocks <> 0 then
    raise exception 'CED-06 failed: the soft delete did not cascade';
  end if;
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e5500000-0000-4000-8000-000000000005',
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
  if jsonb_array_length(workspace -> 'courses' -> 0 -> 'modules') <> 1
    or workspace::text like '%Second Module%'
    or workspace::text like '%Second Lesson%'
    or workspace::text like '%A corrected block.%'
  then
    raise exception 'CED-06 failed: removed content still reaches the learner';
  end if;
end $$;
reset role;

-- CED-07: rolling back to the captured revision restores the removed subtree
-- through the existing compare-and-swap head, and is itself an immutable
-- rolled_back revision.
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
  restored jsonb;
begin
  restored := public.learning_rollback_course(
    current_setting('learningbot.test.course_id')::uuid,
    current_setting('learningbot.test.checkpoint_revision'),
    10,
    'edit-rollback-course-0001'
  );
  if restored ->> 'ok' <> 'true'
    or restored -> 'revision' ->> 'revisionKind' <> 'rolled_back'
    or (restored ->> 'restoredRevisionNumber')::bigint <> 7
    or (restored -> 'revision' ->> 'revisionNumber')::bigint <> 9
  then
    raise exception 'CED-07 failed: rollback result is invalid';
  end if;
end $$;
reset role;

do $$
declare
  module_two_deleted timestamptz;
  live_lessons integer;
  live_blocks integer;
  total_modules integer;
  distinct_positions integer;
  rollback_target bigint;
begin
  select m.deleted_at into module_two_deleted
  from public.modules m
  where m.module_id = current_setting('learningbot.test.module_two')::uuid;
  select count(*)::integer into live_lessons
  from public.lessons l
  where l.module_id = current_setting('learningbot.test.module_two')::uuid
    and l.deleted_at is null;
  select count(*)::integer into live_blocks
  from public.content_blocks cb
  where cb.lesson_id = current_setting('learningbot.test.lesson_two')::uuid
    and cb.deleted_at is null;
  select count(*)::integer, count(distinct m.position)::integer
  into total_modules, distinct_positions
  from public.modules m
  where m.course_id = current_setting('learningbot.test.course_id')::uuid;
  select r.rollback_target_revision_number into rollback_target
  from public.course_revisions r
  where r.course_id = current_setting('learningbot.test.course_id')::uuid
    and r.revision_number = 9;
  if module_two_deleted is not null
    or live_lessons <> 1
    or live_blocks <> 2
    or total_modules <> distinct_positions
    or rollback_target <> 7
  then
    raise exception
      'CED-07 failed: rollback did not restore the prior revision';
  end if;
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e5500000-0000-4000-8000-000000000005',
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
    or workspace::text not like '%Second Module%'
    or workspace::text not like '%Second Lesson%'
  then
    raise exception 'CED-07 failed: the learner did not regain the subtree';
  end if;
end $$;
reset role;

-- CED-08: anon and the hosted service_role cannot execute any editing
-- entrypoint, and the private authoring helpers are not reachable at all.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.learning_update_course(uuid,text,text,bigint,text)',
    'public.learning_create_module(uuid,text,bigint,text)',
    'public.learning_update_module(uuid,text,text,bigint,text)',
    'public.learning_delete_module(uuid,bigint,text)',
    'public.learning_create_lesson(uuid,text,text,bigint,text)',
    'public.learning_update_lesson(uuid,text,text,bigint,text)',
    'public.learning_delete_lesson(uuid,bigint,text)',
    'public.learning_create_content_block(uuid,text,jsonb,bigint,text)',
    'public.learning_update_content_block(uuid,text,jsonb,bigint,text)',
    'public.learning_delete_content_block(uuid,bigint,text)',
    'public.learning_reorder(text,uuid,uuid[],bigint,text)',
    'public.learning_list_course_revisions(uuid)',
    'public.learning_rollback_course(uuid,text,bigint,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'CED-08 failed: invalid privilege for %', signature;
    end if;
  end loop;

  foreach signature in array array[
    'app_private.authoring_rpc_context()',
    'app_private.authoring_course_snapshot(uuid,uuid)',
    'app_private.authoring_commit_revision(uuid,uuid,text,text,text,bigint)',
    'app_private.authoring_lock_course(uuid,uuid,bigint)',
    'app_private.authoring_bump_course(uuid,uuid)',
    'app_private.authoring_append_audit(uuid,text,text,text,text,text,text,text,text)'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'CED-08 failed: private helper % is executable', signature;
    end if;
  end loop;
end $$;

rollback;
