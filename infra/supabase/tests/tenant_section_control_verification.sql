-- Run after migrations 0001..20260725123000. Verifies per-tenant section
-- control, the audited platform-administrator client-workspace entry, account
-- suspension enforcement and the bounded per-client detail read.
-- All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'd0000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'section-platform-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd0000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'section-client-a-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd0000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'section-client-b-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  );

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'section-platform-home',
  'Platform Owner Home',
  'section-bootstrap-platform',
  'trace-section-bootstrap-platform'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'section-client-a',
  'Section Client A',
  'section-bootstrap-a',
  'trace-section-bootstrap-a'
);
select public.learning_create_course_draft(
  'Client A Private Course',
  'A durable course that must never be visible to another tenant context.',
  'Client A Module',
  'Client A Lesson',
  'This lesson body is tenant-private content and stays inside tenant A.',
  'section-client-a-course-0001'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'section-client-b',
  'Section Client B',
  'section-bootstrap-b',
  'trace-section-bootstrap-b'
);

reset role;

select set_config(
  'learningbot.test.tenant_a',
  (select tenant_id::text from public.tenants where slug = 'section-client-a'),
  true
);
select set_config(
  'learningbot.test.tenant_b',
  (select tenant_id::text from public.tenants where slug = 'section-client-b'),
  true
);
select set_config(
  'learningbot.test.tenant_home',
  (
    select tenant_id::text
    from public.tenants
    where slug = 'section-platform-home'
  ),
  true
);

insert into app_private.platform_administrators (
  auth_user_id, reason
) values (
  'd0000000-0000-4000-8000-000000000001',
  'tenant section control verification fixture'
);

-- TSC-01: a tenant owner who is not a platform administrator cannot set
-- sections, enter another tenant, change tenant status or read client detail,
-- and no audit row is fabricated on their behalf.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  section_result jsonb;
  enter_result jsonb;
  status_result jsonb;
  detail_result jsonb;
  exit_result jsonb;
begin
  section_result := public.platform_admin_set_tenant_section(
    current_setting('learningbot.test.tenant_b')::uuid, 'agent', false
  );
  enter_result := public.platform_admin_enter_tenant(
    current_setting('learningbot.test.tenant_b')::uuid
  );
  status_result := public.platform_admin_set_tenant_status(
    current_setting('learningbot.test.tenant_b')::uuid, 'suspended'
  );
  detail_result := public.platform_admin_tenant_detail(
    current_setting('learningbot.test.tenant_b')::uuid
  );
  exit_result := public.platform_admin_exit_tenant();
  if section_result ->> 'code' <> 'access_denied'
    or enter_result ->> 'code' <> 'access_denied'
    or status_result ->> 'code' <> 'access_denied'
    or detail_result ->> 'code' <> 'access_denied'
    or exit_result ->> 'code' <> 'access_denied'
  then
    raise exception 'TSC-01 failed: platform control is not access denied';
  end if;
end $$;
reset role;

do $$
begin
  if exists (
    select 1
    from public.audit_ledger
    where action like 'platform.%'
  ) then
    raise exception 'TSC-01 failed: denied calls wrote an audit row';
  end if;
  if exists (
    select 1
    from app_private.platform_admin_tenant_sessions
  ) then
    raise exception 'TSC-01 failed: denied entry created a session';
  end if;
  if (
    select status
    from public.tenants
    where tenant_id = current_setting('learningbot.test.tenant_b')::uuid
  ) not in ('provisioning', 'active') then
    raise exception 'TSC-01 failed: denied caller changed tenant status';
  end if;
end $$;

-- TSC-02: the platform administrator disables a section and the owning tenant
-- reads that section back as disabled, with every other section untouched.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  toggled jsonb;
  invalid jsonb;
