-- Run after migrations through 20260731011206 on a disposable database.
--
-- HAP-01 friendly slugs resolve only on the widget's exact allowed origin;
-- HAP-02 publish, unpublish and rename are durable and reserve old slugs;
-- HAP-03 public payloads/grants/RLS expose neither delivery keys nor rows;
-- HAP-04 lifecycle writes are optimistic and idempotent.

begin;

insert into app_private.learning_operation_secrets (
  capability, token_hash, expires_at
) values (
  'conversation.answer.record',
  encode(
    extensions.digest(
      'hosted-assistant-test-operation-token-0001',
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
    'e3300000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'hosted-owner-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e4400000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'hosted-owner-b@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
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
do $$
declare
  bootstrapped record;
begin
  select * into bootstrapped
  from public.auth_bootstrap_tenant_owner(
    'hosted-tenant-a', 'Hosted Tenant A',
    'hosted-bootstrap-a', 'trace-hosted-bootstrap-a'
  );
  perform set_config(
    'learningbot.test.hap_tenant_a', bootstrapped.tenant_id::text, true
  );
end $$;

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
declare
  bootstrapped record;
begin
  select * into bootstrapped
  from public.auth_bootstrap_tenant_owner(
    'hosted-tenant-b', 'Hosted Tenant B',
    'hosted-bootstrap-b', 'trace-hosted-bootstrap-b'
  );
  perform set_config(
    'learningbot.test.hap_tenant_b', bootstrapped.tenant_id::text, true
  );
end $$;

-- Both tenants have a published anonymous widget on the hosted Corso origin.
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
  head integer;
  written jsonb;
begin
  head := (public.tenant_get_widget_settings() ->> 'expectedVersion')::integer;
  written := public.tenant_update_widget_settings(
    true, 'panel', 'bottom-right', 'Ask the course',
    'Ask about the published course.',
    jsonb_build_array('https://corso.example.test'),
    true, false, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, head,
    'hosted-widget-a-0001', 'request-hosted-widget-a-0001',
    'trace-hosted-widget-a-0001'
  );
  if written ->> 'ok' <> 'true' then
    raise exception 'hosted widget A fixture failed: %', written::text;
  end if;
end $$;

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
declare
  head integer;
  written jsonb;
begin
  head := (public.tenant_get_widget_settings() ->> 'expectedVersion')::integer;
  written := public.tenant_update_widget_settings(
    true, 'panel', 'bottom-right', 'Ask the course',
    'Ask about the published course.',
    jsonb_build_array('https://corso.example.test'),
    true, false, '"all"'::jsonb, 'system', false, null, null,
    null, null, null, false, true, head,
    'hosted-widget-b-0001', 'request-hosted-widget-b-0001',
    'trace-hosted-widget-b-0001'
  );
  if written ->> 'ok' <> 'true' then
    raise exception 'hosted widget B fixture failed: %', written::text;
  end if;
end $$;

-- ------------------------------------------------------------------- HAP-04
-- Tenant A publishes once; exact replay returns the same durable result and a
-- changed request under the same idempotency key conflicts.
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
  first_write jsonb;
  replay jsonb;
  conflict jsonb;
begin
  first_write := public.tenant_update_hosted_assistant_publication(
    'publish', 'pricing-lab', 0,
    'hosted-publication-a-0001',
    'request-hosted-publication-a-0001',
    'trace-hosted-publication-a-0001'
  );
  replay := public.tenant_update_hosted_assistant_publication(
    'publish', 'pricing-lab', 0,
    'hosted-publication-a-0001',
    'request-hosted-publication-a-0001',
    'trace-hosted-publication-a-0001'
  );
  conflict := public.tenant_update_hosted_assistant_publication(
    'publish', 'different-lab', 0,
    'hosted-publication-a-0001',
    'request-hosted-publication-a-0002',
    'trace-hosted-publication-a-0002'
  );
  if first_write ->> 'ok' <> 'true'
    or first_write -> 'publication' ->> 'status' <> 'published'
    or replay <> first_write
    or conflict ->> 'code' <> 'idempotency_conflict'
  then
    raise exception 'HAP-04 failed: % / % / %',
      first_write::text, replay::text, conflict::text;
  end if;
end $$;
reset role;

-- ------------------------------------------------------------------- HAP-01
set local role anon;
do $$
declare
  public_bootstrap jsonb;
  server_bootstrap jsonb;
  refused jsonb;
  unknown jsonb;
  server_refused jsonb;
  server_unknown jsonb;
begin
  public_bootstrap := public.hosted_assistant_bootstrap(
    'pricing-lab', 'https://corso.example.test', null
  );
  server_bootstrap := public.hosted_assistant_bootstrap(
    'pricing-lab', 'https://corso.example.test',
    'hosted-assistant-test-operation-token-0001'
  );
  refused := public.hosted_assistant_bootstrap(
    'pricing-lab', 'https://evil.example.test', null
  );
  unknown := public.hosted_assistant_bootstrap(
    'unknown-lab', 'https://corso.example.test', null
  );
  server_refused := public.hosted_assistant_bootstrap(
    'pricing-lab', 'https://evil.example.test',
    'hosted-assistant-test-operation-token-0001'
  );
  server_unknown := public.hosted_assistant_bootstrap(
    'unknown-lab', 'https://corso.example.test',
    'hosted-assistant-test-operation-token-0001'
  );

  if public_bootstrap ->> 'ok' <> 'true'
    or public_bootstrap ? 'deliveryKey'
    or public_bootstrap::text ~
      '(tenantId|tenant_id|brandingId|courseId|personaInstructions)'
  then
    raise exception 'HAP-01/HAP-03 failed: public bootstrap leaked: %',
      public_bootstrap::text;
  end if;
  if server_bootstrap ->> 'deliveryKey' !~ '^wk_[0-9a-f]{40}$' then
    raise exception 'HAP-01 failed: server resolver lacked a delivery key';
  end if;
  if refused <> jsonb_build_object(
      'ok', false, 'code', 'widget_unavailable'
    )
    or unknown <> refused
  then
    raise exception 'HAP-01 failed: public refusals were distinguishable';
  end if;
  if server_refused ->> 'slugReserved' <> 'true'
    or server_unknown ->> 'slugReserved' <> 'false'
  then
    raise exception 'HAP-01 failed: server reservation gate is unsafe';
  end if;
end $$;
reset role;

-- ------------------------------------------------------------------- HAP-02
-- Unpublish hides the URL immediately. Rename keeps the publication state,
-- hides the old path and permanently reserves the old slug.
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
  snapshot jsonb;
  unpublished jsonb;
  republished jsonb;
  renamed jsonb;
  stale jsonb;
begin
  snapshot := public.tenant_get_hosted_assistant_publication();
  stale := public.tenant_update_hosted_assistant_publication(
    'unpublish', 'pricing-lab',
    (snapshot ->> 'expectedVersion')::bigint + 1,
    'hosted-unpublish-stale-0001',
    'request-hosted-unpublish-stale-0001',
    'trace-hosted-unpublish-stale-0001'
  );
  unpublished := public.tenant_update_hosted_assistant_publication(
    'unpublish', 'pricing-lab',
    (snapshot ->> 'expectedVersion')::bigint,
    'hosted-unpublish-a-0001',
    'request-hosted-unpublish-a-0001',
    'trace-hosted-unpublish-a-0001'
  );
  republished := public.tenant_update_hosted_assistant_publication(
    'publish', 'pricing-lab',
    (unpublished ->> 'expectedVersion')::bigint,
    'hosted-republish-a-0001',
    'request-hosted-republish-a-0001',
    'trace-hosted-republish-a-0001'
  );
  renamed := public.tenant_update_hosted_assistant_publication(
    'change_slug', 'rate-lab',
    (republished ->> 'expectedVersion')::bigint,
    'hosted-rename-a-0001',
    'request-hosted-rename-a-0001',
    'trace-hosted-rename-a-0001'
  );
  if stale ->> 'code' <> 'version_conflict'
    or unpublished -> 'publication' ->> 'status' <> 'unpublished'
    or republished -> 'publication' ->> 'status' <> 'published'
    or renamed -> 'publication' ->> 'slug' <> 'rate-lab'
    or renamed -> 'publication' ->> 'status' <> 'published'
  then
    raise exception 'HAP-02/HAP-04 failed: % / % / % / %',
      stale::text, unpublished::text, republished::text, renamed::text;
  end if;
end $$;
reset role;

set local role anon;
do $$
declare
  old_path jsonb;
  new_path jsonb;
begin
  old_path := public.hosted_assistant_bootstrap(
    'pricing-lab', 'https://corso.example.test', null
  );
  new_path := public.hosted_assistant_bootstrap(
    'rate-lab', 'https://corso.example.test', null
  );
  if old_path ->> 'code' <> 'widget_unavailable'
    or new_path ->> 'ok' <> 'true'
  then
    raise exception 'HAP-02 failed: rename did not move the public route';
  end if;
end $$;
reset role;

-- Tenant B cannot claim Tenant A's superseded slug.
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
declare
  claimed jsonb;
  visible_count integer;
begin
  claimed := public.tenant_update_hosted_assistant_publication(
    'publish', 'pricing-lab', 0,
    'hosted-publication-b-0001',
    'request-hosted-publication-b-0001',
    'trace-hosted-publication-b-0001'
  );
  if claimed ->> 'code' <> 'slug_unavailable' then
    raise exception 'HAP-02 failed: stale slug was reassigned: %',
      claimed::text;
  end if;

  select count(*) into visible_count
  from public.hosted_assistant_publications p
  where p.tenant_id
    = current_setting('learningbot.test.hap_tenant_a')::uuid;
  if visible_count <> 0 then
    raise exception 'HAP-03 failed: RLS exposed another tenant publication';
  end if;
end $$;
reset role;

-- ------------------------------------------------------------------- HAP-03
do $$
begin
  if not has_function_privilege(
      'anon',
      'public.hosted_assistant_bootstrap(text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.hosted_assistant_bootstrap(text,text,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'public.tenant_get_hosted_assistant_publication()',
      'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated',
      'public.tenant_update_hosted_assistant_publication(' ||
        'text,text,bigint,text,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'app_private.hosted_assistant_resolve(text,text)',
      'EXECUTE'
    )
    or has_table_privilege(
      'anon', 'public.hosted_assistant_publications', 'SELECT'
    )
    or has_table_privilege(
      'authenticated', 'public.hosted_assistant_publications', 'INSERT'
    )
    or has_table_privilege(
      'authenticated', 'public.hosted_assistant_publications', 'UPDATE'
    )
    or has_table_privilege(
      'authenticated', 'public.hosted_assistant_publications', 'DELETE'
    )
  then
    raise exception 'HAP-03 failed: hosted publication grants are unsafe';
  end if;
end $$;

rollback;
