-- Run after migrations 0001..20260726090000. Verifies that only an authorized
-- platform administrator can create a client workspace, that a duplicate slug
-- is refused, that the minted owner claim is single-use and expiring, that the
-- new workspace is isolated from every existing tenant, that an idempotency key
-- replays instead of provisioning twice, and that the creation is audited with
-- the token never stored in plaintext. All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'pcp-platform-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'pcp-existing-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'pcp-new-client-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1000000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'pcp-token-finder@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  );

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'pcp-platform-home',
  'PCP Platform Owner Home',
  'pcp-bootstrap-platform',
  'trace-pcp-bootstrap-platform'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'pcp-existing-client',
  'PCP Existing Client',
  'pcp-bootstrap-existing',
  'trace-pcp-bootstrap-existing'
);
select public.learning_create_course_draft(
  'Existing Client Course',
  'A durable course that must stay invisible to any newly provisioned client.',
  'Existing Client Module',
  'Existing Client Lesson',
  'This lesson body is tenant-private content and stays inside the existing client.',
  'pcp-existing-course-0001'
);

reset role;

select set_config(
  'learningbot.test.pcp_existing',
  (
    select tenant_id::text
    from public.tenants
    where slug = 'pcp-existing-client'
  ),
  true
);

insert into app_private.platform_administrators (
  auth_user_id, reason
) values (
  'e1000000-0000-4000-8000-000000000001',
  'platform client provisioning verification fixture'
);

-- PCP-01: a tenant owner who is not a platform administrator cannot create a
-- client workspace, list outstanding claims or revoke one, and no tenant, claim
-- or audit row is fabricated on their behalf.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  created jsonb;
  listed jsonb;
  revoked jsonb;
begin
  created := public.platform_admin_create_tenant(
    'pcp-client-one',
    'Smuggled Client',
    'Aria',
    '#2E5AAC',
    '#D08A00',
    'pcp-idem-forbidden'
  );
  listed := public.platform_admin_list_client_claims();
  revoked := public.platform_admin_revoke_client_claim(
    '00000000-0000-4000-8000-0000000000ff'
  );
  if created ->> 'code' <> 'access_denied'
    or listed ->> 'code' <> 'access_denied'
    or revoked ->> 'code' <> 'access_denied'
  then
    raise exception 'PCP-01 failed: client provisioning is not access denied';
  end if;
end $$;
reset role;

do $$
begin
  if exists (select 1 from public.tenants where slug = 'pcp-client-one') then
    raise exception 'PCP-01 failed: a denied caller created a tenant';
  end if;
  if exists (
    select 1 from app_private.platform_client_provisionings
  ) then
    raise exception 'PCP-01 failed: a denied caller wrote a provisioning receipt';
  end if;
  if exists (
    select 1 from public.audit_ledger where action like 'platform.client.%'
  ) then
    raise exception 'PCP-01 failed: a denied caller wrote an audit row';
  end if;
end $$;

-- PCP-02: the platform administrator creates a fully seeded, active workspace
-- and a second attempt on the same slug is refused with slug_conflict.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select set_config(
  'learningbot.test.pcp_one',
  public.platform_admin_create_tenant(
    'pcp-client-one',
    'PCP Client One',
    'Aria',
    '#2E5AAC',
    '#D08A00',
    'pcp-idem-one',
    'eu-west-1',
    'growth'
  )::text,
  true
);
select set_config(
  'learningbot.test.pcp_two',
  public.platform_admin_create_tenant(
    'pcp-client-two',
    'PCP Client Two',
    'Nova',
    '#1F6F5C',
    '#C86A2E',
    'pcp-idem-two'
  )::text,
  true
);
do $$
declare
  created jsonb := current_setting('learningbot.test.pcp_one')::jsonb;
  conflict jsonb;
  malformed jsonb;
