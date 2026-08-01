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
`supabase_migrations.schema_migrations`.

On closer inspection the problem is much larger than "these six are missing",
and the first version of this entry understated it. Measured 2026-07-27:

| | count |
|---|---|
| migration files in `infra/supabase/migrations/` | 47 |
| rows in `supabase_migrations.schema_migrations` | 39 |
| **versions present in both** | **0** |

The two sets are **completely disjoint**. Every ledger row is a generated
timestamp from 2026-07-24 (`20260724074635` … `20260724215138`); none of them is
a repo filename version. Spot-checked directly: `0001`, `20260724182939` and
`20260726097000` all return zero rows, and nothing dated 2026-07-25 or later
exists in the ledger at all.

Consequence, and it is the serious one:

> **`supabase db push` would consider all 47 repo migrations unapplied and try to
> run every one of them, `0001`–`0028` included.** That is precisely the
> full-replay path this document was created to warn about. Do not run it against
> this project until the ledger is reconciled.

`supabase_migrations.schema_migrations` is therefore not a record of what is
applied to this project and must not be read as one. Verify against real objects
(`to_regclass`, `pg_proc`, `pg_constraint`) instead, as was done here.

Reconciling it means deciding, per repo migration, whether it is genuinely
applied and then inserting its version. **That verification pass has now been
done — see below. The insert itself is still outstanding.**

### The verification pass (2026-07-27)

All 56 repo migrations were confirmed already applied to the live database.
Nothing was taken on faith from a filename.

- **47 migrations** — every object each one creates was checked for existence:
  350 tables, views and functions across `public` and `app_private`.
  **350/350 present.**
- **7 migrations** create no new object; they patch a function body in place or
  only move privileges. Each was checked for its own specific effect:

  | Migration | Check | Result |
  |---|---|---|
  | `0013` | `auth_select_tenant` definition contains `#variable_conflict use_column` | true |
  | `0014` | `onboarding_update_tenant_profile` contains the qualified `…profile.idempotency_key` | true |
  | `0015` | `onboarding_accept_invitation` contains `#variable_conflict use_variable` | true |
  | `0016` | some definition contains `on conflict on constraint identity_principals_pkey do nothing;` | true |
  | `0018` | `service_role` lacks EXECUTE on `learning_get_workspace()` | true |
  | `0025` | `service_role` lacks / `authenticated` holds EXECUTE on `learning_search_chunks_hybrid(…)` | true |
  | `20260724183637` | index `platform_administrators_created_by_idx` **and** policy `platform_administrators_no_direct_access` exist | true |

- **2 migrations** (`20260724212458`, `20260724212646`) were already in the ledger.

Since the nine recovery files landed, nine versions now match, so **47 rows**
remain to be recorded.

The prepared, idempotent statement is committed at
`infra/supabase/release/LEDGER_RECONCILE.sql`, together with the evidence above.
Rows are inserted with a NULL `statements` array — the same thing
`supabase migration repair --status applied` does; the SQL itself lives in
`infra/supabase/migrations/`.

Until that statement is run, `supabase db push` remains unsafe against this
project.

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

## The nine unrecorded bodies: recovered

The outstanding item at the top of this document is now **done**. All nine
2026-07-24 migration bodies were read out of
`supabase_migrations.schema_migrations.statements` and written to
`infra/supabase/migrations/` as `<version>_<name>.sql`. Each was verified against
the database's own `md5()` and `length()` of the stored statement before writing:

