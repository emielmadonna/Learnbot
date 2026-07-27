# Handoff: apply two migrations to a live Supabase database

Apply 2 pending SQL migrations to a live Supabase database via the Chrome SQL editor.

REPO: /Users/emielmadonna/Documents/LearningBot
SUPABASE PROJECT REF: fwilehggxqkpeuojxqzk (East US / North Virginia)
SQL EDITOR: https://supabase.com/dashboard/project/fwilehggxqkpeuojxqzk/sql/new
The user is already signed in to Supabase in Chrome.

## WHAT TO APPLY

Two files, in this order. Order is load-bearing — the second calls nothing from the
first, but the first establishes the `security.malware_scan` capability that the second
migration's design assumes exists.

| # | File | SHA-256 | Bytes |
|---|---|---|---|
| 1 | `infra/supabase/migrations/20260727110000_malware_scan_checkpoint.sql` | `18b77f3f2feb601c5b4dcbe977a265c532cf33928b1311012d1031ab84a0d995` | 9,965 |
| 2 | `infra/supabase/migrations/20260727120000_inert_source_scan_clearance.sql` | `64dc082f63bdc9829baa1414a0e2bfba69b6c58820def1f1db0d0854e2a2f895` | 5,904 |

Each is wrapped in its own `begin;` / `commit;`, so each is atomic and a failure rolls
back cleanly without touching the other. Apply them **one at a time**, not concatenated.

## WHY

The knowledge pipeline (Phase 10) is finished code that cannot run. Migration
`20260727090000` hard-codes a gate: `ingestion_extract_document` refuses with
`security_scan_pending` unless the `security` / `malware_scan` checkpoint for the job is
`succeeded`. Nothing can write that checkpoint, so every upload sits in
`tenant-private/{tenant}/quarantine/` permanently.

- `20260727110000` adds the capability and `public.security_record_scan_result`, the
  scanner-backed verdict writer.
- `20260727120000` adds `public.security_clear_inert_source`, which clears `text/plain`
  and `text/markdown` without a scanner, recorded as `scanner: 'none'`,
  `reason: 'inert_text'`.

After both land, uploads flow for text with no scanner deployed.

## CURRENT STATE — verified 2026-07-27, do not assume

A third migration, `20260727100000_retire_platform_admin_client_detail.sql`, has
**already been applied**. Do not re-apply it.

Confirm this is still the starting state before you touch anything:

```sql
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public' where p.proname='platform_admin_client_detail') as client_detail,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public' where p.proname='security_record_scan_result') as record_scan,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public' where p.proname='security_clear_inert_source') as clear_inert,
  (select array_length(app_private.learning_operation_capabilities(),1)) as capabilities,
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace and n.nspname='public' where p.proname='admin_provision_auth_user') as provision_md5;
```

Expected **before**: `client_detail=0`, `record_scan=0`, `clear_inert=0`,
`capabilities=5`, `provision_md5=d8160032e33feaaa61d1cccb29b05d5d`.

If `record_scan` or `clear_inert` is already 1, that migration is applied — skip it.
Both migrations are idempotent in practice (`create or replace`, `drop constraint if
exists` then re-add), but do not re-run one that already landed.

## CRITICAL SAFETY CONSTRAINTS — read infra/supabase/SCHEMA-DRIFT.md before starting

- **There are no backups.** The project is on the Supabase Free plan: no scheduled
  backups, no PITR. Nothing you do is recoverable. The user has been told this twice and
  has explicitly accepted it. Do not re-litigate it; do not let it make you careless
  either.
- **Never run `supabase db push`, `supabase db reset`, or `--include-all`.** The
  migration ledger and `infra/supabase/migrations/` share **zero** versions — a push
  would replay all 59 migrations from `0001` over live data. This is the single most
  destructive thing available in this repo.
- **`public.admin_provision_auth_user` is the function that creates client user
  accounts.** Older revisions of it exist in committed migrations. Re-running the wrong
  migration downgrades it and can destroy a live tenant. Fingerprint it before and after
  (query above) and confirm it is unchanged: `d8160032e33feaaa61d1cccb29b05d5d`.
- Neither of the two migrations here references `admin_provision_auth_user`,
  `admin_list_access_accounts`, or `app_private.tenant_provider_credentials`. They have
  been checked. Do not add anything that does.

## HOW TO APPLY — the paste is the hard part

**The browser paste corrupts UTF-8.** Pasting SQL directly into the Supabase editor
re-decodes it as Latin-1, so an em-dash (`—`) arrives as `‚Äî`. The system clipboard is
fine; the corruption happens on paste. Both files contain em-dashes. Route the content
through base64 so the clipboard carries only ASCII, then decode in the page:

```bash
base64 < infra/supabase/migrations/20260727110000_malware_scan_checkpoint.sql | tr -d '\n' | pbcopy
```

Then in the SQL editor: click a line of code, ⌘A, ⌘V, and run this in the page to decode
in place and prove the result is byte-identical to the file:

```js
const m = window.monaco.editor.getModels()[0];
const b64 = m.getValue().replace(/\s/g,'');
if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('paste failed len='+b64.length);
const bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
m.setValue(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.getValue()));
[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');
```

**Do not run the migration unless that hash matches the table above.**

Other gotchas, all encountered for real:

- `⌘A` selects the whole *page* unless focus is genuinely inside Monaco. Click an actual
  line of code first, then confirm `document.activeElement` has class `inputarea`.
- The dashboard's CSP blocks `fetch` to `127.0.0.1`, so a local file server is not a
  usable transport.
- Supabase shows a **"Potential issue detected — destructive operations"** dialog on
  migration 1. That is the `drop constraint if exists` on the operation-secret capability
  list, which is re-added four lines later. Click **Run query**.
- The results grid virtualises its cells, so scraping it via `innerText` returns empty
  strings. To read a large result, use **Export → Copy as CSV** and read the clipboard.

## AFTER APPLYING — verify, don't assume

Re-run the state query above. Expected **after**:

- `record_scan = 1`
- `clear_inert = 1`
- `capabilities = 6`
- `provision_md5 = d8160032e33feaaa61d1cccb29b05d5d` — **unchanged**

Then confirm the new capability and the grant posture:

```sql
select 'security.malware_scan' = any(app_private.learning_operation_capabilities()) as capability_present,
       has_function_privilege('authenticated','public.security_record_scan_result(text,uuid,text,text,text,text,jsonb)','EXECUTE') as verdict_reachable_by_session,
       has_function_privilege('authenticated','public.security_clear_inert_source(uuid)','EXECUTE') as clearance_reachable_by_session;
```

Expected: `true`, **`false`**, `true`.

That middle value matters and is the whole security property: a creator's browser
session can ask for their own file to be cleared, but must **not** be able to write a
scanner verdict. If `verdict_reachable_by_session` comes back `true`, something is wrong
— stop and report it rather than continuing.

## FINALLY — update the drift record and commit

`infra/supabase/SCHEMA-DRIFT.md` has a section titled **"Phase 17 migrations — partially
applied"** listing both of these as `not applied`. Update it: mark each applied, with the
date, that it was done by hand through the SQL editor rather than the release runner, the
SHA-256 actually run, and the before/after `admin_provision_auth_user` fingerprint showing
no downgrade. Also update the **Outstanding** list, which currently tells the reader to
apply them.

Then update `docs/PLAN.md` — it is the single source of truth for this project. The build
order table lists Phase 17 as *"done in code — migrations not yet applied to the live
database"* and Phase 10 as *"built; gate opens once 20260727110000 + 20260727120000 are
applied"*. Both need correcting once this lands.

Commit both edits.

**This document exists because a previous hand-apply went unrecorded and the repository
silently diverged from production for days. Do not repeat it.** If you apply something,
record it in the same session.

## OPTIONAL SECOND TASK — only if you have appetite for it

`infra/supabase/release/LEDGER_RECONCILE.sql` is a prepared, idempotent INSERT that
records the 47 repo migrations missing from `supabase_migrations.schema_migrations`. All
56 were verified as genuinely applied first — 350 objects checked for existence plus 7
bespoke checks for migrations that create nothing. The evidence is in that file's header.

Running it is what makes `supabase db push` safe again. It is a separate decision from
the two migrations above; do not bundle them. Expected afterwards: 39 + 47 = **86** rows
in the ledger.

## CONTEXT YOU MAY NEED

- `pnpm supabase:verify` (or `node ./infra/supabase/scripts/verify-structure.mjs`)
  validates the **repository**, not the database. It passing means nothing about whether
  anything is applied. It should report 59 ordered migrations.
- The console test suite is `cd apps/console && ./node_modules/.bin/tsx --test test/*.test.ts`
  and should be 145/145. Use the local `tsx` binary, not `npx`.
- If `tsx` or `esbuild` hangs at 0% CPU, macOS Gatekeeper is deadlocking on the binary.
  Fix: `codesign --force --sign - <path-to-esbuild-binary>`. A `pnpm install` reintroduces
  it. Wedged processes land in uninterruptible `UE` state and need a reboot to clear.
- The proper release path (`pnpm supabase:release link|plan|apply`) works but needs the
  database password and an approval file, which is why all of this is being done by hand.
