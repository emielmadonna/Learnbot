-- Run against an empty disposable Supabase database after all migrations.
-- Verifies ONB-01 tenant isolation, ONB-02 state integrity and ONB-03
-- immutable, privacy-safe audit controls. All fixtures roll back.

begin;

insert into public.tenants (
  tenant_id, slug, display_name, status, settings, idempotency_key
) values
  (
    '91000000-0000-4000-8000-000000000001',
    'onboarding-a',
    'Onboarding A',
    'active',
    '{"planId":"test","locale":"en-US","timeZone":"UTC","featureFlags":{},"limits":{},"policyVersion":"test-only"}',
    'onboarding-tenant-a'
  ),
  (
    '92000000-0000-4000-8000-000000000002',
    'onboarding-b',
    'Onboarding B',
    'active',
    '{"planId":"test","locale":"en-US","timeZone":"UTC","featureFlags":{},"limits":{},"policyVersion":"test-only"}',
    'onboarding-tenant-b'
  );

insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject,
  idempotency_key
) values (
  'principal_onboarding_owner',
  'human',
  'oidc',
  'https://identity.example.test',
  'onboarding-owner',
  'onboarding-owner-principal'
);

insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values (
  'membership_onboarding_owner',
  '91000000-0000-4000-8000-000000000001',
  'principal_onboarding_owner',
  'tenant_owner',
  'active',
  'manual',
  'onboarding-owner-membership'
);

insert into public.onboarding_workspaces (
  onboarding_id, tenant_id, status, circle_plan, expected_identity_mode,
  owner_membership_id, idempotency_key
) values
  (
    '91100000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'in_progress',
    'professional',
    'self_reported',
    'membership_onboarding_owner',
    'onboarding-workspace-a'
  ),
  (
    '92200000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000002',
    'draft',
    'unconfirmed',
    'unconfirmed',
    null,
    'onboarding-workspace-b'
  );

insert into public.onboarding_steps (
  tenant_id, onboarding_id, step_key, status, required, idempotency_key
) values (
  '91000000-0000-4000-8000-000000000001',
  '91100000-0000-4000-8000-000000000001',
  'recording_policy',
  'blocked',
  true,
  'onboarding-recording-policy-a'
);

insert into public.identity_audit_events (
  tenant_id, actor_principal_id, action, outcome, resource_type, resource_id,
  request_id, trace_id, safe_metadata, idempotency_key
) values (
  '91000000-0000-4000-8000-000000000001',
  'principal_onboarding_owner',
  'onboarding.workspace.create',
  'allowed',
  'onboarding_workspace',
  '91100000-0000-4000-8000-000000000001',
  'request-onboarding-a',
  'trace-onboarding-a',
  '{"circlePlan":"professional"}',
  'onboarding-audit-a'
);

-- ONB-01: authenticated callers cannot read or mutate trusted onboarding
-- state, including with matching tenant/app-role claims.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"tenant_id":"91000000-0000-4000-8000-000000000001","sub":"aaaaaaaa-0000-4000-8000-000000000001","app_role":"owner"}',
  true
);
do $$
begin
  begin
    perform count(*) from public.onboarding_workspaces;
    raise exception 'ONB-01 failed: authenticated onboarding read succeeded';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.onboarding_steps
    set status = 'complete'
    where tenant_id = '91000000-0000-4000-8000-000000000001';
    raise exception 'ONB-01 failed: authenticated onboarding update succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ONB-02: composite tenant foreign keys reject cross-tenant attachment and
-- live status requires an explicit launch timestamp.
do $$
begin
  begin
    insert into public.onboarding_steps (
      tenant_id, onboarding_id, step_key, status, required, idempotency_key
    ) values (
      '92000000-0000-4000-8000-000000000002',
      '91100000-0000-4000-8000-000000000001',
      'tenant_profile',
      'not_started',
      true,
      'forbidden-cross-tenant-step'
    );
    raise exception 'ONB-02 failed: cross-tenant onboarding step succeeded';
  exception
    when foreign_key_violation then null;
  end;
  begin
    update public.onboarding_workspaces
    set status = 'live'
    where tenant_id = '91000000-0000-4000-8000-000000000001';
    raise exception 'ONB-02 failed: live status without timestamp succeeded';
  exception
    when check_violation then null;
  end;
end $$;

-- ONB-03: opaque-principal audit facts are append-only and policy references
-- remain unset until explicit owner decisions exist.
do $$
begin
  begin
    update public.identity_audit_events
    set outcome = 'denied'
    where tenant_id = '91000000-0000-4000-8000-000000000001';
    raise exception 'ONB-03 failed: identity audit update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
  if exists (
    select 1
    from public.onboarding_workspaces
    where tenant_id = '91000000-0000-4000-8000-000000000001'
      and (
        recording_policy_ref is not null
        or retention_policy_ref is not null
      )
  ) then
    raise exception 'ONB-03 failed: unresolved policy reference was invented';
  end if;
end $$;

rollback;