begin
  if created ->> 'ok' <> 'true'
    or (created ->> 'created')::boolean is not true
    or created ->> 'slug' <> 'pcp-client-one'
    or created ->> 'status' <> 'active'
    or created ->> 'plan' <> 'growth'
    or created ->> 'region' <> 'eu-west-1'
    or created -> 'claim' ->> 'status' <> 'pending'
    or length(coalesce(created -> 'claim' ->> 'token', '')) < 32
  then
    raise exception 'PCP-02 failed: the client workspace was not created';
  end if;

  conflict := public.platform_admin_create_tenant(
    'pcp-client-one',
    'Duplicate Client One',
    'Aria',
    '#2E5AAC',
    '#D08A00',
    'pcp-idem-duplicate'
  );
  malformed := public.platform_admin_create_tenant(
    'Not A Slug',
    'Malformed Client',
    'Aria',
    'blue',
    '#D08A00',
    'pcp-idem-malformed'
  );
  if conflict ->> 'code' <> 'slug_conflict'
    or malformed ->> 'code' <> 'invalid_request'
  then
    raise exception 'PCP-02 failed: a duplicate or malformed request was accepted';
  end if;
end $$;
reset role;

select set_config(
  'learningbot.test.pcp_one_tenant',
  (current_setting('learningbot.test.pcp_one')::jsonb ->> 'tenantId'),
  true
);
select set_config(
  'learningbot.test.pcp_one_token',
  (current_setting('learningbot.test.pcp_one')::jsonb -> 'claim' ->> 'token'),
  true
);
select set_config(
  'learningbot.test.pcp_two_tenant',
  (current_setting('learningbot.test.pcp_two')::jsonb ->> 'tenantId'),
  true
);
select set_config(
  'learningbot.test.pcp_two_token',
  (current_setting('learningbot.test.pcp_two')::jsonb -> 'claim' ->> 'token'),
  true
);

do $$
declare
  new_tenant uuid := current_setting('learningbot.test.pcp_one_tenant')::uuid;
begin
  if (
    select count(*)
    from public.tenant_branding
    where tenant_id = new_tenant
      and status = 'published'
      and assistant_name = 'Aria'
      and agent_course_scope = '"all"'::jsonb
      and persona_instructions is not null
  ) <> 1
    or (select count(*) from public.roles where tenant_id = new_tenant) <> 5
    or (
      select count(*) from public.tenant_sections where tenant_id = new_tenant
    ) <> 6
    or (
      select count(*)
      from public.onboarding_workspaces
      where tenant_id = new_tenant
    ) <> 1
    or (
      select count(*) from public.onboarding_steps where tenant_id = new_tenant
    ) <> 14
  then
    raise exception 'PCP-02 failed: the client workspace was not fully seeded';
  end if;
end $$;

-- PCP-03: the minted claim binds exactly one owner, cannot be replayed, and an
-- expired claim is refused. Expiry is forced on the second workspace's claim.
update app_private.tenant_owner_claims
set expires_at = clock_timestamp() - interval '1 minute'
where tenant_id = current_setting('learningbot.test.pcp_two_tenant')::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000003',
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
    'pcp-client-one',
    current_setting('learningbot.test.pcp_one_token'),
    'pcp-claim-one',
    'trace-pcp-claim-one'
  );
  if result.claimed is not true
    or result.tenant_id
      is distinct from current_setting('learningbot.test.pcp_one_tenant')::uuid
  then
    raise exception 'PCP-03 failed: a minted claim did not bind the owner';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000004',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  begin
    perform *
    from public.auth_claim_preprovisioned_tenant_owner(
      'pcp-client-one',
      current_setting('learningbot.test.pcp_one_token'),
      'pcp-claim-replay',
      'trace-pcp-claim-replay'
    );
    raise exception 'PCP-03 failed: a spent claim token was accepted twice';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform *
    from public.auth_claim_preprovisioned_tenant_owner(
      'pcp-client-two',
      current_setting('learningbot.test.pcp_two_token'),
      'pcp-claim-expired',
      'trace-pcp-claim-expired'
    );
    raise exception 'PCP-03 failed: an expired claim token was accepted';
  exception
    when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  if (
    select status
    from app_private.tenant_owner_claims
    where tenant_id = current_setting('learningbot.test.pcp_one_tenant')::uuid
  ) <> 'claimed' then
    raise exception 'PCP-03 failed: the redeemed claim is still redeemable';
  end if;
  if not exists (
    select 1
    from public.identity_memberships m
    where m.tenant_id = current_setting('learningbot.test.pcp_one_tenant')::uuid
      and m.role = 'tenant_owner'
      and m.status = 'active'
      and m.deleted_at is null
  ) then
    raise exception 'PCP-03 failed: the claim did not create an owner';
  end if;
