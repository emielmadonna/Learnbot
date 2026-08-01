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

## Applied by hand 2026-07-31: widget visual media and answer feedback

The live ledger was exported from the dashboard before applying anything. It
contained 111 rows; comparison against all 113 repository versions identified
exactly two missing versions. Object checks confirmed that both migrations were
genuinely pending rather than previously hand-applied without a ledger entry:
both new tables and all seven new functions were absent.

Each file was applied separately through the dashboard SQL editor rather than
the release runner, then recorded in `supabase_migrations.schema_migrations` in
the same browser session:

| Version | Name | SHA-256 actually run |
|---|---|---|
| 20260731060000 | `widget_visual_media_disclosure` | `ca4839e67b9d528effc71e8830b61c7053bedc14b13f2870fa44dce40bd06722` |
| 20260731061000 | `answer_feedback_and_lesson_reception` | `1ee08da8013c43ee03b073b9d4c08f13ced503e658b4e0295b78a7969e9b95ca` |

Both files are pure ASCII. Their base64 transport was verified byte-for-byte,
and the decoded editor content was copied back and SHA-256 checked immediately
before each run. Both destructive-operation warnings were accounted for: each
file contains one `drop policy if exists`, followed immediately by the
replacement deny policy.

### Verified after

| Check | Result |
|---|---|
| new tables | **2 of 2 present** |
| new functions | **7 of 7 present** |
| explicit indexes | **6 of 6 present** |
| deny-direct policies | **2 of 2 present** |
| tables with enabled and forced RLS | **2 of 2** |
| `learning_provider_credential_state` | **1 present** |
| `widget_get_visual_asset_for_read` | **1 present** |
| ledger rows | 111 → **113** |
| repository versions present in ledger | 111 of 113 → **113 of 113** |
| `admin_provision_auth_user` md5 | `d8160032e33feaaa61d1cccb29b05d5d` before and after |

The final exported ledger and the repository version list compare equal in both
directions. There are no migrations awaiting hand-apply.

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

## Applied by hand 2026-07-31: widget visual parts and imported-source publishing

Both migrations below were **applied and recorded** on 2026-07-31, taking the
live ledger to **115 of 115**. The protected `admin_provision_auth_user`
fingerprint was unchanged across the apply, and `learning-admin-users` was
deployed in the same session (now ACTIVE, version 7, JWT verification enabled,
its source carrying `inviteLink`/`inviteLinkError`).

This section was written *before* the apply, as the standard requires, and then
sat stale for several hours afterwards: the apply was reported in conversation
and never written back here, so the ledger went on claiming both were pending
while they were live. That is the same class of divergence this whole document
exists to prevent, arriving by a new route — not an unrecorded apply, but an
unrecorded *update to the record*. Reporting an apply somewhere else is not
recording it. Edit this file in the same session, every time.

| Version | Name | SHA-256 | Bytes |
|---|---|---|---|
| 20260731070000 | `widget_answer_visual_parts` | `9a48b99e9b25e323...` | 9,149 |
| 20260731071000 | `publish_imported_source_courses` | `f593cc317f40b2d5...` | 14,647 |

Both are pure ASCII, deliberately: the Supabase SQL editor mangles non-ASCII on
paste, and a corrupted character inside a `$$`-quoted body is a silent
behaviour change rather than a syntax error. Route them through base64 anyway.

What they changed (both now live):

- **Widget answers can carry images.** Before this, `widget_ask` re-projects its matches
  into a narrow object that drops `visualAssetId` / `mediaType` / `visualKind` /
  `altText`, even though `app_private.visual_source_for_match` already enriches
  every match with them. The answering server therefore cannot learn that a
  cited chunk is a visual, `widget_get_visual_asset_for_read` never finds a
  disclosure row, and the widget stays text-only. That is its behaviour today,
  so nothing regresses; the feature simply stays dark.
- **Connector-imported courses can now be published.** Before this,
  `learning_publish_course` requires a `content_blocks` row joined to a live
  `lessons` row; `learning_create_source_course` creates the destination with
  neither, so publishing raises `check_violation: 'Course has no publishable
  content'`. Every YouTube or external import builds its chunks correctly and
  is then permanently unreachable, while the connector UI reports
  "Answerable now".

Neither migration alters existing data. `20260731070000` replaces one function;
`20260731071000` replaces the publish gate and the connector sync readout.
Rolling back means restoring the prior definitions, both of which are committed.

