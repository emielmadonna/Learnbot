-- Run after migrations 0001..0020. Verifies tenant-bound, published-only,
-- active-version lexical retrieval and the authenticated execution boundary.
-- All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'retrieval-owner-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'retrieval-owner-b@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
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
select * from public.auth_bootstrap_tenant_owner(
  'retrieval-owner-a',
  'Retrieval Owner A',
  'retrieval-bootstrap-a',
  'trace-retrieval-bootstrap-a'
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
  'retrieval-owner-b',
  'Retrieval Owner B',
  'retrieval-bootstrap-b',
  'trace-retrieval-bootstrap-b'
);
reset role;

select set_config(
  'learningbot.test.retrieval_tenant_a',
  tenant_id::text,
  true
)
from public.tenants
where slug = 'retrieval-owner-a';
select set_config(
  'learningbot.test.retrieval_tenant_b',
  tenant_id::text,
  true
)
from public.tenants
where slug = 'retrieval-owner-b';

insert into public.courses (
  course_id, tenant_id, title, status, idempotency_key, published_at
) values
  (
    'e1110000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'Published A', 'published', 'retrieval-course-a-published', now()
  ),
  (
    'e1120000-0000-4000-8000-000000000002',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'Draft A', 'draft', 'retrieval-course-a-draft', null
  ),
  (
    'e2210000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_b')::uuid,
    'Published B', 'published', 'retrieval-course-b-published', now()
  );

insert into public.learning_sources (
  source_id, tenant_id, course_id, source_type, name, status, external_ref,
  idempotency_key
) values
  (
    'e1130000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    'api', 'Published source A', 'ready', 'retrieval-source-a-published',
    'retrieval-source-a-published'
  ),
  (
    'e1140000-0000-4000-8000-000000000002',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1120000-0000-4000-8000-000000000002',
    'api', 'Draft source A', 'ready', 'retrieval-source-a-draft',
    'retrieval-source-a-draft'
  ),
  (
    'e2230000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_b')::uuid,
    'e2210000-0000-4000-8000-000000000001',
    'api', 'Published source B', 'ready', 'retrieval-source-b-published',
    'retrieval-source-b-published'
  );

insert into public.knowledge_versions (
  knowledge_version_id, tenant_id, course_id, version_number, status,
  content_hash, idempotency_key, published_at
) values
  (
    'e1150000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    1, 'published', 'retrieval-active-a',
    'retrieval-version-a-active', now()
  ),
  (
    'e1150000-0000-4000-8000-000000000002',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    2, 'published', 'retrieval-stale-a',
    'retrieval-version-a-stale', now()
  ),
  (
    'e1160000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1120000-0000-4000-8000-000000000002',
    1, 'published', 'retrieval-draft-a',
    'retrieval-version-a-draft', now()
  ),
  (
    'e2250000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_b')::uuid,
    'e2210000-0000-4000-8000-000000000001',
    1, 'published', 'retrieval-active-b',
    'retrieval-version-b-active', now()
  );

update public.courses
set active_knowledge_version_id = case course_id
  when 'e1110000-0000-4000-8000-000000000001'::uuid
    then 'e1150000-0000-4000-8000-000000000001'::uuid
  when 'e1120000-0000-4000-8000-000000000002'::uuid
    then 'e1160000-0000-4000-8000-000000000001'::uuid
  when 'e2210000-0000-4000-8000-000000000001'::uuid
    then 'e2250000-0000-4000-8000-000000000001'::uuid
end
where course_id in (
  'e1110000-0000-4000-8000-000000000001',
  'e1120000-0000-4000-8000-000000000002',
  'e2210000-0000-4000-8000-000000000001'
);

insert into public.learning_documents (
  document_id, tenant_id, course_id, source_id, knowledge_version_id,
  external_id, title, content_hash, status, idempotency_key
) values
  (
    'e1170000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    'e1130000-0000-4000-8000-000000000001',
    'e1150000-0000-4000-8000-000000000001',
    'active-a', 'Active document A', 'retrieval-document-active-a',
    'ready', 'retrieval-document-active-a'
  ),
  (
    'e1170000-0000-4000-8000-000000000002',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    'e1130000-0000-4000-8000-000000000001',
    'e1150000-0000-4000-8000-000000000002',
    'stale-a', 'Stale document A', 'retrieval-document-stale-a',
    'ready', 'retrieval-document-stale-a'
  ),
  (
    'e1180000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1120000-0000-4000-8000-000000000002',
    'e1140000-0000-4000-8000-000000000002',
    'e1160000-0000-4000-8000-000000000001',
    'draft-a', 'Draft document A', 'retrieval-document-draft-a',
    'ready', 'retrieval-document-draft-a'
  ),
  (
    'e2270000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_b')::uuid,
    'e2210000-0000-4000-8000-000000000001',
    'e2230000-0000-4000-8000-000000000001',
    'e2250000-0000-4000-8000-000000000001',
    'active-b', 'Active document B', 'retrieval-document-active-b',
    'ready', 'retrieval-document-active-b'
  );

