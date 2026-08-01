# Working on LearningBot

## Where the repo is

`~/Projects/LearningBot`. **Never `~/Documents/LearningBot`** — that path is an
empty husk. `~/Documents` is iCloud Drive-synced, and syncing `node_modules`
pinned `bird`/`fileproviderd` near 95% CPU, filled the disk by materialising
files, and evicted file *contents* while leaving the filenames in place. The
symptoms were bizarre and expensive to chase: `errno -70` (ESTALE) on module
load, `tsc` reporting `@types/react` "not found" for files that existed,
multi-minute `git` hangs, and a corrupted dependency.

Do not move it back. Do not try to exclude a synced folder in place with
`xattr -w com.apple.fileprovider.ignore#P` — doing that mid-session renamed the
live repo out from under running tools.

## Verify with `pnpm check`, never a bare typecheck

`pnpm typecheck` alone reports phantom errors when `packages/*/dist` is stale —
different files and counts on each run, all of which vanish after
`build:packages`. `pnpm check` sequences docs, contrast, supabase verify,
build:packages, typecheck and tests, and is the only trustworthy signal.

Known flake: `widget-runtime`'s `test` script runs `pnpm build`, which
`rm -rf`s `dist/` while console tests read it. A lone spurious failure there is
this race, not your code.

## Split the data before theorising

This is the expensive lesson from 2026-07-31. Three root causes were called
wrong in one session, each from a plausible code path that was never checked
against actual rows:

1. *"~20 migrations are unapplied."* Two were.
2. *"Connector courses are stuck in draft, so retrieval finds nothing."* The
   code path was real — `learning_create_source_course` does insert `'draft'`
   and retrieval does require `'published'` — but Estie's six courses were all
   published with 126 lessons. The theory was tested against the source and not
   against the database.
3. *"`after()` is being killed before the classifier's 8s deadline."* Plausible
   (nothing in the project set `maxDuration`), but wrong. One query settled it:
   authenticated path 4 questions / 4 labelled; widget path 12 / 0. The widget
   route never invokes the classifier at all.

Every one of those was resolved by grouping the data, not by reading more code.
When a surface looks broken, get the counts first. State clearly-labelled
unknowns rather than confident guesses — a flagged unknown is worth more than a
wrong answer, and much more than a wrong answer delivered fluently.

## Supabase

- **Do not use the supabase MCP.** It points at a different product's live CRM
  database. Read schema from `infra/supabase/migrations/`.
- **Never `supabase db push`, `db reset`, or `--include-all`.** The ledger and
  the migrations directory have been fully disjoint before; a push would replay
  every migration over live production data.
- **There are no backups.** Free plan, no PITR.
- **Migrations and edge functions are applied by hand**, through the Supabase
  SQL editor. There is no deploy config for edge functions anywhere. Record
  every apply in `infra/supabase/SCHEMA-DRIFT.md` *in the same session* — that
  document exists because a hand-apply once went unrecorded and the repository
  silently diverged from production for days.
- **The SQL editor mangles non-ASCII on paste.** Route SQL through base64 and
  decode in the page. A corrupted em-dash inside a `$$`-quoted function body is
  a silent behaviour change, not a syntax error.
- Fingerprint `public.admin_provision_auth_user` before and after any apply:
  `d8160032e33feaaa61d1cccb29b05d5d`. Older revisions exist in committed
  migrations and re-running the wrong one can destroy a live tenant.

## Environment

`OPENAI_API_KEY` is set in Vercel production but **absent from
`apps/console/.env.local`**. Only the owner adds it — never ask for it in chat.
That difference changes which provider path runs, so local behaviour proves
nothing about production for anything provider-backed.

`SUPABASE_SECRET_KEY` is **not** in Vercel production. This is why privileged
work funnels through edge functions rather than Next.js routes.

## Opaque-by-design failures

`widget_ask` returns `widget_unavailable` from four different places — unknown
key, revoked key, widget disabled, and `anonymousQuestions` off — deliberately,
so a disabled tenant is indistinguishable from an unknown key. `anonymousQuestions`
**defaults to `false`**, so a freshly installed widget paints a launcher, opens,
and refuses every question. When you see `widget_unavailable`, check the
settings before you debug anything.

## Honest surfaces

This codebase consistently prefers saying "not known" to showing a plausible
number, and that is deliberate — keep it. Several bugs found here were surfaces
that had the data and discarded it (Home fetched signals and dropped them;
Insights hard-coded "Not measured" while its RPC went unread). When a panel
looks broken, check whether it is *rendering* less than it *fetched*.

Never let an empty list read as reassurance. Distinguish "the read failed",
"nothing was detected, and here is why", and "here is what was detected".