## Awaiting hand-apply: widget question labels and ratable widget answers

Committed 2026-07-31 and **not yet applied**. Recorded here before any apply,
in the same session it was written.

| Version | Name | SHA-256 | Bytes |
|---|---|---|---|
| 20260731080000 | `widget_question_labels_and_ratable_answers` | `a8b49f3d13e4e7b61e823802e12bddb37fb678cb28a6a3a75576dee31101be2b` | 15,114 |

Pure ASCII, verified by byte scan (zero bytes above 0x7F). Route it through
base64 anyway.

Order matters only against `20260731070000`, which also replaces a widget
function. There is no overlap: `20260731070000` replaces `public.widget_ask`,
which this file does not touch at all.

### What it does

1. `public.widget_record_question_label(...)` — new. The anonymous twin of
   `public.learning_record_question_label`, which cannot serve the widget
   because it opens with `app_private.learning_rpc_context()` and there is no
   session to read a tenant from. Gated by the same
   `conversation.answer.record` operation token as `widget_record_answer`, and
   granted to `anon` only. It names the question by the idempotency key
   `widget_ask` already wrote it under, so no message UUID crosses the widget
   boundary in either direction.
2. `public.widget_record_answer` is **replaced** to add one key to its returned
   object: `messageId`. Everything else in the body is unchanged from
   20260726093000 — same token gate, same resolve, same validation, same
   append. Restated in full because a plpgsql body cannot be patched in place.

### Until it is applied

- **Widget and hosted questions stay unlabelled**, which is their behaviour
  today: nothing regresses. `widgetRecordQuestionLabel` reports
  `request_failed` for the missing function, and the route logs
  `[widget-question-classifier] label rejected by the database:
  code=request_failed`, so the gap is visible in the log rather than silent.
- **The widget shows no rating control.** `parseWidgetAnswerRecord` turns a
  missing `messageId` into `null`, `/api/widget/ask` then omits `message.id`,
  the embed adapter sets no `feedbackRef`, and the runtime renders nothing.
  That is deliberate: the alternative is a button keyed on a client-minted id
  that `/api/widget/feedback` refuses, which is exactly the bug the console's
  authenticated surface shipped and had to fix.

### Rollback

Restoring `public.widget_record_answer` to its committed 20260726093000 body
and `drop function public.widget_record_question_label(...)`. No existing row
is read or rewritten by either statement; the only writes at runtime are
`question_labels` upserts, which are keyed `(tenant_id, message_id)` and
already idempotent.

## Awaiting hand-apply: tenant capability control and the widget section key

Committed 2026-07-31 and **not yet applied**. Recorded here before any apply,
in the same session it was written.

| Version | Name | SHA-256 | Bytes |
|---|---|---|---|
| 20260731081000 | `tenant_capability_control` | `519f399e34ee5864bdcee65199d10942d775d55eb3c1c12c5eb6e6fb6bc2676d` | 15,850 |

Pure ASCII, verified with `grep '[^ -~]'` returning nothing. Route it through
base64 anyway.

Note the version: this was first written as `20260731080000` and renamed after
a collision with `20260731080000_widget_question_labels_and_ratable_answers`,
authored concurrently. `supabase_migrations.schema_migrations` is keyed on the
version alone, so a duplicate is recorded once and the second file is silently
treated as applied. `verify-structure.mjs` now refuses duplicate versions.

### What it does

1. `public.tenant_capability_grants` plus
   `public.platform_admin_set_tenant_capability`,
   `public.platform_admin_tenant_capabilities` and
   `public.tenant_get_capabilities`. This is a new table and three new
   functions; it replaces nothing.
2. `widget` joins `app_private.tenant_section_definitions()` at position 6,
   and `public.tenant_sections`' unnamed inline `check (section_key in (...))`
   is dropped and re-added by name with seven keys. **This is the one
   destructive-looking step**: the drop is done in a `DO` block that matches
   on `pg_get_constraintdef(...) like '%section_key%'` rather than on a guessed
   constraint name, because 20260725123000 declared it inline and the generated
   name is an implementation detail.
3. `app_private.billing_core_sections()` is replaced to include `'widget'`.
   Without this, the next `billing_apply_plan_entitlements` run would switch
   the widget section OFF for every tenant, because that function darkens every
   catalogue key that is not entitled.

### Until it is applied

- **Capability rows in the platform panel stay disabled.** The panel reads
  capabilities through its own request, separate from
  `platform_admin_tenant_capabilities`' absence taking down anything else, and
  renders the honest "Not readable" state. Nothing else on the client detail
  degrades.
