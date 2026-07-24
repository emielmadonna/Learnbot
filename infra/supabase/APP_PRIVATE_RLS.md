# `app_private` RLS hardening

The migration `20260724212458_app_private_rls_hardening.sql` enables Row Level
Security on the five private tables previously flagged by Supabase:

- `supabase_auth_principal_links`
- `user_access_accounts`
- `tenant_owner_claims`
- `supabase_auth_tenant_selections`
- `learning_operation_secrets`

These tables are not a browser or Data API surface. Before the migration,
`anon` and `authenticated` had no table privileges, and the tables had no
policies. That remains the intended boundary: direct client access is denied
by grants, and RLS is enabled as defense in depth. No broad authenticated
policy was added.

The tables are owned by `postgres`. The application’s private lookups and
mutations run through owner-owned `SECURITY DEFINER` routines. `FORCE ROW
LEVEL SECURITY` is therefore intentionally not enabled; forcing it would
change the existing owner-backed execution contract without a policy model
for direct clients. `service_role` retains its existing server-only privileges
where already granted and continues to bypass RLS by design.

## Verification

Run the disposable-database security check after applying all migrations:

```sh
psql "$LOCAL_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file infra/supabase/tests/app_private_rls_verification.sql
```

The check asserts that all five tables have RLS enabled, `FORCE` remains off,
browser roles have no table privileges, no broad policies were added, and the
existing owner-backed auth routines remain `SECURITY DEFINER` functions owned
by `postgres`. A hosted verification should also confirm `relrowsecurity =
true` for each table and that the Supabase `rls_disabled` advisory no longer
lists these five relations.