end $$;

-- PCP-04: the provisioned workspace is a real tenant boundary. Its new owner
-- sees only their own tenant, and no existing client can see the new one.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  visible_tenants integer;
  foreign_courses integer;
  workspace jsonb;
  sections jsonb;
begin
  select count(*) into visible_tenants from public.tenants;
  select count(*)
  into foreign_courses
  from public.courses
  where tenant_id = current_setting('learningbot.test.pcp_existing')::uuid;
  workspace := public.learning_get_workspace();
  sections := public.tenant_get_sections();
  if visible_tenants <> 1
    or foreign_courses <> 0
    or workspace -> 'tenant' ->> 'slug' <> 'pcp-client-one'
    or workspace::text like '%tenant-private content%'
    or jsonb_array_length(sections -> 'sections') <> 6
  then
    raise exception 'PCP-04 failed: the new workspace is not isolated';
  end if;
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  visible integer;
begin
  select count(*)
  into visible
  from public.tenants
  where slug in ('pcp-client-one', 'pcp-client-two');
  if visible <> 0 then
    raise exception 'PCP-04 failed: an existing client can see a new workspace';
  end if;
end $$;
reset role;

-- PCP-05: replaying the idempotency key returns the original workspace without
-- provisioning a second one and without re-issuing a token.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  replayed jsonb;
begin
  replayed := public.platform_admin_create_tenant(
    'pcp-client-one',
    'PCP Client One Renamed',
    'Aria',
    '#2E5AAC',
    '#D08A00',
    'pcp-idem-one',
    'eu-west-1',
    'growth'
  );
  if replayed ->> 'ok' <> 'true'
    or (replayed ->> 'created')::boolean is not false
    or replayed ->> 'tenantId'
      <> current_setting('learningbot.test.pcp_one_tenant')
    or replayed -> 'claim' ->> 'token' is not null
  then
    raise exception 'PCP-05 failed: the idempotency key did not replay';
  end if;
end $$;
reset role;

do $$
begin
  if (
    select count(*) from public.tenants where slug like 'pcp-client-%'
  ) <> 2 then
    raise exception 'PCP-05 failed: a replay provisioned a second workspace';
  end if;
  if (
    select count(*)
    from app_private.tenant_owner_claims
    where tenant_id = current_setting('learningbot.test.pcp_one_tenant')::uuid
  ) <> 1 then
    raise exception 'PCP-05 failed: a replay minted a second claim';
  end if;
  if (
    select display_name
    from public.tenants
    where tenant_id = current_setting('learningbot.test.pcp_one_tenant')::uuid
  ) <> 'PCP Client One' then
    raise exception 'PCP-05 failed: a replay mutated the original workspace';
  end if;
end $$;