- **The widget section shows as "Not in catalogue"** in the same panel rather
  than as a toggle reading `off`, which would be a plausible-looking lie about
  a section the client can still reach. `resolveSections` is unaffected: with
  no `widget` row in the catalogue the tenant loop never touches it, so the
  role gate (`canAdminister`) continues to decide it exactly as today.

### Rollback

Rolling back means restoring `app_private.tenant_section_definitions()` and
`app_private.billing_core_sections()` to their committed prior bodies
(20260725123000 and 20260726100000), re-adding the six-key check constraint,
and dropping `public.tenant_capability_grants` with its three functions. No
existing row is rewritten by this migration; the only writes are two seeding
INSERTs, both `on conflict do nothing`.

### Not covered

Enforcement. A withheld capability is recorded and audited, and
`tenant_get_capabilities` exposes it to the tenant's own console, but no client
surface consults it yet — there is not even a tenant-side invite flow to gate
(`invite` appears in `components/sections` only in the platform panel's own
owner invitation). The platform panel says so on the card rather than implying
a switched-off row already restricts somebody.

## Awaiting hand-apply: self-reported learner identity on the widget

Committed 2026-07-31 and **not yet applied**. Recorded here before any apply,
in the same session it was written.

| Version | Name | SHA-256 | Bytes |
|---|---|---|---|
| 20260731090000 | `widget_self_reported_learner_identity` | `0fbe9aeea351b74b4d1d13f79de45709864dba1efab919ff18ace622f08b2103` | 22,949 |

Pure ASCII, verified by byte scan (zero bytes outside 0x20-0x7E plus tab and
newline). Route it through base64 anyway.

Order matters against `20260731070000`, which holds the current
`public.widget_ask` body. This file **drops** that eight-argument function and
creates a ten-argument one, so it must be applied after it. It does not touch
`public.widget_record_answer`, so it is independent of the still-unapplied
`20260731080000` and `20260731081000` and may be applied before or after
either.

### What it does

1. `public.conversation_surfaces` gains `learner_key` (a 64-hex digest, or
   null) and `learner_identity` (`unidentified` / `self_reported_learner`),
   plus two check constraints and a partial index on `(tenant_id,
   learner_key)`. Both new columns are additive; the `not null default` on
   `learner_identity` is a catalog-only change on PG11+ and rewrites no row.
2. `app_private.conversation_surface_view` is **dropped and recreated** with
   the two new columns appended to its `returns table`. A return type cannot
   be changed by `create or replace`. The body is otherwise the 20260726094000
   body character for character, and all sixteen callers select from it by
   column name, so appending is invisible to them.
3. `public.widget_ask` is **dropped and recreated** with `visitor_ref text
   default null` and `visitor_tier text default null` appended. The drop is
   the point: two defaulted arguments added by `create or replace` would leave
   an eight-argument and a ten-argument candidate, and PostgREST calls this
   function by name, so every widget question would fail as `function is not
   unique`. The drop takes the ACL with it, so `grant execute ... to anon` is
   restated. Everything else in the body is unchanged from 20260731070000.

### Why `visitor_identity` was not given a third value

`conversation_surfaces.visitor_key` does not mean "a person" today. Every
widget row's key is derived from the conversation idempotency key
(`widget:<hash>`), which is a per-browser-session nonce the embed keeps in
`sessionStorage`. Six analytics bodies count `distinct visitor_key` on that
basis, and `app_private.widget_signal_detections` tells the customer so in
words: *an anonymous visitor reference identifies a returning browser, not a
person*.

Writing a person-stable hash into that column would have changed what all six
numbers mean without changing a line of any of them, and made that sentence
false. Adding `self_reported_learner` to `visitor_identity` has the mirror
failure: every one of those bodies filters on the literals
`'anonymous_visitor'` and `'verified_learner'`, so the new rows would have been
dropped from both buckets in silence.

So the person-stable pseudonym is a new column with its own label.
`visitor_identity` keeps its two values, and an identified widget visitor is
still `anonymous_visitor` — that column answers "did this platform verify a
learner", and the answer is genuinely no.

The surface row this function writes sets `visitor_key` to exactly the digest
`conversation_surface_view` was already synthesising for the same conversation,
so materialising the row cannot move a distinct-visitor count a tenant has
already been shown.

### What does change once applied

