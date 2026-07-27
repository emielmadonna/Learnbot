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

---

# 2026-07-27 — six migrations applied by hand (repo ledger not updated)

Applied by emielmadonna, by hand, through the Supabase dashboard **SQL editor**
— *not* the release runner (`pnpm supabase:release apply`), which was
unavailable because it requires the database password and an approval file.

## What was applied

Run individually, in this order, each as its own `begin; … commit;`
transaction, from the concatenated file
`infra/supabase/release/PENDING_MIGRATIONS.sql`:

| # | Migration | SHA-256 of the applied text | Bytes |
|---|---|---|---|
| 1 | `20260726097000_agent_control_surface.sql` | `7216fe0702687890d4aac2bd327cd5db953461708ff299b18eb0fc54fdee692d` | 43,640 |
| 2 | `20260726098000_learner_signal_readout.sql` | `a0e946ad31fe99efad02f821622ea00268da9e02743e983d344b2b3fabcc64ff` | 20,206 |
| 3 | `20260726099000_operational_debt.sql` | `f105d7cacb7aff1d8bb92cd80603ae4939685832183e5e21017053da28bda0ea` | 36,144 |
| 4 | `20260726100000_billing_stripe.sql` | `99c55b60cf8987fe5cbc3488fffade986e04e610a6fa9d20048405225e8dece9` | 60,124 |
| 5 | `20260726101000_character_avatars.sql` | `0dc9d546993e2b345616aa6d8e0bced38521519beb374a643133c1d180420034` | 25,794 |
| 6 | `20260727090000_knowledge_ingestion_pipeline.sql` | `c6b16911d03796dc18c1767f00f07ce6ed1a980f313b116ee41cea37a533dc55` | 61,540 |

Order was load-bearing: billing (`100000`) had claimed the earlier timestamp,
so avatars was renumbered to `101000` and **must** follow it.

Each chunk's hash was verified inside the editor immediately before running it,
against the hash of the file on disk. The six chunks concatenate back to
`PENDING_MIGRATIONS.sql` byte-for-byte
(`0554dea98731183d73f46715f6a2f1c492fa4580cba9c44e5676a5cabedef5e6`).

## The drift this creates

**The repository migration ledger does not reflect these six.** Applying SQL
through the dashboard editor does not insert into
`supabase_migrations.schema_migrations`, so the live ledger's highest entry is
still `20260724215138`. The live database is now ahead of the ledger by these
six *and* by the fifteen migrations between `20260725120000` and
`20260726096000`, which were evidently also hand-applied and equally unrecorded.

Consequence: **`supabase_migrations.schema_migrations` cannot be trusted as a
record of what is applied to this project.** Verify against real objects
(`to_regclass`, `pg_proc`) instead, as was done here.

## Drift safety, verified rather than assumed

Before applying, the live definitions of the two functions this repo holds at an
older revision were fingerprinted, and re-checked afterwards. Both are
**unchanged** — nothing was downgraded:

| Function | md5 of `pg_get_functiondef`, before and after |
|---|---|
| `public.admin_provision_auth_user` | `d8160032e33feaaa61d1cccb29b05d5d` |
| `public.admin_list_access_accounts` | `ac5d94d0f7153c622f4f5f1829b05ef4` |

None of the six reference `admin_provision_auth_user`,
`admin_list_access_accounts`, `platform_admin_client_detail`, or
`app_private.tenant_provider_credentials`.

One correction to the header comment inside `PENDING_MIGRATIONS.sql`: it claims
every `DROP` is a `drop policy/trigger if exists`. There are also
`drop constraint if exists` statements and one `drop function if exists` —
`public.tenant_update_agent_configuration`, at what is line 353 of the
concatenated file. That drop is benign: the parameter list grows, so the
function is dropped and recreated in the same transaction. The live 18-argument
signature was confirmed to match the drop's argument list exactly beforehand, so
it replaced cleanly rather than leaving a second, ambiguous overload.

## Post-apply verification

All five relations non-null, all four functions present:

- `public.tenant_margin_policies`, `public.tenant_subscriptions`,
  `public.agent_avatar_sets`, `public.ingestion_cleaning_revisions`,
  `public.provider_rate_counters`
- `analytics_learner_signals`, `tenant_rollback_agent_configuration`,
  `tenant_list_agent_configuration_revisions`, `billing_apply_plan_entitlements`

`billing_apply_plan_entitlements` lives in `app_private` and is deliberately not
executable by `authenticated` — it is reached only by the Stripe webhook behind
an operation secret. The user-facing RPCs
(`tenant_list_agent_configuration_revisions`,
`tenant_rollback_agent_configuration`, `tenant_update_agent_configuration`,
`analytics_learner_signals`, `learning_get_agent_directive`) are all executable
by `authenticated`.

## Applied without a backup

This project is on the Supabase **Free plan**: scheduled backups are not
included and PITR is a Pro add-on. Neither was enabled, so these six were
applied with **no rollback path**. That was a deliberate, accepted decision, on
the basis that the pre-flight showed a clean slate (none of the five relations
existed, so nothing was half-applied) and that the content is additive DDL. It
should not be treated as the normal standard — enabling backups before the next
hand-apply is the obvious remedy.

## Outstanding

- The nine 2026-07-24 bodies are still not recovered into
  `infra/supabase/migrations/` (see above); that work is unchanged by this entry.
- These six *do* exist as committed files, so the repo can rebuild them — but
  the ledger will not know they ran. Reconciling
  `supabase_migrations.schema_migrations` with reality is now a prerequisite for
  ever using `supabase db push` against this project.
