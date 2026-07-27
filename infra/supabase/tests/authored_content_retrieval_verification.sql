-- Run after migrations 0001..20260726095000 on a disposable Supabase database.
--
-- Proves the contract that closes the platform's most expensive defect: course
-- authoring wrote public.content_blocks, retrieval read public.learning_chunks,
-- and nothing joined them, so every newly provisioned client's assistant
-- answered "I couldn't find this in the published learning yet" forever.
--
--   ACR-01 publishing a course projects its published lessons into retrievable
--          chunks, public.learning_search_chunks finds them immediately with no
--          embedding present anywhere, and the citation payload carries the
--          lesson identity the answer path filters on,
--   ACR-02 draft and archived content is never retrievable: a draft lesson is
--          skipped by the projector, becomes retrievable only once published,
--          and stops being retrievable the moment it is archived,
--   ACR-03 republishing replaces the projection instead of duplicating it, an
--          unchanged republish does no work at all, and an unchanged chunk keeps
--          the embedding that was already paid for,
--   ACR-04 a failed projection is atomic: the publish that triggered it fails
--          with it, the previously active knowledge version is still active and
--          still answering, and no draft was silently promoted,
--   ACR-05 chunks are tenant-isolated in both directions, and the projection
--          state surface never reports another tenant's courses.
--
-- Table reads always happen with the session role, never inside an
-- `authenticated` block: 0011 deliberately strips tenant_id and app_role from
-- the JWT, so the RLS predicates on public.courses cannot be satisfied by a
-- browser session at all. Concurrency tokens are therefore captured between
-- blocks, which is also how a console reads them.
--
-- All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'ac110000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'acr-owner-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ac220000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'acr-owner-b@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'acr-owner-a',
  'Authored Retrieval Owner A',
  'acr-bootstrap-a',
  'trace-acr-bootstrap-a'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac220000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'acr-owner-b',
  'Authored Retrieval Owner B',
  'acr-bootstrap-b',
  'trace-acr-bootstrap-b'
);
reset role;

select set_config(
  'learningbot.test.tenant_a',
  (select t.tenant_id::text from public.tenants t where t.slug = 'acr-owner-a'),
  true
);
select set_config(
  'learningbot.test.tenant_b',
  (select t.tenant_id::text from public.tenants t where t.slug = 'acr-owner-b'),
  true
);

-- ---------------------------------------------------------------------------
-- ACR-01: publishing makes the authored lesson retrievable, with no embeddings
-- anywhere. Lexical retrieval is the floor a client is entitled to on the day
-- they publish; the embedding queue only improves ranking afterwards.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
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
  found_matches jsonb;
  first_match jsonb;
  state jsonb;
