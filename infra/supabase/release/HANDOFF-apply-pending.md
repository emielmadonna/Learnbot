# Handoff: apply all pending migrations to the live Supabase database

Bring `supabase_migrations.schema_migrations` and `infra/supabase/migrations/` back into
step, applying whatever is genuinely missing — via the Chrome SQL editor, by hand.

```
REPO:        /Users/emielmadonna/Projects/LearningBot     <-- NEW PATH, moved out of iCloud 2026-07-31
PROJECT REF: fwilehggxqkpeuojxqzk  (East US / North Virginia)
SQL EDITOR:  https://supabase.com/dashboard/project/fwilehggxqkpeuojxqzk/sql/new
```

The user is already signed in to Supabase in Chrome. The repo has **113 migration files**
(`pnpm supabase:verify` confirms the count; it validates the *repository*, not the
database — it passing means nothing about what is applied).

## READ THIS FIRST — do not skip to the SQL

**You do not know what is applied. Neither do I.** The user believes they have not run
migrations "in a long time." `infra/supabase/SCHEMA-DRIFT.md` claims the opposite for the
recent past: a 2026-07-27 reconciliation left the ledger in step at **91 rows, 61 of 61
repo versions present**, with exactly two migrations recorded as awaiting hand-apply
(`20260731060000`, `20260731061000`). Those two claims cannot both be right, and roughly
20 further migrations have been committed since that entry was written.

**Resolve this empirically. Never from a filename, a document, or this sentence.**
Step 1 exists precisely because every other source of truth here has been wrong at least
once.

## CRITICAL SAFETY CONSTRAINTS

- **There are no backups.** Free plan: no scheduled backups, no PITR. Nothing you do is
  recoverable. The user has accepted this explicitly and repeatedly. Do not re-litigate
  it; do not let it make you careless either.
- **Never run `supabase db push`, `supabase db reset`, or `--include-all`.** The ledger
  and the migrations directory have been fully disjoint before. A push would replay all
  113 migrations from `0001` over live data. It is the single most destructive thing
  available in this repo.
- **`public.admin_provision_auth_user` creates client user accounts.** Older revisions of
  it sit in committed migrations; re-running the wrong one downgrades it and can destroy a
  live tenant. Fingerprint it before and after every apply and confirm it is unchanged:
  `d8160032e33feaaa61d1cccb29b05d5d`.
- **Apply one migration at a time**, never concatenated. Each file carries its own
  `begin;`/`commit;`, so one failure rolls back cleanly without touching its neighbours.
- If anything returns a value this document does not predict, **stop and report**. Do not
  improvise against a live database with no rollback.

## STEP 1 — Find out what is actually applied

In the SQL editor:

```sql
select version from supabase_migrations.schema_migrations order by version;
```

The results grid virtualises its cells, so scraping `innerText` returns empty strings.
Use **Export -> Copy as CSV** and read the clipboard.

Save that list to `/tmp/applied.txt`, one version per line, then compute the real diff:

```bash
cd /Users/emielmadonna/Projects/LearningBot
ls infra/supabase/migrations/*.sql | xargs -n1 basename | sed 's/_.*//' | sort -u > /tmp/repo.txt
sort -u /tmp/applied.txt > /tmp/applied.sorted
comm -23 /tmp/repo.txt /tmp/applied.sorted    # <-- versions in the repo, NOT in the ledger
```

That output is your work list, **in ascending order**. If it is empty, everything is
applied — record that and stop.

A version missing from the ledger does **not** prove the SQL never ran. Every hand-apply
on this project before 2026-07-27 went unrecorded. Before applying anything, check whether
its objects already exist (Step 2), or you risk re-running an older function definition
over a newer one.

## STEP 2 — For each missing version, prove it is really missing

Read the file. Identify what it creates. Check for those objects:

```sql
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     and n.nspname='public' where p.proname='<function_from_the_file>') as fn,
  (select count(*) from information_schema.tables
     where table_schema='public' and table_name='<table_from_the_file>') as tbl,
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n
     on n.oid=p.pronamespace and n.nspname='public'
     where p.proname='admin_provision_auth_user') as provision_md5;
```

- All objects already present -> the SQL ran but went unrecorded. **Skip the apply**, and
  record the version in the ledger (Step 4) instead.
- Objects absent -> genuinely pending. Apply it.
- `provision_md5` must read `d8160032e33feaaa61d1cccb29b05d5d` before you start.

## STEP 3 — Apply, one file at a time

**The browser paste corrupts UTF-8.** The Supabase editor re-decodes pasted text as
Latin-1, so an em-dash arrives as `‚Äî`. Inside a `$$`-quoted function body that is a
silent behaviour change, not a syntax error. The clipboard is fine — the corruption
happens on paste. Route everything through base64:

```bash
base64 < infra/supabase/migrations/<VERSION>_<name>.sql | tr -d '\n' | pbcopy
```

Click an actual line of code in the editor (`⌘A` selects the whole *page* unless focus is
genuinely inside Monaco — confirm `document.activeElement` has class `inputarea`), then
`⌘A`, `⌘V`, and decode in place:

```js
const m = window.monaco.editor.getModels()[0];
const b64 = m.getValue().replace(/\s/g,'');
if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('paste failed len='+b64.length);
const bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
m.setValue(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.getValue()));
[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');
```

Compare that hash against the file: `shasum -a 256 <file>`. **Do not run the migration
unless it matches.**

These 8 files contain non-ASCII and will be silently corrupted without the base64 route.
The rest are pure ASCII, but use base64 for every file anyway — it costs nothing:

```
20260726090000_platform_admin_client_provisioning     20260727090000_knowledge_ingestion_pipeline
20260726092000_authoring_publish_visibility           20260730143000_learning_source_connectors
20260726095000_authored_content_retrieval             20260731021643_visual_knowledge_manager
20260726097000_agent_control_surface
20260726101000_character_avatars
```

Supabase may show **"Potential issue detected — destructive operations"** on files that
`drop constraint if exists` before re-adding it a few lines later. Read the diff, confirm
that is what it is, then click **Run query**.

## STEP 4 — Record every version in the ledger, same session

This is the whole point of the document. Do not defer it.

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('<VERSION>', '<name_without_version_prefix>')
on conflict (version) do nothing;
```

`infra/supabase/release/LEDGER_RECONCILE.sql` is the prepared, idempotent precedent —
follow its shape. Re-run your Step 1 query afterwards and confirm the row count rose by
exactly the number you applied.

## STEP 5 — Verify

Re-run the Step 2 query for each applied migration; every object it creates must now
exist, and `provision_md5` must **still** be `d8160032e33feaaa61d1cccb29b05d5d`.

Two payoffs to check specifically, because the user is waiting on them:

```sql
-- per-client API keys (the console's Agent panel reads this)
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  and n.nspname='public' where p.proname='learning_provider_credential_state';   -- expect 1

-- widget inline media
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  and n.nspname='public' where p.proname='widget_get_visual_asset_for_read';     -- expect 1
```

`learning_provider_credential_state` is the one that matters most. Until it exists, the
**Workspace OpenAI API key** card in the console's Agent panel shows *"Provider status is
temporarily unavailable"* and no client can set their own key. That is the specific thing
this whole handoff is unblocking.

## FINALLY — record it and commit

Update `infra/supabase/SCHEMA-DRIFT.md`: for each migration, the date, that it was applied
by hand through the SQL editor rather than the release runner, the SHA-256 actually run,
and the before/after `admin_provision_auth_user` fingerprint showing no downgrade. Correct
the **Outstanding** and **Awaiting hand-apply** sections, which currently name
`20260731060000` and `20260731061000` as pending.

Then update `docs/PLAN.md` — the single source of truth for this project — wherever it
describes these as unapplied. Commit both.

**This document exists because a previous hand-apply went unrecorded and the repository
silently diverged from production for days. Do not repeat it.** If you apply something,
record it in the same session.

## CONTEXT YOU MAY NEED

- The repo moved to `~/Projects/LearningBot` on 2026-07-31. `~/Documents` is iCloud-synced
  and corrupted the working tree — evicted file contents surfaced as `errno -70` (ESTALE),
  phantom `tsc` errors, and multi-minute `git` hangs. Never move it back under
  `~/Documents`, and never try to exclude a synced folder in place with
  `xattr -w com.apple.fileprovider.ignore#P` — doing that mid-session renamed the repo out
  from under running tools.
- Current state is green: `pnpm check` exit 0, 386 tests passing, `next build` exit 0.
  Production is live at https://clone.stack-labs.ai.
- `OPENAI_API_KEY` is set in Vercel production but **absent from local
  `apps/console/.env.local`**. Only the owner adds it; do not ask for it in chat.
- The dashboard's CSP blocks `fetch` to `127.0.0.1`, so a local file server is not a usable
  transport for the SQL.
- The proper release path (`pnpm supabase:release link|plan|apply`) works but needs the
  database password and an approval file, which is why this is done by hand.
- Console tests: `cd apps/console && ./node_modules/.bin/tsx --test test/*.test.ts`
  (local `tsx`, not `npx`). If `tsx`/`esbuild` hangs at 0% CPU, Gatekeeper is deadlocking:
  `codesign --force --sign - <path-to-esbuild-binary>`.
