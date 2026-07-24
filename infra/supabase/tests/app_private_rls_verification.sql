-- Run after all migrations on a disposable local Supabase database.
-- This suite verifies the app_private RLS hardening migration without
-- creating fixtures or changing persistent data.

begin;

-- SEC-APP-01: exactly the five flagged private tables have RLS enabled.
do $$
declare
  expected_tables constant text[] := array[
    'learning_operation_secrets',
    'supabase_auth_principal_links',
    'supabase_auth_tenant_selections',
    'tenant_owner_claims',
    'user_access_accounts'
  ];
  missing_or_unprotected integer;
begin
  select count(*)
  into missing_or_unprotected
  from unnest(expected_tables) as expected(table_name)
  left join (
    pg_class c
    join pg_namespace n
      on n.oid = c.relnamespace
     and n.nspname = 'app_private'
  )
    on c.relname = expected.table_name
  where c.oid is null
     or not c.relrowsecurity;

  if missing_or_unprotected <> 0 then
    raise exception
      'SEC-APP-01 failed: % app_private table(s) are missing or have RLS disabled',
      missing_or_unprotected;
  end if;
end $$;

-- SEC-APP-02: FORCE RLS remains off. The owner-backed security boundary is
-- intentional and avoids requiring client-facing policies on private tables.
do $$
declare
  forced_count integer;
begin
  select count(*)
  into forced_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_private'
    and c.relname = any(array[
      'supabase_auth_principal_links',
      'user_access_accounts',
      'tenant_owner_claims',
      'supabase_auth_tenant_selections',
      'learning_operation_secrets'
    ])
    and c.relforcerowsecurity;

  if forced_count <> 0 then
    raise exception 'SEC-APP-02 failed: FORCE RLS is enabled on % table(s)',
      forced_count;
  end if;
end $$;

-- SEC-APP-03: no direct browser role has table privileges or policies for
-- these private implementation tables. This keeps RLS deny-by-default and
-- prevents the test from blessing a broad authenticated policy by accident.
do $$
declare
  exposed_count integer;
  policy_count integer;
begin
  select count(*)
  into exposed_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_private'
    and c.relname = any(array[
      'supabase_auth_principal_links',
      'user_access_accounts',
      'tenant_owner_claims',
      'supabase_auth_tenant_selections',
      'learning_operation_secrets'
    ])
    and (
      has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE')
      or has_table_privilege('anon', c.oid, 'DELETE')
      or has_table_privilege('authenticated', c.oid, 'SELECT')
      or has_table_privilege('authenticated', c.oid, 'INSERT')
      or has_table_privilege('authenticated', c.oid, 'UPDATE')
      or has_table_privilege('authenticated', c.oid, 'DELETE')
    );

  if exposed_count <> 0 then
    raise exception
      'SEC-APP-03 failed: % private table(s) are directly granted to browser roles',
      exposed_count;
  end if;

  select count(*)
  into policy_count
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_private'
    and c.relname = any(array[
      'supabase_auth_principal_links',
      'user_access_accounts',
      'tenant_owner_claims',
      'supabase_auth_tenant_selections',
      'learning_operation_secrets'
    ]);

  if policy_count <> 0 then
    raise exception
      'SEC-APP-03 failed: private tables unexpectedly have % policy/policies',
      policy_count;
  end if;
end $$;

-- SEC-APP-04: privileged flows remain owner-backed SECURITY DEFINER routines.
do $$
declare
  incorrect_count integer;
begin
  select count(*)
  into incorrect_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any(array[
      'admin_provision_auth_user',
      'admin_register_claimed_owner_access',
      'auth_bootstrap_tenant_owner',
      'auth_claim_preprovisioned_tenant_owner',
      'auth_complete_password_change',
      'auth_list_tenant_memberships',
      'auth_select_tenant'
    ])
    and (
      not p.prosecdef
      or pg_get_userbyid(p.proowner) <> 'postgres'
    );

  if incorrect_count <> 0 then
    raise exception
      'SEC-APP-04 failed: % privileged auth routine(s) are not postgres-owned SECURITY DEFINER routines',
      incorrect_count;
  end if;
end $$;

rollback;
