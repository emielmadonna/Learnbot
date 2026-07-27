# Schema drift: live database ahead of this repository

Recorded 2026-07-25 against project `fwilehggxqkpeuojxqzk`.

## Summary

Nine migrations are applied to the live database that have **no corresponding
file in this repository**. They were applied directly on 2026-07-24 between
21:24 and 21:51 UTC and were never committed. `pnpm supabase:verify` validates
the repository, not the database, so it passes while the two differ.

A rebuild from `infra/supabase/migrations/` alone therefore produces a database
that is missing the objects below, and that reverts three functions to older
revisions.

## The nine unrecorded migrations

| Version | Name | Size |
|---|---|---|
| 20260724212458 | `app_private_rls_hardening` | 1,042 chars |
| 20260724212646 | `app_private_rls_hardening` (re-applied) | 401 |
| 20260724212859 | `managed_account_provisioning_diagnostics` | 8,182 |
| 20260724213033 | `managed_account_provisioning_fix` | 8,428 |
| 20260724213043 | `platform_admin_client_detail` | 10,928 |
| 20260724213250 | `tenant_provider_vault_boundary` | 7,927 |
| 20260724213536 | `managed_account_provisioning_final` | 10,261 |
| 20260724214825 | `platform_admin_provider_runtime_access` | 1,871 |
| 20260724215138 | `platform_admin_provider_runtime_access_guard` | 1,720 |

Total ≈ 50,760 characters.

## Objects that exist only in the live database

Created by the drift, absent from every committed migration:

- table `app_private.tenant_provider_credentials`
- `public.platform_admin_client_detail`
- `public.learning_provider_runtime_credential`
- `public.learning_provider_set_credential`
- `app_private.set_tenant_provider_credential`
- `app_private.tenant_provider_credential_for_runtime` (revised twice more by
  the last two migrations)

The provider-credential vault is an entire subsystem that source control does
not know about.

## Objects the repository has at an older revision

These exist in committed migrations, but the live database holds newer
definitions produced by the drift:

- `public.admin_provision_auth_user` — three successive revisions live
  (`diagnostics`, `fix`, `final`)
- `public.admin_list_access_accounts` — two successive revisions live

Re-running the committed migrations over the live database would downgrade
both.

## Interaction with the 2026-07-25 migrations

Checked before applying `20260725120000`–`20260725123000`:

- None of the four new migrations reference any of the eight drifted objects.
- None of the nine drifted migrations redefine `learning_get_workspace`, which
  is the only pre-existing function the new migrations `create or replace`.

There is no overlap, so applying the new migrations does not revert any
undocumented work.

Note that `platform_admin_client_detail` (live only) and
`platform_admin_tenant_detail` (new, `20260725123000`) overlap in purpose. They
are separate function names, so neither clobbers the other, but the duplication
should be resolved rather than left to drift further apart.

## Outstanding work

Recovering the nine SQL bodies into
`infra/supabase/migrations/` as ordered recovery files is not yet done. Until
it is, this repository cannot rebuild the live schema, and the provider
credential vault has no reviewable source. The bodies are readable from the
dashboard (Database → Migrations → View migration SQL) or from
`supabase_migrations.schema_migrations.statements`.