begin
  created := public.learning_create_course_draft(
    'Authored Retrieval Course A',
    'A course used to prove that publishing makes content answerable.',
    'Module One',
    'Lesson One',
    'The quokkanomics framework explains how a founding team allocates scarce attention across its first launch commitments.',
    'acr-create-course-a-0001'
  );
  perform set_config('learningbot.test.course_a', created ->> 'courseId', true);
  perform set_config('learningbot.test.module_one', created ->> 'moduleId', true);
  perform set_config('learningbot.test.lesson_one', created ->> 'lessonId', true);

  published := public.learning_publish_course(
    (created ->> 'courseId')::uuid,
    'acr-publish-a-0001'
  );
  if published ->> 'ok' <> 'true'
    or published -> 'knowledge' ->> 'changed' <> 'true'
    or (published -> 'knowledge' ->> 'chunkCount')::integer < 1
    or published -> 'knowledge' ->> 'activated' <> 'true'
  then
    raise exception 'ACR-01 failed: publish reported %', published::text;
  end if;

  found_matches := public.learning_search_chunks('quokkanomics', null::uuid, 6);
  if found_matches ->> 'ok' <> 'true'
    or found_matches ->> 'dataMode' <> 'durable'
    or jsonb_array_length(found_matches -> 'matches') < 1
  then
    raise exception
      'ACR-01 failed: a freshly published course answered nothing: %',
      found_matches::text;
  end if;

  -- The citation payload is load-bearing. api/learning/respond filters the
  -- retrieved sources by source.lessonId when a learner has a lesson selected,
  -- so a chunk that cannot name its lesson is a chunk that silently disappears.
  first_match := found_matches -> 'matches' -> 0;
  if first_match -> 'source' ->> 'lessonId'
      is distinct from current_setting('learningbot.test.lesson_one')
    or coalesce(first_match ->> 'courseTitle', '') = ''
    or coalesce(first_match ->> 'documentTitle', '') = ''
    or coalesce(first_match ->> 'excerpt', '') = ''
    or first_match -> 'source' ->> 'lessonName' <> 'Lesson One'
  then
    raise exception
      'ACR-01 failed: citation payload is unusable: %', first_match::text;
  end if;

  state := public.learning_course_knowledge_state(
    current_setting('learningbot.test.course_a')::uuid
  );
  if state -> 'courses' -> 0 ->> 'answerable' <> 'true'
    or state -> 'courses' -> 0 ->> 'state' <> 'ready'
    or (state -> 'courses' -> 0 ->> 'pendingEmbeddingCount')::integer < 1
  then
    raise exception
      'ACR-01 failed: knowledge state did not report an answerable course: %',
      state::text;
  end if;
end $$;
reset role;

do $$
declare
  embedded integer;
  version_status text;
  active_version uuid;
begin
  select count(*)::integer
  into embedded
  from public.learning_chunks ch
  where ch.tenant_id = current_setting('learningbot.test.tenant_a')::uuid
    and ch.embedding is not null;
  if embedded <> 0 then
    raise exception
      'ACR-01 failed: the fixture is not proving lexical-only retrieval';
  end if;

  select c.active_knowledge_version_id
  into active_version
  from public.courses c
  where c.course_id = current_setting('learningbot.test.course_a')::uuid;
  select kv.status
  into version_status
  from public.knowledge_versions kv
  where kv.knowledge_version_id = active_version;
  if active_version is null or version_status <> 'published' then
    raise exception
      'ACR-01 failed: the course does not point at a published knowledge version';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ACR-02: draft and archived content must never become retrievable.