insert into public.learning_chunks (
  chunk_id, tenant_id, course_id, knowledge_version_id, document_id,
  ordinal, body, content_hash, metadata, idempotency_key
) values
  (
    'e1190000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    'e1150000-0000-4000-8000-000000000001',
    'e1170000-0000-4000-8000-000000000001',
    0, 'Moonlight coaching gives a learner a grounded next action.',
    'retrieval-chunk-active-a',
    '{"courseSlug":"published-a","sectionName":"First section","lessonId":"a-1","lessonName":"Grounded lesson","startHms":"00:01:02"}',
    'retrieval-chunk-active-a'
  ),
  (
    'e1190000-0000-4000-8000-000000000002',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1110000-0000-4000-8000-000000000001',
    'e1150000-0000-4000-8000-000000000002',
    'e1170000-0000-4000-8000-000000000002',
    0, 'Moonlight stale material must never be retrieved.',
    'retrieval-chunk-stale-a', '{}',
    'retrieval-chunk-stale-a'
  ),
  (
    'e1290000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_a')::uuid,
    'e1120000-0000-4000-8000-000000000002',
    'e1160000-0000-4000-8000-000000000001',
    'e1180000-0000-4000-8000-000000000001',
    0, 'Moonlight draft material must never be retrieved.',
    'retrieval-chunk-draft-a', '{}',
    'retrieval-chunk-draft-a'
  ),
  (
    'e2290000-0000-4000-8000-000000000001',
    current_setting('learningbot.test.retrieval_tenant_b')::uuid,
    'e2210000-0000-4000-8000-000000000001',
    'e2250000-0000-4000-8000-000000000001',
    'e2270000-0000-4000-8000-000000000001',
    0, 'Moonlight tenant B material must remain isolated.',
    'retrieval-chunk-active-b', '{}',
    'retrieval-chunk-active-b'
  );

-- GSR-01: tenant A sees only its active, published course/version source.
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
  result jsonb;
begin
  result := public.learning_search_chunks('moonlight', null, 6);
  if result ->> 'ok' <> 'true'
    or result ->> 'dataMode' <> 'durable'
    or jsonb_array_length(result -> 'matches') <> 1
    or result -> 'matches' -> 0 ->> 'chunkId'
      <> 'e1190000-0000-4000-8000-000000000001'
    or result -> 'matches' -> 0 ->> 'courseTitle' <> 'Published A'
    or result -> 'matches' -> 0 -> 'source' ->> 'lessonName'
      <> 'Grounded lesson'
    or result -> 'matches' -> 0 ->> 'contentHash'
      <> 'retrieval-chunk-active-a'
  then
    raise exception 'GSR-01 failed: published retrieval boundary is invalid';
  end if;
end $$;

-- GSR-02: course filters cannot disclose another course, and inputs remain bounded.
do $$
declare
  filtered jsonb;
  bounded jsonb;
  invalid jsonb;
  negative_only jsonb;
begin
  filtered := public.learning_search_chunks(
    'moonlight',
    'e2210000-0000-4000-8000-000000000001',
    6
  );
  bounded := public.learning_search_chunks('moonlight', null, 999);
  invalid := public.learning_search_chunks(repeat('x', 513), null, 6);
  negative_only := public.learning_search_chunks('-moonlight', null, 6);
  if jsonb_array_length(filtered -> 'matches') <> 0
    or bounded ->> 'matchLimit' <> '12'
    or invalid ->> 'ok' <> 'false'
    or invalid ->> 'code' <> 'invalid_search_query'
    or negative_only ->> 'code' <> 'invalid_search_query'
  then
    raise exception 'GSR-02 failed: filtering or input bounds are invalid';
  end if;
end $$;

-- GSR-03: changing the durable tenant selection returns only tenant B.
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
  result jsonb;
begin
  result := public.learning_search_chunks('moonlight', null, 6);
  if jsonb_array_length(result -> 'matches') <> 1
    or result -> 'matches' -> 0 ->> 'chunkId'
      <> 'e2290000-0000-4000-8000-000000000001'
  then
    raise exception 'GSR-03 failed: cross-tenant retrieval was exposed';
  end if;
end $$;
reset role;

-- GSR-04: only an end-user authenticated connection can execute retrieval.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.learning_search_chunks(text,uuid,integer)',
    'EXECUTE'
  )
    or has_function_privilege(
      'service_role',
      'public.learning_search_chunks(text,uuid,integer)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'public.learning_search_chunks(text,uuid,integer)',
      'EXECUTE'
    )
  then
    raise exception 'GSR-04 failed: invalid retrieval privilege boundary';
  end if;
end $$;

rollback;