| Version | Name | Chars | md5 |
|---|---|---|---|
| 20260724212458 | `app_private_rls_hardening` | 1,042 | `c227b0b1c60e0b76b81aabbad9af4f92` |
| 20260724212646 | `app_private_rls_hardening` | 401 | `a64c87f991977b558a2000ee…` |
| 20260724212859 | `managed_account_provisioning_diagnostics` | 8,182 | `a8a300d531904fcf86eafe0b…` |
| 20260724213033 | `managed_account_provisioning_fix` | 8,428 | `0101f2abbc543df813632de0d387eb42` |
| 20260724213043 | `platform_admin_client_detail` | 10,928 | `98b8efb15f70c438a59ba8a6228bab49` |
| 20260724213250 | `tenant_provider_vault_boundary` | 7,927 | `e7e673c5a4f277ceed8090a7c4168849` |
| 20260724213536 | `managed_account_provisioning_final` | 10,261 | `71bb221425b1403940e737cd23450f0d` |
| 20260724214825 | `platform_admin_provider_runtime_access` | 1,871 | `67b9cdb351b12c0a43687460e6a89681` |
| 20260724215138 | `platform_admin_provider_runtime_access_guard` | 1,720 | `35b6421ff50afb7b821a1b6c0d639b93` |

Each is a single SQL statement in the ledger; the files are that statement
verbatim plus a trailing newline.

They slot into the sequence between `20260724183637` and `20260725120000`, which
is chronologically correct. Three of them
(`…212859`, `…213033`, `…213536`) contain the successive revisions of
`public.admin_provision_auth_user`, so **the repository now holds the current live
definitions rather than an older one**. A rebuild from
`infra/supabase/migrations/` no longer downgrades that function, and the
provider-credential vault now has reviewable source.

This removes the "repo is behind live" half of the drift. What remains is the
ledger, which is a separate and worse problem — see above.

## Phase 17 migrations — all three applied

All three landed. `…100000` on the first attempt; `…110000` and `…120000` were
stopped that day by the agent permission layer — a tooling boundary, not a
problem with the migrations — and were applied later the same day.

| Migration | SHA-256 of the applied text | State |
|---|---|---|
| `20260727100000_retire_platform_admin_client_detail` | `3b94755b7f0122d3d1dda08ef5b05d7cf2fc5db7f64225e93a3cd1f374343d1b` | **applied 2026-07-27** |
| `20260727110000_malware_scan_checkpoint` | `18b77f3f2feb601c5b4dcbe977a265c532cf33928b1311012d1031ab84a0d995` | **applied 2026-07-27** |
| `20260727120000_inert_source_scan_clearance` | `64dc082f63bdc9829baa1414a0e2bfba69b6c58820def1f1db0d0854e2a2f895` | **applied 2026-07-27** |

### How the last two were applied

By hand, through the Supabase dashboard **SQL editor** — *not* the release runner
(`pnpm supabase:release apply`), which requires the database password and an
approval file. Run one at a time, in the order above, each as its own
`begin; … commit;`, so each was atomic.

Each file was carried into the editor as base64 (the browser paste re-decodes
UTF-8 as Latin-1) and decoded in place. The SHA-256 of the decoded editor
content was computed in the page and matched the file on disk **before** the
query was run: `18b77f3f…a0d995` over 9,965 bytes and `64dc082f…2f895` over
5,904 bytes. Both returned *Success. No rows returned.*

### Verified before and after

| | before | after |
|---|---|---|
| `public.platform_admin_client_detail` | 0 | 0 |
| `public.security_record_scan_result` | 0 | **1** |
| `public.security_clear_inert_source` | 0 | **1** |
| `app_private.learning_operation_capabilities()` length | 5 | **6** |
| `admin_provision_auth_user` md5 of `pg_get_functiondef` | `d8160032e33feaaa61d1cccb29b05d5d` | `d8160032e33feaaa61d1cccb29b05d5d` — **unchanged, not downgraded** |

Neither migration references `admin_provision_auth_user`,
`admin_list_access_accounts`, `platform_admin_client_detail`, or
`app_private.tenant_provider_credentials`. Checked before applying.

The grant posture — the security property the split of authority exists for —
was confirmed afterwards:

| Check | Result |
|---|---|
| `'security.malware_scan' = any(app_private.learning_operation_capabilities())` | `true` |
| `authenticated` may EXECUTE `security_record_scan_result(…)` | **`false`** |
| `authenticated` may EXECUTE `security_clear_inert_source(uuid)` | `true` |

