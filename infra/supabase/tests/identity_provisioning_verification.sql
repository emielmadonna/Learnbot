-- Run against an empty disposable local Supabase database after all migrations.
-- Verifies IAM-01 tenant isolation, IAM-02 trusted bootstrap, and IAM-03
-- immutable provisioning receipts. All fixtures roll back.

begin;

insert into public.tenants (
  tenant_id, slug, display_name, status, settings, idempotency_key
) values
  (
    '81000000-0000-4000-8000-000000000001',
    'identity-a',
    'Identity A',
    'active',
    '{"planId":"test","locale":"en-US","timeZone":"UTC","featureFlags":{},"limits":{},"policyVersion":"test-only"}',
    'identity-tenant-a'
  ),
  (
    '82000000-0000-4000-8000-000000000002',
    'identity-b',
    'Identity B',
    'active',
    '{"planId":"test","locale":"en-US","timeZone":"UTC","featureFlags":{},"limits":{},"policyVersion":"test-only"}',
    'identity-tenant-b'
  );

insert into public.identity_principals (
  principal_id, principal_kind, authentication_method, issuer, subject,
  idempotency_key
) values
  (
    'principal_identity_a',
    'human',
    'oidc',
    'https://identity.example.test',
    'user-a',
    'identity-principal-a'
  ),
  (
    'principal_identity_b',
    'human',
    'oidc',
    'https://identity.example.test',
    'user-b',
    'identity-principal-b'
  );

insert into public.identity_memberships (
  membership_id, tenant_id, principal_id, role, status, provisioned_by,
  idempotency_key
) values
  (
    'membership_identity_a',
    '81000000-0000-4000-8000-000000000001',
    'principal_identity_a',
    'tenant_owner',
    'active',
    'manual',
    'identity-membership-a'
  ),
  (
    'membership_identity_b',
    '82000000-0000-4000-8000-000000000002',
    'principal_identity_b',
    'student',
    'active',
    'manual',
    'identity-membership-b'
  );

-- IAM-01: browser-authenticated callers cannot read or mutate trusted
-- identity facts directly, even with a tenant/app-role claim.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"tenant_id":"81000000-0000-4000-8000-000000000001","sub":"aaaaaaaa-0000-4000-8000-000000000001","app_role":"client_admin"}',
  true
);
do $$
begin
  begin
    perform count(*) from public.identity_memberships;
    raise exception 'IAM-01 failed: authenticated identity read succeeded';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform *
    from app_private.list_active_identity_memberships('principal_identity_a');
    raise exception 'IAM-01 failed: authenticated bootstrap execution succeeded';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

-- IAM-02: the server-only bootstrap resolves only the exact verified
-- principal. Tenant platform administration is deliberately not a membership.
do $$
begin
  if (
    select count(*)
    from app_private.list_active_identity_memberships('principal_identity_a')
  ) <> 1 then
    raise exception 'IAM-02 failed: exact principal bootstrap did not return one row';
  end if;
  if exists (
    select 1
    from app_private.list_active_identity_memberships('principal_identity_a')
    where tenant_id <> '81000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'IAM-02 failed: bootstrap returned another principal tenant';
  end if;
  begin
    insert into public.identity_memberships (
      membership_id, tenant_id, principal_id, role, status, provisioned_by,
      idempotency_key
    ) values (
      'forbidden-platform-admin',
      '81000000-0000-4000-8000-000000000001',
      'principal_identity_a',
      'platform_admin',
      'active',
      'manual',
      'forbidden-platform-admin'
    );
    raise exception 'IAM-02 failed: platform_admin became a tenant membership';
  exception
    when check_violation then null;
  end;
end $$;

insert into public.identity_invitations (
  invitation_id, tenant_id, email_normalized, role, status, expires_at,
  idempotency_key
) values (
  'invitation_identity_a',
  '81000000-0000-4000-8000-000000000001',
  'learner@example.test',
  'student',
  'pending',
  now() + interval '1 hour',
  'identity-invitation-a'
);

-- Accepted invitations require exact acceptance facts in the same tenant.
update public.identity_invitations
set status = 'accepted',
    accepted_by_principal_id = 'principal_identity_a',
    accepted_at = now()
where tenant_id = '81000000-0000-4000-8000-000000000001'
  and invitation_id = 'invitation_identity_a';

insert into public.identity_invitation_acceptances (
  tenant_id, invitation_id, principal_id, membership_id, idempotency_key
) values (
  '81000000-0000-4000-8000-000000000001',
  'invitation_identity_a',
  'principal_identity_a',
  'membership_identity_a',
  'identity-acceptance-a'
);

-- IAM-03: accepted/SCIM receipt facts are append-only.
do $$
begin
  begin
    update public.identity_invitation_acceptances
    set principal_id = 'principal_identity_b'
    where tenant_id = '81000000-0000-4000-8000-000000000001'
      and invitation_id = 'invitation_identity_a';
    raise exception 'IAM-03 failed: invitation receipt update succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
  begin
    insert into public.identity_invitations (
      invitation_id, tenant_id, email_normalized, role, status, expires_at,
      idempotency_key
    ) values (
      'forbidden-service-invite',
      '81000000-0000-4000-8000-000000000001',
      'service@example.test',
      'service',
      'pending',
      now() + interval '1 hour',
      'forbidden-service-invite'
    );
    raise exception 'IAM-03 failed: service principal invitation succeeded';
  exception
    when check_violation then null;
  end;
end $$;

rollback;