For a conversation whose host page declared an identity, `conversation_surfaces`
gains a real row where previously the view inferred everything. That row also
carries `host_origin`, which widget conversations have never had:
`app_private.widget_conversation` writes no `hostOrigin` into conversation
metadata, so the anonymous-spike signal currently groups every widget question
under `(origin not recorded)`. Opted-in tenants will start seeing the real
origin there. That is more truth, not different truth, but it is a visible
change to a shipped signal.

`attribution_source` for those conversations moves from `inferred_console` /
`conversation_metadata` to `recorded`, which is accurate: a surface really was
recorded.

### Until it is applied

Nothing regresses and nothing needs to wait for it.

`widgetAsk` omits `visitor_ref` and `visitor_tier` from the RPC body entirely
when no identity was declared, so every install that has not opted in sends
byte-for-byte what it sent before and matches the eight-argument function that
is live today. An install that *has* opted in gets one failed call, and
`/api/widget/ask` retries the same turn (same idempotency key, same trace id)
without the identity and logs `[widget-identity] the database refused the
identified call`. The visitor gets their answer; only the attribution is lost,
and the log says which migration is missing.

### Rollback

`drop function public.widget_ask(text,text,text,text,text,text,text,text,text,
text)` and re-run 20260731070000; `drop function
app_private.conversation_surface_view(uuid)` and re-run the 20260726094000
definition; then drop the two columns, the two constraints and the index. No
existing row is read or rewritten by any statement in the file — the only
runtime writes are to `conversation_surfaces`, keyed `(tenant_id,
conversation_id)`, and the update leaves `visitor_key` and `visitor_identity`
alone.

### Not covered

The new `learner_key` has **no reader yet**. It is reachable through
`conversation_surface_view` — the only sanctioned read path, since
`conversation_surfaces_no_direct_access` refuses every direct authenticated
read — but no analytics RPC or signal selects it. Per-learner signals
("this learner is stuck", repeat-question detection across sessions) are the
next piece of work and are not in this migration.

## Edge functions are still deployed by hand

`infra/supabase/functions/learning-admin-users/index.ts` has an **unapplied
change**: it now also returns a copyable `inviteLink` from
`auth.admin.generateLink`, because outbound email is not configured on this
project and `inviteUserByEmail` hands the link to the mail provider and returns
nothing usable. Without the deploy, an invitation is created and audited and
nobody can act on it.

```
supabase functions deploy learning-admin-users --project-ref fwilehggxqkpeuojxqzk
```

There is still no deploy config for edge functions anywhere -- no CI step, and
nothing in `hosted-release.mjs`. Every function on this project has been pushed
by hand, and this one is no different.

### `learning-provider-widget-complete` -- unapplied, 2026-07-31

`infra/supabase/functions/learning-provider-widget-complete/index.ts` has an
**unapplied change**: it now accepts `stream: true` and, when asked, proxies the
provider's token stream back as `text/event-stream` instead of a buffered JSON
body. This is what lets `/api/widget/ask` stream to the embedded widget and to
the hosted full-page assistant.

```
sha256  e9582374f8b032cf14c6700b81b5683c5037045a5f5570d6b1ba57f629a6db63
bytes   22035
```

```
supabase functions deploy learning-provider-widget-complete --project-ref fwilehggxqkpeuojxqzk
```

Why it had to be this function rather than a direct call from the console: this
is the only place the widget surface's tenant id exists, so it is the only place
`learning_reserve_provider_call` can run before the spend and
`learning_record_provider_cost` after it. Streaming around it would have made
every streamed widget answer unmetered.

**Not deploying is safe, and is the current state.** The new code path is
opt-in on a field the deployed function does not know: it ignores `stream` and
returns the JSON it always has. `streamWithManagedWidgetProvider`
(`apps/console/src/lib/provider-runtime.ts`) detects that -- it checks for a
`text/event-stream` content type and gets `application/json` -- and yields the
whole answer as one delta followed by `done`. So until the deploy, both
customer-facing surfaces get sources immediately and the prose in one piece;
after it, the prose arrives token by token. Nothing else differs, and no ledger
row changes shape either way.

The reservation, the ledger write and the refusal codes are unchanged in the
buffered branch. Both branches now write the ledger through one helper
(`recordWidgetCost`) specifically so a future edit cannot leave one of them
unmetered.

Everything added to this file is ASCII; the four non-ASCII characters it still
contains are pre-existing em-dashes in comments, untouched.
