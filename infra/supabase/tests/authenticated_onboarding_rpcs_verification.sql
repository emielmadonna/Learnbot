-- Run after migrations 0001..0012 on a disposable Supabase database.
-- Verifies ORPC-01 UID/tenant binding, ORPC-02 optimistic/idempotent mutation,
-- ORPC-03 invitation privacy and exact-email acceptance, ORPC-04 policy gates,
-- and ORPC-05 function privilege boundaries. All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'b1100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'rpc-owner-a@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2200000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'rpc-owner-b@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b3300000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'rpc-client@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b4400000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'rpc-attacker@example.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
  );

-- Bootstrap two isolated owner tenants through the verified 0011 bridge.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'rpc-owner-a',
  'RPC Owner A',
  'rpc-bootstrap-a',
  'trace-rpc-bootstrap-a'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'rpc-owner-b',
  'RPC Owner B',
  'rpc-bootstrap-b',
  'trace-rpc-bootstrap-b'
);
reset role;

-- ORPC-01: snapshot reads derive the selected tenant and expose no raw
-- invitation email or other tenant.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  snapshot jsonb;
begin
  snapshot := public.onboarding_get_snapshot();
  if snapshot ->> 'ok' <> 'true'
    or snapshot -> 'tenant' ->> 'slug' <> 'rpc-owner-a'
    or snapshot ->> 'dataMode' <> 'durable'
    or jsonb_array_length(snapshot -> 'steps') <> 14
  then
    raise exception 'ORPC-01 failed: selected snapshot is invalid';
  end if;
  if snapshot::text like '%rpc-owner-b%' then
    raise exception 'ORPC-01 failed: snapshot exposed another tenant';
  end if;
end $$;
reset role;

-- ORPC-02: profile and non-policy step mutations compare workspace versions,
-- replay exactly, and reject idempotency reuse with a different fingerprint.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  first_result jsonb;
  replay_result jsonb;
  conflict_result jsonb;
  step_result jsonb;
begin
  first_result := public.onboarding_update_tenant_profile(
    'RPC Owner A Academy',
    'rpc-owner-a-academy',
    'enterprise',
    'Aster',
    '#123456',
    '#ABCDEF',
    'professional',
    1,
    'rpc-profile-a-1',
    'request-rpc-profile-a-1',
    'trace-rpc-profile-a-1'
  );
  replay_result := public.onboarding_update_tenant_profile(
    'RPC Owner A Academy',
    'rpc-owner-a-academy',
    'enterprise',
    'Aster',
    '#123456',
    '#ABCDEF',
    'professional',
    1,
    'rpc-profile-a-1',
    'request-rpc-profile-a-replay',
    'trace-rpc-profile-a-replay'
  );
  if first_result ->> 'ok' <> 'true'
    or first_result -> 'identity' ->> 'expectedMode' <> 'self_reported'
    or first_result -> 'onboarding' ->> 'version' <> '2'
    or replay_result is distinct from first_result
  then
    raise exception 'ORPC-02 failed: profile update did not replay exactly';
  end if;

  conflict_result := public.onboarding_update_tenant_profile(
    'Different Request',
    'rpc-owner-a-different',
    'starter',
    'Different',
    '#654321',
    '#FEDCBA',
    'not_circle',
    1,
    'rpc-profile-a-1',
    'request-rpc-profile-a-conflict',
    'trace-rpc-profile-a-conflict'
  );
  if conflict_result ->> 'code' <> 'idempotency_conflict' then
    raise exception 'ORPC-02 failed: idempotency conflict was not denied';
  end if;

  step_result := public.onboarding_update_step(
    'source_ingestion',
    'complete',
    'job:rpc-source-ingestion-a',
    2,
    'rpc-step-a-1',
    'request-rpc-step-a-1',
    'trace-rpc-step-a-1'
  );
  if step_result ->> 'ok' <> 'true'
    or step_result -> 'onboarding' ->> 'version' <> '3'
  then
    raise exception 'ORPC-02 failed: non-policy step update failed';
  end if;
end $$;
reset role;

-- Create one invitation per owner. The result must contain only a masked hint.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
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
  result := public.onboarding_create_invitation(
    'RPC-CLIENT@EXAMPLE.TEST',
    'creator',
    24,
    'rpc-invite-a-1',
    'request-rpc-invite-a-1',
    'trace-rpc-invite-a-1'
  );
  if result ->> 'ok' <> 'true'
    or result -> 'invitationResult' ->> 'emailHint'
      <> 'r***@example.test'
    or result::text like '%rpc-client@example.test%'
  then
    raise exception 'ORPC-03 failed: invitation result leaked raw email';
  end if;
end $$;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b2200000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select public.onboarding_create_invitation(
  'other-client@example.test',
  'teacher',
  24,
  'rpc-invite-b-1',
  'request-rpc-invite-b-1',
  'trace-rpc-invite-b-1'
);
reset role;

-- ORPC-03: a guessed cross-tenant revoke fails, a wrong verified email fails,
-- and only the exact confirmed email creates the membership and selection.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  begin
    perform count(*) from public.identity_invitations;
    raise exception 'ORPC-03 failed: authenticated read raw invitations';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Resolve fixture invitation IDs only as the migration owner for the negative
-- RPC calls below; application callers never receive the raw email.
do $$
declare
  invite_a text;
  invite_b text;