begin
  toggled := public.platform_admin_set_tenant_section(
    current_setting('learningbot.test.tenant_a')::uuid, 'insights', false
  );
  invalid := public.platform_admin_set_tenant_section(
    current_setting('learningbot.test.tenant_a')::uuid, 'not_a_section', false
  );
  if toggled ->> 'ok' <> 'true'
    or toggled -> 'section' ->> 'sectionKey' <> 'insights'
    or (toggled -> 'section' ->> 'enabled')::boolean is distinct from false
    or invalid ->> 'code' <> 'invalid_request'
  then
    raise exception 'TSC-02 failed: section toggle result is invalid';
  end if;
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  sections jsonb;
  disabled_count integer;
  agent_enabled boolean;
begin
  sections := public.tenant_get_sections();
  if sections ->> 'ok' <> 'true'
    or sections ->> 'dataMode' <> 'durable'
    or jsonb_array_length(sections -> 'sections') <> 6
  then
    raise exception 'TSC-02 failed: tenant section read is not truthful';
  end if;
  select count(*)
  into disabled_count
  from jsonb_array_elements(sections -> 'sections') section
  where section ->> 'sectionKey' = 'insights'
    and (section ->> 'enabled')::boolean is false;
  select (section ->> 'enabled')::boolean
  into agent_enabled
  from jsonb_array_elements(sections -> 'sections') section
  where section ->> 'sectionKey' = 'agent';
  if disabled_count <> 1 or agent_enabled is distinct from true then
    raise exception 'TSC-02 failed: disabled section is not reported disabled';
  end if;
end $$;
reset role;

-- TSC-03: entering a client workspace switches context without granting any
-- cross-tenant read. Tenant A content stays invisible while inside tenant B.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  entered jsonb;
  visible_tenants integer;
  visible_foreign_courses integer;
  workspace jsonb;
begin
  entered := public.platform_admin_enter_tenant(
    current_setting('learningbot.test.tenant_b')::uuid
  );
  if entered ->> 'ok' <> 'true'
    or (entered ->> 'tenantId')::uuid
      is distinct from current_setting('learningbot.test.tenant_b')::uuid
    or entered ->> 'identityRole' <> 'tenant_admin'
  then
    raise exception 'TSC-03 failed: entry did not switch context';
  end if;

  if app_private.current_tenant_id()
    is distinct from current_setting('learningbot.test.tenant_b')::uuid
  then
    raise exception 'TSC-03 failed: durable tenant context is wrong';
  end if;

  select count(*) into visible_tenants from public.tenants;
  select count(*)
  into visible_foreign_courses
  from public.courses
  where tenant_id = current_setting('learningbot.test.tenant_a')::uuid;
  if visible_tenants <> 1 or visible_foreign_courses <> 0 then
    raise exception 'TSC-03 failed: entry granted a cross-tenant read';
  end if;

  workspace := public.learning_get_workspace();
  if workspace -> 'tenant' ->> 'slug' <> 'section-client-b'
    or jsonb_array_length(workspace -> 'courses') <> 0
  then
    raise exception 'TSC-03 failed: entered workspace leaked another tenant';
  end if;

  if public.platform_admin_exit_tenant() ->> 'exited' <> 'true' then
    raise exception 'TSC-03 failed: exit did not complete';
  end if;
  if app_private.current_tenant_id()
    is distinct from current_setting('learningbot.test.tenant_home')::uuid
  then
    raise exception 'TSC-03 failed: exit did not restore the previous tenant';
  end if;
end $$;
reset role;

-- TSC-04: every privileged platform action leaves an immutable audit row in
-- the target tenant's own ledger, naming the acting platform administrator.
do $$
declare
  section_audits integer;
  enter_audits integer;
  exit_audits integer;
