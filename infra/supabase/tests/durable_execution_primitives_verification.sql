-- Run against an empty disposable local Supabase database after all migrations.
-- Verifies durable execution tenant boundaries and immutable facts.

begin;

insert into public.tenants (
  tenant_id, slug, display_name, status, idempotency_key
) values
  ('71000000-0000-4000-8000-000000000001', 'durable-a', 'Durable A', 'active', 'durable-tenant-a'),
  ('72000000-0000-4000-8000-000000000002', 'durable-b', 'Durable B', 'active', 'durable-tenant-b');

insert into public.courses (
  course_id, tenant_id, title, status, idempotency_key
) values
  ('71100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'Durable Course A', 'draft', 'durable-course-a'),
  ('72200000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', 'Durable Course B', 'draft', 'durable-course-b');

insert into public.course_revisions (
  revision_id, tenant_id, course_id, revision_number, revision_kind,
  command_id, content_hash, snapshot, idempotency_key
) values
  ('revision-a-1', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', 1, 'created', 'command-a', 'hash-a', '{"title":"A"}', 'revision-a-key'),
  ('revision-b-1', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', 1, 'created', 'command-b', 'hash-b', '{"title":"B"}', 'revision-b-key');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"tenant_id":"71000000-0000-4000-8000-000000000001","sub":"71a00000-0000-4000-8000-000000000001","app_role":"client_admin"}',
  true
);

do $$
begin
  if (select count(*) from public.course_revisions) <> 1 then
    raise exception 'DUR-01 failed: cross-tenant revision became visible';
  end if;
  begin
    insert into public.course_revisions (
      revision_id, tenant_id, course_id, revision_number, revision_kind,
      command_id, content_hash, snapshot, idempotency_key
    ) values (
      'forbidden-b-2',
      '72000000-0000-4000-8000-000000000002',
      '72200000-0000-4000-8000-000000000002',
      2, 'edited', 'forbidden', 'hash', '{}', 'forbidden-cross-tenant'
    );
    raise exception 'DUR-01 failed: cross-tenant revision insert succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;

reset role;

do $$
begin
  begin
    update public.course_revisions
    set snapshot = '{"title":"rewritten"}'
    where tenant_id = '71000000-0000-4000-8000-000000000001'
      and revision_id = 'revision-a-1';
    raise exception 'DUR-02 failed: revision update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from public.course_revisions
    where tenant_id = '71000000-0000-4000-8000-000000000001'
      and revision_id = 'revision-a-1';
    raise exception 'DUR-02 failed: revision delete succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
end $$;

insert into public.command_receipts (
  tenant_id, scope, idempotency_key, request_fingerprint, command_name
) values (
  '72000000-0000-4000-8000-000000000002',
  'course-authoring', 'receipt-b', 'fingerprint-b', 'course.commit'
);

insert into public.telemetry_outbox (
  outbox_id, tenant_id, idempotency_key, topic, payload,
  payload_fingerprint, available_at
) values (
  'outbox-b',
  '72000000-0000-4000-8000-000000000002',
  'outbox-key-b', 'provider.attempt', '{"attempt":"b"}',
  'payload-hash-b', now()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"tenant_id":"71000000-0000-4000-8000-000000000001","sub":"71b00000-0000-4000-8000-000000000002","app_role":"system_worker"}',
  true
);

insert into public.command_receipts (
  tenant_id, scope, idempotency_key, request_fingerprint,
  command_name, actor_id
) values (
  '71000000-0000-4000-8000-000000000001',
  'course-authoring', 'receipt-a', 'fingerprint-a',
  'course.commit', '71b00000-0000-4000-8000-000000000002'
);

insert into public.telemetry_outbox (
  outbox_id, tenant_id, idempotency_key, topic, payload,
  payload_fingerprint, available_at
) values (
  'outbox-a',
  '71000000-0000-4000-8000-000000000001',
  'outbox-key-a', 'provider.attempt', '{"attempt":1}',
  'payload-hash-a', now()
);

do $$
begin
  if (select count(*) from public.command_receipts) <> 1 then
    raise exception 'DUR-01 failed: cross-tenant command receipt became visible';
  end if;
  if (select count(*) from public.telemetry_outbox) <> 1 then
    raise exception 'DUR-01 failed: cross-tenant outbox item became visible';
  end if;
  begin
    update public.command_receipts
    set request_fingerprint = 'rewritten'
    where tenant_id = '71000000-0000-4000-8000-000000000001'
      and idempotency_key = 'receipt-a';
    raise exception 'DUR-03 failed: receipt fingerprint update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
  begin
    update public.telemetry_outbox
    set payload = '{"attempt":2}'
    where tenant_id = '71000000-0000-4000-8000-000000000001'
      and outbox_id = 'outbox-a';
    raise exception 'DUR-03 failed: outbox payload update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
end $$;

reset role;
rollback;
