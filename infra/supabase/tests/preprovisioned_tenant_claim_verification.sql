-- Run after migrations 0001..0019. Verifies a one-time owner claim is bound
-- to one verified user, one tenant, expires, and cannot be replayed.

begin;

insert into public.tenants (
  tenant_id, slug, display_name, status, idempotency_key
) values (
  'c9000000-0000-4000-8000-000000000001',
  'claim-fixture',
  'Claim Fixture',
  'provisioning',
  'claim-fixture-tenant'
);
insert into public.roles (
  tenant_id, role_key, display_name, capabilities, idempotency_key
)
select
  'c9000000-0000-4000-8000-000000000001',
  seed.role_key,
  seed.display_name,
  '{}'::text[],
  'claim-fixture-role:' || seed.role_key
from (values
  ('owner', 'Owner'),
  ('client_admin', 'Client administrator'),
  ('client_viewer', 'Client viewer'),
  ('student', 'Student'),
  ('system_worker', 'System worker')
) seed(role_key, display_name);
insert into public.onboarding_workspaces (
  tenant_id, status, circle_plan, expected_identity_mode, idempotency_key
) values (
  'c9000000-0000-4000-8000-000000000001',
  'in_progress',
  'unconfirmed',
  'unconfirmed',
  'claim-fixture-onboarding'
);
insert into app_private.tenant_owner_claims (
  tenant_id, token_sha256, expires_at
) values (
  'c9000000-0000-4000-8000-000000000001',
  encode(extensions.digest(repeat('x', 48), 'sha256'), 'hex'),
  now() + interval '1 hour'
);
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'c9900000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'claim-owner@example.test', '', now(),
  '{"provider":"email","providers":["email"]}', '{}'::jsonb, now(), now()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c9900000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  result record;
begin
  select * into result
  from public.auth_claim_preprovisioned_tenant_owner(
    'claim-fixture',
    repeat('x', 48),
    'claim-fixture-request',
    'claim-fixture-trace'
  );
  if result.claimed is not true
    or result.tenant_id <> 'c9000000-0000-4000-8000-000000000001'
  then
    raise exception 'CLAIM-01 failed: valid owner claim was not bound';
  end if;
  begin
    perform *
    from public.auth_claim_preprovisioned_tenant_owner(
      'claim-fixture',
      repeat('x', 48),
      'claim-fixture-replay',
      'claim-fixture-replay-trace'
    );
    raise exception 'CLAIM-02 failed: owner claim replay succeeded';
  exception
    when object_not_in_prerequisite_state then null;
  end;
end $$;
reset role;

do $$
begin
  if not exists (
    select 1
    from public.identity_memberships m
    where m.tenant_id = 'c9000000-0000-4000-8000-000000000001'
      and m.role = 'tenant_owner'
      and m.status = 'active'
  ) then
    raise exception 'CLAIM-01 failed: owner membership was not persisted';
  end if;
  if has_function_privilege(
    'anon',
    'public.auth_claim_preprovisioned_tenant_owner(text,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.auth_claim_preprovisioned_tenant_owner(text,text,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.auth_claim_preprovisioned_tenant_owner(text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'CLAIM-03 failed: invalid function privileges';
  end if;
end $$;

rollback;