begin
  select count(*)
  into section_audits
  from public.audit_ledger
  where action = 'platform.tenant.section.set'
    and tenant_id = current_setting('learningbot.test.tenant_a')::uuid
    and actor_id = 'd0000000-0000-4000-8000-000000000001'
    and actor_role = 'platform_admin'
    and policy_decision = 'allow';
  select count(*)
  into enter_audits
  from public.audit_ledger
  where action = 'platform.tenant.enter'
    and tenant_id = current_setting('learningbot.test.tenant_b')::uuid
    and actor_id = 'd0000000-0000-4000-8000-000000000001';
  select count(*)
  into exit_audits
  from public.audit_ledger
  where action = 'platform.tenant.exit'
    and tenant_id = current_setting('learningbot.test.tenant_b')::uuid
    and actor_id = 'd0000000-0000-4000-8000-000000000001';
  if section_audits < 1 or enter_audits < 1 or exit_audits < 1 then
    raise exception 'TSC-04 failed: a privileged action left no audit row';
  end if;
end $$;

-- TSC-05: suspending a client account actually blocks that client, and the
-- per-client detail read stays inside the platform data boundary.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  detail jsonb;
  suspended jsonb;
  blocked_entry jsonb;
begin
  detail := public.platform_admin_tenant_detail(
    current_setting('learningbot.test.tenant_a')::uuid
  );
  if detail ->> 'ok' <> 'true'
    or detail -> 'tenant' ->> 'slug' <> 'section-client-a'
    or (detail -> 'counts' ->> 'courses')::integer <> 1
    or (detail -> 'counts' ->> 'members')::integer < 1
    or jsonb_array_length(detail -> 'sections') <> 6
    or detail ->> 'lastActivityAt' is null
    or detail::text like '%tenant-private content%'
  then
    raise exception 'TSC-05 failed: client detail is invalid or leaks content';
  end if;

  suspended := public.platform_admin_set_tenant_status(
    current_setting('learningbot.test.tenant_a')::uuid, 'suspended'
  );
  if suspended ->> 'ok' <> 'true' or suspended ->> 'status' <> 'suspended' then
    raise exception 'TSC-05 failed: suspension did not apply';
  end if;

  blocked_entry := public.platform_admin_enter_tenant(
    current_setting('learningbot.test.tenant_a')::uuid
  );
  if blocked_entry ->> 'code' <> 'tenant_unavailable' then
    raise exception 'TSC-05 failed: a suspended tenant could still be entered';
  end if;
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  workspace jsonb;
  sections jsonb;
  visible_courses integer;
begin
  workspace := public.learning_get_workspace();
  sections := public.tenant_get_sections();
  select count(*) into visible_courses from public.courses;
  if workspace ->> 'code' <> 'tenant_selection_required'
    or sections ->> 'code' <> 'tenant_selection_required'
    or app_private.current_tenant_id() is not null
    or visible_courses <> 0
  then
    raise exception 'TSC-05 failed: a suspended tenant still has access';
  end if;
end $$;
reset role;

-- TSC-06: the platform control surface is not executable by anon or the
-- service role, and the private helpers are not executable at all.
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.tenant_get_sections()',
    'public.platform_admin_set_tenant_section(uuid,text,boolean)',
    'public.platform_admin_enter_tenant(uuid)',
    'public.platform_admin_exit_tenant()',
    'public.platform_admin_set_tenant_status(uuid,text)',
    'public.platform_admin_tenant_detail(uuid)'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
    then
      raise exception 'TSC-06 failed: invalid privilege for %', signature;
    end if;
  end loop;

  foreach signature in array array[
    'app_private.tenant_section_definitions()',
    'app_private.platform_admin_write_audit(uuid,text,text,text,text,text,text)'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
    then
      raise exception 'TSC-06 failed: private helper is executable: %', signature;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.tenant_sections', 'INSERT')
    or has_table_privilege('authenticated', 'public.tenant_sections', 'UPDATE')
    or has_table_privilege('authenticated', 'public.tenant_sections', 'DELETE')
    or not has_table_privilege('authenticated', 'public.tenant_sections', 'SELECT')
  then
    raise exception 'TSC-06 failed: tenant_sections table privileges are wrong';
  end if;

  if not (
    select relrowsecurity and relforcerowsecurity
    from pg_class
    where oid = 'public.tenant_sections'::regclass
  ) then
    raise exception 'TSC-06 failed: tenant_sections does not force RLS';
  end if;
end $$;

rollback;