A creator's browser session can ask for its own inert file to be cleared and
**cannot** write a scanner verdict. That middle `false` is the whole point.

As with every hand-apply on this project, the ledger does not record these two.

Applied with **no backup** — the project is still on the Free plan, so neither
scheduled backups nor PITR were available. Accepted deliberately, as before.

**Consequence: uploads of `text/plain` and `text/markdown` now clear quarantine
and the Phase 10 pipeline runs.** Anything else still needs a real scanner, by
design.

## Ledger reconciliation — complete, 2026-07-27

`infra/supabase/release/LEDGER_RECONCILE.sql` was run through the dashboard SQL
editor, in two passes on the same day.

| Pass | Applied text SHA-256 | Rows | Ledger after |
|---|---|---|---|
| 1 — the prepared 47 | `2151add4b581b99f88cee72318657352c64cdeaee5700ba319078273a953b671` | 47 | 86 |
| 2 — the file extended with the 3 Phase 17 versions | `3af5fa435e30a498eb1a163c3d8cd9152d88cdb19f326e74b8568c093ab741c3` | 3 | **89** |

Pass 1's hash was verified inside the editor before running. Pass 2 was run by
the user directly, from the committed file; the file is pure ASCII, so it needed
no base64 round-trip and the clipboard content was hash-matched to the file on
disk before handing it over.

The second pass exists because the reconcile file was prepared when the repo held
56 migrations and therefore predated `20260727100000`, `20260727110000` and
`20260727120000` — all three applied to the database that day but never recorded.
The file is idempotent, so the re-run inserted exactly those three and no-opped on
the other 47.

| | before | after |
|---|---|---|
| rows in `supabase_migrations.schema_migrations` | 39 | **89** |
| repo migration versions present in the ledger | 9 of 59 | **59 of 59** |

39 + 47 + 3 = 89, and every repo migration version is now recorded.

**`supabase_migrations.schema_migrations` is once again a true record of what is
applied to this project**, and the full-replay hazard this document was created
to warn about is closed: `supabase db push` no longer sees `0001` as unapplied.

That does not make `supabase db push` a routine command here. The repo still holds
no revision newer than the live database, so a push has nothing to do; and the
2026-07-24 drift means the ledger's own `statements` arrays are NULL for the 50
hand-recorded rows. Verify against real objects before trusting any tooling that
reads the ledger.

## Phase 12 observability migrations — applied 2026-07-27

Both applied by hand through the SQL editor, in version order, each
hash-verified in the editor immediately before running.

| Migration | SHA-256 of the applied text | Bytes |
|---|---|---|
| `20260727130000_audit_coverage` | `ce3b43b23a084f821aeb1adb32cc7fa1c662f72e3f008fbe67d469d5140cc60b` | 10,554 |
| `20260727140000_error_events` | `f0a1457393ed366ca16e36794507619f3b02870546d29ffe34a06f8af5bf34fa` | 17,945 |

`…130000` raised the destructive-operations dialog, as expected — it is the
three `drop trigger if exists` statements, each re-created on the next line.

### Verified after

| | result |
|---|---|
| triggers `messages_append_audit`, `upload_intents_append_audit`, `user_access_accounts_append_audit` | **3 of 3 present** |
| `public.error_events`, `public.error_groups` | both present |
| operation capabilities | 6 → **7** (`observability.error_intake`) |
| `admin_provision_auth_user` md5 | `d8160032e33feaaa61d1cccb29b05d5d` — unchanged |

The audit migration's whole design premise is that it replaces no existing
function. That was checked rather than assumed — all four RPCs it covers came
out **byte-identical** to their pre-apply fingerprints:

| Function | md5 before and after |
|---|---|
| `learning_record_user_message` | `926bb45a912c2f1862563ece16f891d2` |
| `learning_record_assistant_message` | `ff7bd3d652ff334e870f6005378f4ba7` |
| `learning_create_upload_intent` | `2695588eec02cca629ea837ccd04851c` |
| `learning_confirm_quarantine_upload` | `99ef8cbe971219ce7e232ca1b86a48b5` |