begin
  select i.invitation_id into invite_a
  from public.identity_invitations i
  join public.tenants t on t.tenant_id = i.tenant_id
  where t.slug = 'rpc-owner-a-academy';
  select i.invitation_id into invite_b
  from public.identity_invitations i
  join public.tenants t on t.tenant_id = i.tenant_id
  where t.slug = 'rpc-owner-b';
  perform set_config('learningbot.test.invite_a', invite_a, true);
  perform set_config('learningbot.test.invite_b', invite_b, true);
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
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
  result := public.onboarding_revoke_invitation(
    current_setting('learningbot.test.invite_b'),
    'rpc-cross-tenant-revoke',
    'request-rpc-cross-tenant-revoke',
    'trace-rpc-cross-tenant-revoke'
  );
  if result ->> 'code' <> 'invitation_invalid' then
    raise exception 'ORPC-03 failed: guessed cross-tenant revoke was not denied';
  end if;
end $$;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b4400000-0000-4000-8000-000000000004',
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
  result := public.onboarding_accept_invitation(
    current_setting('learningbot.test.invite_a'),
    'rpc-wrong-email-accept',
    'request-rpc-wrong-email-accept',
    'trace-rpc-wrong-email-accept'
  );
  if result ->> 'code' <> 'invitation_invalid' then
    raise exception 'ORPC-03 failed: wrong verified email accepted invite';
  end if;
end $$;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b3300000-0000-4000-8000-000000000003',
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
  result := public.onboarding_accept_invitation(
    current_setting('learningbot.test.invite_a'),
    'rpc-exact-email-accept',
    'request-rpc-exact-email-accept',
    'trace-rpc-exact-email-accept'
  );
  if result ->> 'ok' <> 'true'
    or result ->> 'accepted' <> 'true'
    or result ->> 'identityRole' <> 'creator'
    or result ->> 'claimsRefreshRequired' <> 'true'
  then
    raise exception 'ORPC-03 failed: exact verified email was not accepted';
  end if;
end $$;
reset role;

do $$
begin
  if not exists (
    select 1
    from public.identity_memberships m
    join app_private.supabase_auth_principal_links l
      on l.principal_id = m.principal_id
    where l.auth_user_id = 'b3300000-0000-4000-8000-000000000003'
      and m.role = 'creator'
      and m.status = 'active'
  ) or not exists (
    select 1
    from public.identity_audit_events a
    where a.action = 'onboarding.invitation.accept'
      and a.outcome = 'denied'
  ) or exists (
    select 1
    from public.identity_audit_events a
    where a.safe_metadata::text like '%rpc-client@example.test%'
  ) then
    raise exception 'ORPC-03 failed: membership/audit privacy evidence missing';
  end if;
end $$;

-- ORPC-04: generic step mutation cannot complete O-07 or O-13 and the deny is
-- durably audited without inventing a policy reference.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1100000-0000-4000-8000-000000000001',
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
  result := public.onboarding_update_step(
    'retention_policy',
    'complete',
    'must-not-apply',
    4,
    'rpc-policy-forbidden',
    'request-rpc-policy-forbidden',
    'trace-rpc-policy-forbidden'
  );
  if result ->> 'code' <> 'policy_decision_required' then
    raise exception 'ORPC-04 failed: generic RPC completed a policy step';
  end if;
end $$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.onboarding_workspaces w
    join public.tenants t on t.tenant_id = w.tenant_id
    where t.slug = 'rpc-owner-a-academy'
      and (
        w.recording_policy_ref is not null
        or w.retention_policy_ref is not null
      )
  ) or not exists (
    select 1
    from public.identity_audit_events a
    where a.action = 'onboarding.step.update'
      and a.outcome = 'denied'
      and a.safe_metadata ->> 'reason' = 'policy_decision_required'
  ) then
    raise exception 'ORPC-04 failed: policy denial evidence is invalid';
  end if;
end $$;

-- ORPC-05: only authenticated may execute public entrypoints; internal helpers
-- and every public RPC remain unavailable to PUBLIC, anon and service_role.
do $$
declare
  signature text;
begin
  if exists (
    select 1
    from information_schema.routine_privileges p
    where p.specific_schema = 'public'
      and p.routine_name in (
        'onboarding_get_snapshot',
        'onboarding_update_tenant_profile',
        'onboarding_update_step',
        'onboarding_create_invitation',
        'onboarding_revoke_invitation',
        'onboarding_accept_invitation'
      )
      and p.grantee = 'PUBLIC'
      and p.privilege_type = 'EXECUTE'
  ) then
    raise exception 'ORPC-05 failed: PUBLIC can execute onboarding RPC';
  end if;
  foreach signature in array array[
    'public.onboarding_get_snapshot()',
    'public.onboarding_update_tenant_profile(text,text,text,text,text,text,text,bigint,text,text,text)',
    'public.onboarding_update_step(text,text,text,bigint,text,text,text)',
    'public.onboarding_create_invitation(text,text,integer,text,text,text)',
    'public.onboarding_revoke_invitation(text,text,text,text)',
    'public.onboarding_accept_invitation(text,text,text,text)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'ORPC-05 failed: invalid privilege for %', signature;
    end if;
  end loop;
  if has_function_privilege(
    'authenticated',
    'app_private.onboarding_snapshot_for_tenant(uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'app_private.onboarding_rpc_context()',
    'EXECUTE'
  ) then
    raise exception 'ORPC-05 failed: private helper is executable';
  end if;
end $$;

rollback;
