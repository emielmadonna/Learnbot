-- Run against an empty disposable local Supabase database after all migrations.
-- Verifies UPL-01 trusted-server isolation, UPL-02 tenant/actor ownership
-- primitives and UPL-03 immutable callback and terminal facts.

begin;

insert into public.tenants (
  tenant_id, slug, display_name, status, idempotency_key
) values
  (
    '91000000-0000-4000-8000-000000000001',
    'uploads-a',
    'Uploads A',
    'active',
    'uploads-tenant-a'
  ),
  (
    '92000000-0000-4000-8000-000000000002',
    'uploads-b',
    'Uploads B',
    'active',
    'uploads-tenant-b'
  );

insert into public.upload_intents (
  intent_id, tenant_id, actor_id, filename, media_type,
  declared_size_bytes, object_key, expires_at, status, disposition,
  signed_upload, scan_results, idempotency_key
) values (
  'intent_upload_a',
  '91000000-0000-4000-8000-000000000001',
  'principal_upload_a',
  'course.pdf',
  'application/pdf',
  1024,
  'object_upload_a',
  now() + interval '5 minutes',
  'quarantined',
  'quarantine',
  '{"url":"https://storage.example.test/upload","method":"PUT","expiresAt":"2026-07-23T12:05:00.000Z","requiredHeaders":{"content-type":"application/pdf","content-length":"1024"}}',
  '[]',
  'intent_upload_a'
);

-- UPL-01: opaque-principal upload facts are a trusted-server boundary and
-- cannot be accessed directly by authenticated browser roles.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"tenant_id":"91000000-0000-4000-8000-000000000001","sub":"aaaaaaaa-0000-4000-8000-000000000001","app_role":"client_admin"}',
  true
);
do $$
begin
  begin
    perform count(*) from public.upload_intents;
    raise exception 'UPL-01 failed: authenticated upload intent read succeeded';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.upload_callback_receipts (
      tenant_id, intent_id, callback_id, fingerprint, idempotency_key
    ) values (
      '91000000-0000-4000-8000-000000000001',
      'intent_upload_a',
      'forbidden-browser-callback',
      'sha256:forbidden',
      'forbidden-browser-callback'
    );
    raise exception 'UPL-01 failed: authenticated callback insert succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

insert into public.upload_callback_receipts (
  tenant_id, intent_id, callback_id, fingerprint, idempotency_key
) values (
  '91000000-0000-4000-8000-000000000001',
  'intent_upload_a',
  'callback_upload_a',
  'sha256:callback-upload-a',
  'callback_upload_a'
);

-- UPL-02: callback rows cannot be attached to another tenant's intent.
do $$
begin
  begin
    insert into public.upload_callback_receipts (
      tenant_id, intent_id, callback_id, fingerprint, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000002',
      'intent_upload_a',
      'cross-tenant-callback',
      'sha256:cross-tenant',
      'cross-tenant-callback'
    );
    raise exception 'UPL-02 failed: cross-tenant callback insert succeeded';
  exception
    when foreign_key_violation then null;
  end;
end $$;

-- UPL-03: scanner callback receipts and terminal upload facts are immutable.
update public.upload_intents
set status = 'blocked',
    failure = '{"code":"MALWARE_DETECTED","message":"Malware detected.","retryable":false}',
    updated_at = clock_timestamp(),
    record_version = record_version + 1
where tenant_id = '91000000-0000-4000-8000-000000000001'
  and intent_id = 'intent_upload_a';

do $$
begin
  begin
    update public.upload_callback_receipts
    set fingerprint = 'sha256:rewritten'
    where tenant_id = '91000000-0000-4000-8000-000000000001'
      and intent_id = 'intent_upload_a'
      and callback_id = 'callback_upload_a';
    raise exception 'UPL-03 failed: callback receipt update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
  begin
    update public.upload_intents
    set status = 'quarantined',
        failure = null,
        updated_at = clock_timestamp(),
        record_version = record_version + 1
    where tenant_id = '91000000-0000-4000-8000-000000000001'
      and intent_id = 'intent_upload_a';
    raise exception 'UPL-03 failed: terminal upload state was reopened';
  exception
    when object_not_in_prerequisite_state then null;
  end;
end $$;

rollback;