-- PCP-06: creation is audited in the client's own ledger, the token is only
-- ever stored as the digest migration 0019 verifies, the listing never carries
-- a token, revocation is terminal, and the surface is authenticated-only.
do $$
begin
  if not exists (
    select 1
    from public.audit_ledger
    where action = 'platform.client.create'
      and tenant_id = current_setting('learningbot.test.pcp_one_tenant')::uuid
      and actor_id = 'e1000000-0000-4000-8000-000000000001'
      and actor_role = 'platform_admin'
      and policy_decision = 'allow'
  ) then
    raise exception 'PCP-06 failed: client creation left no audit row';
  end if;
  if exists (
    select 1
    from app_private.tenant_owner_claims
    where token_sha256 in (
      current_setting('learningbot.test.pcp_one_token'),
      current_setting('learningbot.test.pcp_two_token')
    )
  ) then
    raise exception 'PCP-06 failed: a claim token was stored in plaintext';
  end if;
  if not exists (
    select 1
    from app_private.tenant_owner_claims
    where tenant_id = current_setting('learningbot.test.pcp_one_tenant')::uuid
      and token_sha256 = encode(
        extensions.digest(
          current_setting('learningbot.test.pcp_one_token'),
          'sha256'
        ),
        'hex'
      )
  ) then
    raise exception 'PCP-06 failed: the stored digest does not match 0019';
  end if;
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'e1000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  listing jsonb;
  target_claim uuid;
  revoked jsonb;
  again jsonb;
begin
  listing := public.platform_admin_list_client_claims();
  if listing ->> 'ok' <> 'true'
    or jsonb_array_length(listing -> 'claims') < 2
    or listing::text like
      '%' || current_setting('learningbot.test.pcp_one_token') || '%'
    or listing::text like
      '%' || current_setting('learningbot.test.pcp_two_token') || '%'
  then
    raise exception 'PCP-06 failed: the claim listing is invalid or leaks a token';
  end if;

  select (entry ->> 'claimId')::uuid
  into target_claim
  from jsonb_array_elements(listing -> 'claims') entry
  where entry ->> 'tenantId'
    = current_setting('learningbot.test.pcp_two_tenant')
    and entry ->> 'status' = 'expired';
  if target_claim is null then
    raise exception 'PCP-06 failed: an expired claim is not reported as expired';
  end if;

  revoked := public.platform_admin_revoke_client_claim(target_claim);
  again := public.platform_admin_revoke_client_claim(target_claim);
  if revoked ->> 'ok' <> 'true'
    or revoked ->> 'status' <> 'revoked'
    or again ->> 'code' <> 'claim_not_pending'
  then
    raise exception 'PCP-06 failed: revocation is not terminal';
  end if;
end $$;
reset role;

do $$
declare
  signature text;
begin
  if not exists (
    select 1
    from public.audit_ledger
    where action = 'platform.client.claim.revoke'
      and tenant_id = current_setting('learningbot.test.pcp_two_tenant')::uuid
      and actor_id = 'e1000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'PCP-06 failed: revocation left no audit row';
  end if;

  foreach signature in array array[
    'public.platform_admin_create_tenant(text,text,text,text,text,text,text,text)',
    'public.platform_admin_list_client_claims()',
    'public.platform_admin_revoke_client_claim(uuid)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'PCP-06 failed: invalid privilege for %', signature;
    end if;
  end loop;

  if has_function_privilege(
      'authenticated',
      'app_private.platform_mint_owner_claim(uuid,interval)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'app_private.platform_mint_owner_claim(uuid,interval)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'app_private.platform_mint_owner_claim(uuid,interval)',
      'EXECUTE'
    )
  then
    raise exception 'PCP-06 failed: the claim minter is executable';
  end if;

  if has_table_privilege(
      'authenticated',
      'app_private.platform_client_provisionings',
      'SELECT'
    )
    or has_table_privilege(
      'anon',
      'app_private.platform_client_provisionings',
      'SELECT'
    )
  then
    raise exception 'PCP-06 failed: provisioning receipts are readable';
  end if;

  if not (
    select relrowsecurity and relforcerowsecurity
    from pg_class
    where oid = 'app_private.platform_client_provisionings'::regclass
  ) then
    raise exception 'PCP-06 failed: provisioning receipts do not force RLS';
  end if;
end $$;

rollback;
