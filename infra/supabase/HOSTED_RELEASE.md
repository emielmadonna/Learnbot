# Hosted Supabase release runbook

This lane prepares and verifies a LearningBot-only Supabase release. It does
not authorize creating, linking or changing a hosted project by itself. An
authorized operator must first create or select a project dedicated to
LearningBot and approve its exact identity. Never reuse HookLab, Midway or any
other application project.

As recorded on 2026-07-24, the repository contains 16 ordered migrations and
41 structurally verified tables. Always regenerate the fingerprint and require
an exact remote ledger match; this count is context, not authorization to apply
or evidence that a later migration set passed.

The dedicated LearningBot hosted project reached an exact 0001–0016 migration
ledger and passed all seven transactional SQL suites on 2026-07-24. This
checkpoint is bounded to that database ledger and those rolled-back fixtures;
it does not establish provider, object-storage, backup/restore or complete
application-production acceptance.

## Safety boundary

The runner refuses to continue unless all of these match:

- a 72-hour-or-shorter approval names the exact project ref and catalog name;
- the catalog region exactly matches the approved residency region;
- the approval is explicitly dedicated to LearningBot and allows the action;
- the approval fingerprint covers every ordered migration byte;
- the authenticated Supabase CLI can see that exact project;
- `SUPABASE_DATABASE_URL` encodes the approved project ref and database name;
- a live SQL query returns the approved database role and database name;
- the local CLI link equals the approved project ref;
- apply receives successful matching plan evidence less than 30 minutes old;
- apply receives an exact release confirmation containing environment, ref and
  migration fingerprint.

Real approvals, generated evidence, CLI link state and secrets are ignored by
Git. The runner redacts known credentials from captured output. It does not
push seed data, use `--include-all`, repair migration history, reset databases
or implement destructive rollback.

## Prerequisites

- Supabase CLI authenticated as the authorized organization operator.
- `psql` compatible with the hosted PostgreSQL major version.
- A new, explicitly approved LearningBot staging or production project.
- Its ephemeral database password and connection URL. Prefer a temporary
  credential and revoke or rotate it after the release.
- Backup/PITR enabled and a restore point recorded outside this repository.

Do not put access tokens, passwords or database URLs in shell history, JSON,
`.env` files, tickets or committed evidence. Export them from the approved
secret-management session.

## 1. Inspect and approve the immutable migration set

From the repository root:

```sh
pnpm supabase:verify
pnpm supabase:release:test
pnpm supabase:release inspect
pnpm supabase:release fingerprint
```

Copy `infra/supabase/release/approval.example.json` to a filename ending in
`.approval.json`. An authorized operator fills in the exact catalog project
name/ref, environment, approved region/data-residency choice, expected database
role, fingerprint, approver and a short expiry. The real file is intentionally
ignored.

## 2. Supply ephemeral credentials

Use a shell session that does not persist history:

```sh
export SUPABASE_DB_PASSWORD='ephemeral-database-password'
export SUPABASE_DATABASE_URL='postgresql://.../postgres?sslmode=require'
```

The URL must identify the approved ref either through the direct database host
(`db.<ref>.supabase.co`) or the pooler username (`postgres.<ref>`). The runner
passes it to `psql` through `PGDATABASE`; it never writes it to evidence.

## 3. Link locally

```sh
pnpm supabase:release link \
  --approval infra/supabase/release/learningbot-staging.approval.json
```

This checks the remote catalog and live database identity before writing the
local CLI link. A linked ref mismatch blocks all later actions.

## 4. Plan

```sh
pnpm supabase:release plan \
  --approval infra/supabase/release/learningbot-staging.approval.json
```

Review both `migration-list.txt` and `dry-run.txt` in the printed
`.release-evidence` directory. The dry run must contain only the expected
ordered LearningBot migrations. Stop on remote-only history, unexpected
objects, a role mismatch or a project mismatch. Do not use migration repair to
silence the difference.

## 5. Apply the reviewed plan

Use the exact confirmation printed by this pattern, substituting the approved
values and current fingerprint:

```sh
export SUPABASE_RELEASE_CONFIRMATION='APPLY:staging:<project-ref>:<64-character-fingerprint>'
pnpm supabase:release apply \
  --approval infra/supabase/release/learningbot-staging.approval.json \
  --plan-evidence infra/supabase/.release-evidence/<plan-directory>/manifest.json
unset SUPABASE_RELEASE_CONFIRMATION
```

Apply uses only regular pending migrations already represented in the remote
history. It does not seed fixtures. After apply, the runner queries the hosted
migration ledger and requires an exact ordered match to all local migration
versions.

## 6. Execute hosted acceptance suites

```sh
pnpm supabase:release verify \
  --approval infra/supabase/release/learningbot-staging.approval.json
```

This reruns the identity query and executes all seven SQL acceptance suites with
`ON_ERROR_STOP=1`. Each suite wraps fixed fixtures in a transaction and rolls
them back. Successful outputs and a sanitized manifest are captured beneath
`.release-evidence`.

Record the combined seven-suite checkpoint only when every suite passes against
the same exact hosted migration ledger. A forward migration added after a
failure invalidates the earlier combined checkpoint and requires the affected
suite—and the guarded verification gate—to be rerun.

Before production, repeat this full process against staging, exercise an actual
backup restore into a disposable recovery project, and preserve the approved
evidence in the organization’s immutable release system. The ignored local
evidence directory is not that system of record.

## Forward-only recovery

There are deliberately no destructive down migrations. If application is
unhealthy but schema is compatible, roll application traffic back while
leaving the migration in place. Correct a released schema with a new reviewed
forward migration. Restore only into an explicitly approved recovery project;
never reset or drop the hosted production database.
