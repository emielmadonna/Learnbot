# Supabase persistence and tenancy foundation

This directory contains a production-shaped, provider-neutral PostgreSQL
foundation for the Course AI Platform. It has not been connected or applied to
any external Supabase project.

## Migration order

Apply the numbered files exactly once, in lexical order:

1. `0001_extensions_and_security_helpers.sql`
2. `0002_tenants_and_learning_core.sql`
3. `0003_ingestion_and_knowledge.sql`
4. `0004_branding_progress_and_conversations.sql`
5. `0005_audit_cost_and_mcp.sql`
6. `0006_rls_policies_and_storage.sql`
7. `0007_durable_execution_primitives.sql`

With a disposable local Supabase instance:

```sh
supabase start --workdir infra
supabase db reset --workdir infra
psql "$LOCAL_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file infra/supabase/tests/security_verification.sql
psql "$LOCAL_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file infra/supabase/tests/durable_execution_primitives_verification.sql
node infra/supabase/scripts/verify-structure.mjs
```

`security_verification.sql` rolls back all fixtures. It covers the database
parts of SEC-01, SEC-02, SEC-03, SEC-07, ATT-02 and MCP-08. The Node verifier
requires no database and checks table manifests, tenant/concurrency/retention
columns, RLS controls, immutable ledgers, storage policies and forbidden raw
credential columns. `durable_execution_primitives_verification.sql` also rolls
back its fixtures and covers cross-tenant revision denial, immutable revision
facts and protected command/outbox identity. Structural verification does not
substitute for executing either SQL suite against PostgreSQL.

## Tenant and role trust boundary

RLS is deny-by-default. It trusts only `tenant_id`, `sub` and `app_role` claims
placed in `request.jwt.claims` by Supabase/PostgREST. The authentication service
must verify an active membership before minting these claims. The database role
claim is not treated as an application role. The canonical application roles
are `owner`, `client_admin`, `client_viewer`, `student` and `system_worker`
(`system_worker` is the SQL-safe spelling of the documented `system-worker`).
The tenant provisioner creates these five `roles` rows before memberships.

Application queries must include an explicit `tenant_id` predicate even when
RLS is present. Supabase `service_role` and PostgreSQL roles with `BYPASSRLS`
can bypass policies; keep them server-only and wrap them in tenant-scoped
repositories. Never expose them to browser, Widget, MCP client or agent code.

Optimistic concurrency uses `record_version`. Mutations must include
`where record_version = :expected_version`; the trigger increments the token.
Every mutation path supplies a stable, tenant-scoped `idempotency_key`.

The durable execution migration adds append-only course revisions, a
compare-and-swap revision head, fingerprinted command receipts and a leased
telemetry outbox. Their TypeScript adapters live in
`packages/postgres-adapters` and require an injected transactional PostgreSQL
executor; they never fall back to process memory. The adapter's tenant and
course identifiers must resolve to the UUIDs used by this schema.

## Storage paths

The private bucket uses this canonical object-key shape:

```text
<tenant_uuid>/<scope>/<owner_user_uuid>/<object_uuid>/<safe-filename>
```

The migration restricts direct authenticated reads/writes/deletes to the JWT
tenant and either the object owner or a tenant administrator. Course assets and
cross-user access must be delivered with a short-lived signed URL after
application-level lifecycle and object authorization. Validate MIME type,
magic bytes, size and safe filename before upload; quarantine until malware
scan and extraction complete. An object path is never authorization by itself.
Deletion workers must remove database references and storage objects
idempotently according to `retain_until` and legal-hold policy.

## Audit, cost and secrets

Audit and cost rows are append-only, including for privileged database callers.
Corrections append a new row linked through `supersedes_*`; they never rewrite
history. JSON metadata columns are explicitly `*_safe` and must be redacted
before persistence. Provider credentials are represented only by opaque
`credential_vault_ref` values. Secret values, raw MCP input/output and raw
provider responses do not belong in these tables.

## Rollback

These migrations intentionally have no automatic down migration: destructive
rollback would erase tenant content and immutable evidence. Before production
application, test restore from a backup/PITR point in staging. To reverse an
unreleased local schema, destroy and recreate only the disposable local
database. For a released schema, write a new forward migration. Never drop the
audit or cost ledgers as a rollback technique.

## Explicit limitations before production

- The SQL has been structurally checked only; run it against the pinned local
  Supabase/PostgreSQL version before merge and against staging before release.
- JWT issuance, membership-revocation propagation and owner impersonation
  sessions are application/auth-service responsibilities.
- Retention durations, legal hold, residency and voice-recording policy remain
  product/legal configuration decisions.
- Vectors store their provider/model/dimension explicitly. Add dimension-
  specific partial vector indexes only after workload tests select supported
  embedding models; the base schema intentionally makes no provider assumption.
- Storage malware scanning, signed URL issuance, export/delete orchestration,
  backups/PITR and restore drills are not implemented by these migrations.
- Database policies enforce authorization boundaries; MCP schema validation,
  rate/cost budgets, grant consumption, confirmation and output sanitization
  remain mandatory in the application service and MCP gateway.
