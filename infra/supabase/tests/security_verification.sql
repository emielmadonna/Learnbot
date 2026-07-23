-- Run only against an empty disposable local Supabase database after all
-- migrations. The transaction rolls back fixtures. Acceptance coverage:
-- SEC-01, SEC-02, SEC-03, SEC-07, ATT-02 and MCP-08.

begin;

-- Fixed non-secret fixtures.
insert into public.tenants (
  tenant_id, slug, display_name, status, idempotency_key
) values
  ('10000000-0000-4000-8000-000000000001', 'isolation-a', 'Isolation A', 'active', 'tenant-a'),
  ('20000000-0000-4000-8000-000000000002', 'isolation-b', 'Isolation B', 'active', 'tenant-b');

insert into public.courses (
  course_id, tenant_id, title, status, idempotency_key
) values
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Course A', 'published', 'course-a'),
  ('22000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Course B', 'published', 'course-b');

insert into public.conversations (
  conversation_id, tenant_id, subject_user_id, idempotency_key
) values
  ('13000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'conversation-a'),
  ('23000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'conversation-b');

insert into public.attachments (
  attachment_id, tenant_id, conversation_id, uploaded_by,
  original_filename, storage_key, media_type, size_bytes, content_hash,
  malware_status, extraction_status, idempotency_key
) values
  (
    '14000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    'a.txt',
    '10000000-0000-4000-8000-000000000001/conversations/aaaaaaaa-0000-4000-8000-000000000001/14000000-0000-4000-8000-000000000001/a.txt',
    'text/plain', 1, 'hash-a', 'clean', 'ready', 'attachment-a'
  ),
  (
    '24000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '23000000-0000-4000-8000-000000000002',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'b.txt',
    '20000000-0000-4000-8000-000000000002/conversations/bbbbbbbb-0000-4000-8000-000000000002/24000000-0000-4000-8000-000000000002/b.txt',
    'text/plain', 1, 'hash-b', 'clean', 'ready', 'attachment-b'
  );

insert into public.audit_ledger (
  audit_id, tenant_id, actor_type, action, resource_type, resource_id,
  policy_decision, trace_id, idempotency_key, retain_until
) values (
  '15000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'system', 'fixture.created', 'course',
  '11000000-0000-4000-8000-000000000001',
  'allow', 'trace-a', 'audit-a', now() + interval '1 year'
);

insert into public.mcp_grants (
  mcp_grant_id, tenant_id, actor_id, actor_role, server_key, tool_pattern,
  permissions, risk_ceiling, budget_minor, max_invocations, granted_by,
  reason, idempotency_key, expires_at, retain_until
) values (
  '16000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'cccccccc-0000-4000-8000-000000000003',
  'client_admin', 'management', 'courses.*', array['read'],
  'read', 100, 10, 'dddddddd-0000-4000-8000-000000000004',
  'Fixture grant for a different actor', 'grant-a',
  now() + interval '1 hour', now() + interval '1 year'
);

-- SEC-02: every tenant table has both RLS flags.
do $$
declare
  missing_count integer;
begin
  select count(*) into missing_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any(array[
      'tenants', 'roles', 'profiles', 'memberships', 'courses', 'modules', 'lessons',
      'content_blocks', 'learning_sources', 'ingestion_jobs',
      'ingestion_checkpoints', 'ingestion_issues', 'knowledge_versions',
      'learning_documents', 'learning_chunks', 'tenant_branding',
      'learning_context_mappings', 'student_progress', 'conversations',
      'messages', 'attachments', 'audit_ledger', 'cost_ledger',
      'mcp_grants', 'mcp_invocations'
    ])
    and (not c.relrowsecurity or not c.relforcerowsecurity);
  if missing_count <> 0 then
    raise exception 'SEC-02 failed: % tables lack enabled/forced RLS', missing_count;
  end if;
end $$;

-- SEC-03: forbidden raw secret columns are absent. Vault references are opaque.
do $$
declare
  forbidden_count integer;
begin
  select count(*) into forbidden_count
  from information_schema.columns
  where table_schema = 'public'
    and column_name = any(array[
      'api_key', 'secret', 'secret_value', 'access_token',
      'refresh_token', 'password', 'raw_input', 'raw_output'
    ]);
  if forbidden_count <> 0 then
    raise exception 'SEC-03 failed: found % forbidden secret/raw columns', forbidden_count;
  end if;
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"tenant_id":"10000000-0000-4000-8000-000000000001","sub":"aaaaaaaa-0000-4000-8000-000000000001","app_role":"student"}',
  true
);

-- SEC-01: tenant A cannot discover tenant B rows.
do $$
begin
  if (select count(*) from public.courses) <> 1 then
    raise exception 'SEC-01 failed: cross-tenant course became visible';
  end if;
  if exists (
    select 1 from public.courses
    where tenant_id = '20000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'SEC-01 failed: tenant B course became visible';
  end if;
end $$;

-- SEC-01: cross-tenant writes fail closed.
do $$
begin
  begin
    insert into public.courses (tenant_id, title, idempotency_key)
    values (
      '20000000-0000-4000-8000-000000000002',
      'Forbidden', 'cross-tenant-write'
    );
    raise exception 'SEC-01 failed: cross-tenant insert succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

-- ATT-02: attachment access is both tenant- and conversation-subject scoped.
do $$
begin
  if (select count(*) from public.attachments) <> 1 then
    raise exception 'ATT-02 failed: attachment scope count is not one';
  end if;
  if exists (
    select 1 from public.attachments
    where tenant_id = '20000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'ATT-02 failed: tenant B attachment became visible';
  end if;
end $$;

-- MCP-08: a student/agent without its own explicit grant sees none and cannot
-- create an invocation, even if another actor has a grant in the same tenant.
do $$
begin
  if exists (select 1 from public.mcp_grants) then
    raise exception 'MCP-08 failed: another actor grant became visible';
  end if;
  begin
    insert into public.mcp_invocations (
      tenant_id, actor_id, actor_role, server_key, tool_name, tool_version,
      risk, authorization_decision, decision_reason, normalized_input_hash,
      status, trace_id, idempotency_key, retain_until
    ) values (
      '10000000-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'student', 'management', 'courses.list', '1', 'read', 'allow',
      'should be denied', 'input-hash', 'authorized', 'trace-mcp',
      'forbidden-invocation', now() + interval '1 year'
    );
    raise exception 'MCP-08 failed: ungranted invocation insert succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;

-- SEC-07: even a privileged database actor cannot rewrite/delete audit facts.
do $$
begin
  begin
    update public.audit_ledger
    set action = 'rewritten'
    where audit_id = '15000000-0000-4000-8000-000000000001';
    raise exception 'SEC-07 failed: audit update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from public.audit_ledger
    where audit_id = '15000000-0000-4000-8000-000000000001';
    raise exception 'SEC-07 failed: audit delete succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
end $$;

-- ATT-02: storage policies must retain all tenant/owner path checks.
do $$
declare
  storage_policy_count integer;
begin
  select count(*) into storage_policy_count
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname in (
      'tenant_private_owner_select',
      'tenant_private_owner_insert',
      'tenant_private_owner_delete'
    )
    and coalesce(qual, with_check, '') like '%current_tenant_id%'
    and coalesce(qual, with_check, '') like '%foldername%';
  if storage_policy_count <> 3 then
    raise exception 'ATT-02 failed: expected 3 tenant-bound storage policies, found %',
      storage_policy_count;
  end if;
end $$;

rollback;