-- 20260726092000 made that distinction meaningful for what a learner can see;
-- it has to mean the same thing for what the assistant is allowed to say.
-- ---------------------------------------------------------------------------
select set_config(
  'learningbot.test.version',
  (
    select c.record_version::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_a')::uuid
  ),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
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
  projected jsonb;
  draft_matches jsonb;
  live_matches jsonb;
begin
  added_module := public.learning_create_module(
    current_setting('learningbot.test.course_a')::uuid,
    'Module Two',
    current_setting('learningbot.test.version')::bigint,
    'acr-module-create-0001'
  );
  added_lesson := public.learning_create_lesson(
    (added_module ->> 'moduleId')::uuid,
    'Lesson Two',
    'Zarquonium sequencing is the deliberate ordering of onboarding tasks for a new cohort of learners.',
    (added_module ->> 'recordVersion')::bigint,
    'acr-lesson-create-0001'
  );
  perform set_config(
    'learningbot.test.module_two', added_module ->> 'moduleId', true
  );
  perform set_config(
    'learningbot.test.lesson_two', added_lesson ->> 'lessonId', true
  );

  -- Projecting without publishing must see the draft and refuse it.
  projected := public.learning_project_course_knowledge(
    current_setting('learningbot.test.course_a')::uuid,
    'acr-project-draft-0001'
  );
  if projected ->> 'ok' <> 'true' then
    raise exception 'ACR-02 failed: projection refused: %', projected::text;
  end if;

  draft_matches := public.learning_search_chunks('zarquonium', null::uuid, 6);
  if jsonb_array_length(draft_matches -> 'matches') <> 0 then
    raise exception
      'ACR-02 failed: a draft lesson was retrievable: %', draft_matches::text;
  end if;
  live_matches := public.learning_search_chunks('quokkanomics', null::uuid, 6);
  if jsonb_array_length(live_matches -> 'matches') < 1 then
    raise exception
      'ACR-02 failed: projecting alongside a draft removed published content';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  published jsonb;
  matches jsonb;
begin
  published := public.learning_publish_course(
    current_setting('learningbot.test.course_a')::uuid,
    'acr-publish-a-0002'
  );
  if (published ->> 'publishedLessons')::integer <> 1 then
    raise exception 'ACR-02 failed: republish reported %', published::text;
  end if;

  matches := public.learning_search_chunks('zarquonium', null::uuid, 6);
  if jsonb_array_length(matches -> 'matches') < 1 then
    raise exception
      'ACR-02 failed: publishing a draft lesson did not make it retrievable';
  end if;
end $$;
reset role;

select set_config(
  'learningbot.test.version',
  (
    select c.record_version::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_a')::uuid
  ),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  archived jsonb;
  projected jsonb;
  matches jsonb;
begin
  archived := public.learning_update_lesson(
    current_setting('learningbot.test.lesson_two')::uuid,
    null,
    'archived',
    current_setting('learningbot.test.version')::bigint,
    'acr-lesson-archive-0001'
  );
  projected := public.learning_project_course_knowledge(
    current_setting('learningbot.test.course_a')::uuid,
    'acr-project-archived-0001'
  );
  if archived ->> 'ok' <> 'true'
    or projected -> 'knowledge' ->> 'changed' <> 'true'
  then
    raise exception
      'ACR-02 failed: archive or re-projection refused: %', projected::text;
  end if;

  matches := public.learning_search_chunks('zarquonium', null::uuid, 6);
  if jsonb_array_length(matches -> 'matches') <> 0 then
    raise exception
      'ACR-02 failed: archived content stayed retrievable: %', matches::text;
  end if;
  matches := public.learning_search_chunks('quokkanomics', null::uuid, 6);
  if jsonb_array_length(matches -> 'matches') < 1 then
    raise exception
      'ACR-02 failed: archiving one lesson removed an unrelated lesson';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- ACR-03: republishing replaces, never duplicates, and never re-buys an
-- embedding for text that has not changed.
-- ---------------------------------------------------------------------------

-- Stand in for a completed embedding pass over everything currently live.
update public.learning_chunks ch
set embedding = (
      '[' || array_to_string(
        array_fill(0.0512345::double precision, array[384]), ','
      ) || ']'
    )::extensions.vector(384),
    embedding_provider_key = 'openai',
    embedding_model_key = 'text-embedding-3-small',
    embedding_dimensions = 384
where ch.tenant_id = current_setting('learningbot.test.tenant_a')::uuid
  and ch.deleted_at is null
  and ch.embedding is null;

select set_config(
  'learningbot.test.version_count',
  (
    select count(*)::text
    from public.knowledge_versions kv
    where kv.course_id = current_setting('learningbot.test.course_a')::uuid
  ),
  true
);
select set_config(
  'learningbot.test.version',
  (
    select c.record_version::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_a')::uuid
  ),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  unchanged jsonb;
  added_lesson jsonb;
  published jsonb;
begin
  -- Nothing changed since the last projection: doing any work here would be
  -- paying for the same vectors twice.
  unchanged := public.learning_project_course_knowledge(
    current_setting('learningbot.test.course_a')::uuid,
    'acr-project-unchanged-0001'
  );
  if unchanged -> 'knowledge' ->> 'changed' <> 'false'
    or unchanged -> 'knowledge' ->> 'retrievable' <> 'true'
  then
    raise exception
      'ACR-03 failed: an unchanged republish did work: %', unchanged::text;
  end if;

  added_lesson := public.learning_create_lesson(
    current_setting('learningbot.test.module_one')::uuid,
    'Lesson Three',
    'The flimberwock review is a weekly pass over every commitment that slipped.',
    current_setting('learningbot.test.version')::bigint,
    'acr-lesson-create-0002'
  );
  published := public.learning_publish_course(
    current_setting('learningbot.test.course_a')::uuid,
    'acr-publish-a-0003'
  );
  if added_lesson ->> 'ok' <> 'true'
    or published -> 'knowledge' ->> 'changed' <> 'true'
    or (published -> 'knowledge' ->> 'reusedEmbeddingCount')::integer < 1
    or (published -> 'knowledge' ->> 'pendingEmbeddingCount')::integer < 1
  then
    raise exception
      'ACR-03 failed: republish did not reuse paid-for embeddings: %',
      published::text;
  end if;
end $$;
reset role;

do $$
declare
  version_count integer;
  live_authored_versions integer;
  active_chunks integer;
  live_chunks integer;
  duplicate_bodies integer;
  reused_embeddings integer;
  new_pending integer;
begin
  select count(*)::integer
  into version_count
  from public.knowledge_versions kv
  where kv.course_id = current_setting('learningbot.test.course_a')::uuid;
  if version_count
    <> current_setting('learningbot.test.version_count')::integer + 1
  then
    raise exception
      'ACR-03 failed: expected exactly one new knowledge version, saw % total',
      version_count;
  end if;

  select count(*)::integer
  into live_authored_versions
  from public.knowledge_versions kv
  where kv.course_id = current_setting('learningbot.test.course_a')::uuid
    and kv.status <> 'retired'
    and kv.source_manifest @> '[{"kind": "authored_content_blocks"}]'::jsonb;
  if live_authored_versions <> 1 then
    raise exception
      'ACR-03 failed: % authored knowledge versions are still live',
      live_authored_versions;
  end if;

  select
    count(*) filter (
      where ch.knowledge_version_id = c.active_knowledge_version_id
    )::integer,
    count(*)::integer
  into active_chunks, live_chunks
  from public.learning_chunks ch
  join public.courses c
    on c.tenant_id = ch.tenant_id
   and c.course_id = ch.course_id
  where ch.course_id = current_setting('learningbot.test.course_a')::uuid
    and ch.deleted_at is null;
  if active_chunks = 0 or active_chunks <> live_chunks then
    raise exception
      'ACR-03 failed: republishing duplicated chunks (% live, % active)',
      live_chunks, active_chunks;
  end if;

  select count(*)::integer
  into duplicate_bodies
  from (
    select ch.content_hash
    from public.learning_chunks ch
    where ch.course_id = current_setting('learningbot.test.course_a')::uuid
      and ch.deleted_at is null
    group by ch.content_hash
    having count(*) > 1
  ) repeated;
  if duplicate_bodies <> 0 then
    raise exception
      'ACR-03 failed: % chunk bodies are stored more than once',
      duplicate_bodies;
  end if;

  select
    count(*) filter (where ch.embedding is not null)::integer,
    count(*) filter (where ch.embedding is null)::integer
  into reused_embeddings, new_pending
  from public.learning_chunks ch
  join public.courses c
    on c.tenant_id = ch.tenant_id
   and c.course_id = ch.course_id
   and c.active_knowledge_version_id = ch.knowledge_version_id
  where ch.course_id = current_setting('learningbot.test.course_a')::uuid
    and ch.deleted_at is null;
  if reused_embeddings < 1 or new_pending < 1 then
    raise exception
      'ACR-03 failed: expected carried-over and pending chunks, saw % and %',
      reused_embeddings, new_pending;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ACR-04: a projection that fails takes the publish down with it. The course
-- must never be left pointing at a half-built knowledge version, and must never
-- report "published" while answering nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  highest integer;
begin
  select coalesce(max(kv.version_number), 0)
  into highest
  from public.knowledge_versions kv
  where kv.tenant_id = current_setting('learningbot.test.tenant_a')::uuid
    and kv.course_id = current_setting('learningbot.test.course_a')::uuid;

  -- Occupies the idempotency key the next projection will mint, so the
  -- projection's own insert is what fails, exactly as a constraint breach in
  -- production would.
  insert into public.knowledge_versions (
    tenant_id, course_id, version_number, status, source_manifest,
    content_hash, idempotency_key
  ) values (
    current_setting('learningbot.test.tenant_a')::uuid,
    current_setting('learningbot.test.course_a')::uuid,
    highest + 5,
    'failed',
    '[]'::jsonb,
    'acr-injected-projection-failure',
    'authored-knowledge:' || current_setting('learningbot.test.course_a') ||
      ':' || (highest + 6)::text
  );
end $$;

select set_config(
  'learningbot.test.active_before',
  (
    select c.active_knowledge_version_id::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_a')::uuid
  ),
  true
);
select set_config(
  'learningbot.test.version',
  (
    select c.record_version::text
    from public.courses c
    where c.course_id = current_setting('learningbot.test.course_a')::uuid
  ),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  added_lesson jsonb;
  matches jsonb;
begin
  added_lesson := public.learning_create_lesson(
    current_setting('learningbot.test.module_one')::uuid,
    'Lesson Four',
    'The grimwaldian checklist is read aloud before any launch is declared done.',
    current_setting('learningbot.test.version')::bigint,
    'acr-lesson-create-0003'
  );
  perform set_config(
    'learningbot.test.lesson_four', added_lesson ->> 'lessonId', true
  );

  begin
    perform public.learning_publish_course(
      current_setting('learningbot.test.course_a')::uuid,
      'acr-publish-a-0004'
    );
    raise exception 'ACR-04 failed: a broken projection still published';
  exception
    when unique_violation then null;
  end;

  -- The assistant kept answering from the version that was already good.
  matches := public.learning_search_chunks('quokkanomics', null::uuid, 6);
  if jsonb_array_length(matches -> 'matches') < 1 then
    raise exception
      'ACR-04 failed: a failed projection took retrieval down with it';
  end if;
  matches := public.learning_search_chunks('grimwaldian', null::uuid, 6);
  if jsonb_array_length(matches -> 'matches') <> 0 then
    raise exception
      'ACR-04 failed: a rolled-back projection left chunks behind';
  end if;
end $$;
reset role;

do $$
declare
  active_after text;
  lesson_status text;
  half_built integer;
begin
  select c.active_knowledge_version_id::text
  into active_after
  from public.courses c
  where c.course_id = current_setting('learningbot.test.course_a')::uuid;
  if active_after
    is distinct from current_setting('learningbot.test.active_before')
  then
    raise exception
      'ACR-04 failed: the active knowledge version moved to % during a failure',
      active_after;
  end if;

  select l.status
  into lesson_status
  from public.lessons l
  where l.lesson_id = current_setting('learningbot.test.lesson_four')::uuid;
  if lesson_status <> 'draft' then
    raise exception
      'ACR-04 failed: a failed publish still promoted a draft lesson to %',
      lesson_status;
  end if;

  select count(*)::integer
  into half_built
  from public.knowledge_versions kv
  where kv.tenant_id = current_setting('learningbot.test.tenant_a')::uuid
    and kv.course_id = current_setting('learningbot.test.course_a')::uuid
    and kv.status = 'building';
  if half_built <> 0 then
    raise exception
      'ACR-04 failed: % half-built knowledge versions survived', half_built;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ACR-05: chunks are tenant-bound in both directions, and the projection state
-- surface never reports another tenant's courses.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac220000-0000-4000-8000-000000000002',
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
  own_matches jsonb;
  foreign_matches jsonb;
  state jsonb;
begin
  created := public.learning_create_course_draft(
    'Authored Retrieval Course B',
    'A second tenant course used to prove chunk isolation.',
    'Module One',
    'Lesson One',
    'The bandersnatch protocol governs how a partner escalates a stalled renewal conversation.',
    'acr-create-course-b-0001'
  );
  perform set_config('learningbot.test.course_b', created ->> 'courseId', true);
  published := public.learning_publish_course(
    (created ->> 'courseId')::uuid,
    'acr-publish-b-0001'
  );
  if (published -> 'knowledge' ->> 'chunkCount')::integer < 1 then
    raise exception 'ACR-05 failed: tenant B published nothing retrievable';
  end if;

  own_matches := public.learning_search_chunks('bandersnatch', null::uuid, 6);
  foreign_matches := public.learning_search_chunks(
    'quokkanomics', null::uuid, 6
  );
  if jsonb_array_length(own_matches -> 'matches') < 1
    or jsonb_array_length(foreign_matches -> 'matches') <> 0
  then
    raise exception
      'ACR-05 failed: tenant B retrieved across the tenant boundary: %',
      foreign_matches::text;
  end if;

  state := public.learning_course_knowledge_state();
  if jsonb_array_length(state -> 'courses') <> 1
    or state -> 'courses' -> 0 ->> 'courseId'
      <> current_setting('learningbot.test.course_b')
  then
    raise exception
      'ACR-05 failed: knowledge state leaked another tenant: %', state::text;
  end if;
end $$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ac110000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  own_matches jsonb;
  foreign_matches jsonb;
begin
  own_matches := public.learning_search_chunks('quokkanomics', null::uuid, 6);
  foreign_matches := public.learning_search_chunks(
    'bandersnatch', null::uuid, 6
  );
  if jsonb_array_length(own_matches -> 'matches') < 1
    or jsonb_array_length(foreign_matches -> 'matches') <> 0
  then
    raise exception
      'ACR-05 failed: tenant A retrieved across the tenant boundary: %',
      foreign_matches::text;
  end if;
end $$;
reset role;

do $$
declare
  crossed integer;
begin
  select count(*)::integer
  into crossed
  from public.learning_chunks ch
  join public.courses c on c.course_id = ch.course_id
  where c.tenant_id is distinct from ch.tenant_id;
  if crossed <> 0 then
    raise exception 'ACR-05 failed: % chunks cross a tenant boundary', crossed;
  end if;
end $$;

-- The new entrypoints keep the execution boundary they were given. The worker
-- contracts are reachable without a session on purpose — the operation secret,
-- not the role, is the authority — but a signed-in browser must never be able
-- to reach the embedding queue at all.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.learning_publish_course(uuid,text)',
    'public.learning_project_course_knowledge(uuid,text,boolean)',
    'public.learning_course_knowledge_state(uuid)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'ACR-05 failed: invalid privilege for %', signature;
    end if;
  end loop;

  foreach signature in array array[
    'public.learning_claim_embedding_work(text,integer)',
    'public.learning_commit_embedding_work(text,jsonb,text,text)',
    'public.learning_release_embedding_work(text,jsonb,boolean)'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or not has_function_privilege('anon', signature, 'EXECUTE')
    then
      raise exception 'ACR-05 failed: invalid worker privilege for %', signature;
    end if;
  end loop;
end $$;

-- Reachable is not authorised: without the operation secret the worker
-- contracts do nothing at all.
do $$
declare
  denied jsonb;
begin
  denied := public.learning_claim_embedding_work(repeat('0', 64), 8);
  if denied ->> 'ok' <> 'false' or denied ->> 'code' <> 'access_denied' then
    raise exception
      'ACR-05 failed: the embedding queue answered an unauthorised caller: %',
      denied::text;
  end if;
end $$;

rollback;