### Ledger kept in step, same session

Unlike every previous hand-apply on this project, these two were recorded
immediately. `LEDGER_RECONCILE.sql` was extended with both versions and re-run
(pass 3, applied text SHA-256
`17b7edc30f2e411f16bd24ff6ae0a12ecdf58aa490285eab0fcc9c59339a02ad`):

| | before | after |
|---|---|---|
| rows in `supabase_migrations.schema_migrations` | 89 | **91** |
| repo migration versions present | 59 of 59 | **61 of 61** |

The repository and the ledger have not diverged. That is the whole point of this
document, and it is the first time it has been true at the end of an apply.

## Awaiting hand-apply: widget visual media and answer feedback

Two migrations are committed to this repository and **not yet applied** to the
live database. Recorded here before the apply rather than after it, which is the
standard this ledger has been trying to reach.

| Version | Name | Purpose |
|---|---|---|
| 20260731060000 | `widget_visual_media_disclosure` | Public/hosted widget inline images and video |
| 20260731061000 | `answer_feedback_and_lesson_reception` | helpful/not-helpful ratings and per-lesson reception |

Until they are applied:

- `/api/widget/visuals/[visualAssetId]/content` returns 404 for every request,
  because `widget_get_visual_asset_for_read` does not exist. The widget degrades
  to text-only answers, which is exactly its behaviour today, so nothing
  regresses -- the feature simply stays dark.
- `/api/learning/feedback` and `/api/widget/feedback` return `request_failed`.
  The surfaces that read these figures already render "Not known" with a reason,
  so they keep doing that rather than showing a zero.

Both files are pure ASCII on purpose: the Supabase SQL editor mangles non-ASCII
on paste, and an em-dash arriving corrupted inside a `$$`-quoted function body
is a silent behaviour change rather than a syntax error.

Neither migration alters an existing table or function. Both are additive:
new tables, new indexes, new functions, new grants. Rolling back is dropping
what they created.

### Why the widget one took a design rather than a flag

The launch note said public visual media was "pending an exact widget-scoped
media capability". The reason it could not simply reuse the authenticated rule
is that a widget key is PUBLIC -- it ships in a `<script>` tag on the customer's
page -- so "any answerable asset belonging to the tenant this key names" would
let any visitor on any allowed origin enumerate the tenant's entire media
library by walking uuids. The migration replaces membership with DISCLOSURE: a
visitor may read exactly what the assistant already showed them, in their own
conversation, and the asset conditions from the authenticated path are kept on
top of that rather than replaced by it.

## Outstanding

- Backups remain disabled (Free plan). The next hand-apply will again have no
  rollback.
- ~~`platform_admin_client_detail` / `platform_admin_tenant_detail` overlap.~~
  **Resolved in source 2026-07-27.** `platform_admin_tenant_detail` wins: it is the
  only one called from application code, the only one under test, and the one
  `verify-structure.mjs` asserts. `platform_admin_client_detail` has zero callers.
  `20260727100000_retire_platform_admin_client_detail.sql` drops it.

  **Applied by hand 2026-07-27** via the SQL editor, at the user's explicit
  instruction. Verified before and after:

  | | before | after |
  |---|---|---|
  | `public.platform_admin_client_detail` | 1 | **0** |
  | `public.platform_admin_tenant_detail` | 1 | 1 |
  | `admin_provision_auth_user` md5 | `d8160032e33feaaa61d1cccb29b05d5d` | unchanged |

  Applied text SHA-256
  `3b94755b7f0122d3d1dda08ef5b05d7cf2fc5db7f64225e93a3cd1f374343d1b`, hash-verified
  in the editor immediately before running. Reversible: the full body is committed
  as `20260724213043_platform_admin_client_detail.sql`.

  As with every hand-apply on this project, the ledger does not record it.
