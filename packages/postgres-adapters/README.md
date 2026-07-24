# Postgres durable execution adapters

This package contains provider-neutral Postgres primitives for operations that
must survive process restarts:

- fingerprinted command receipts and exact-result replay;
- append-only course snapshots with a locked, compare-and-swap revision head;
- a transactional telemetry outbox with dedupe, bounded claims, leases,
  acknowledgement and caller-scheduled retry;
- exact verified-principal registration plus tenant-scoped membership, tenant
  context, service-principal, invitation and SCIM repositories.

The package deliberately has no database dependency. Applications inject a
`PostgresExecutor` whose `transaction` implementation checks out one connection,
begins a transaction, passes its bound `query` method to the callback, and
commits or rolls back with the callback. A pool-level `query` function is not a
valid transaction implementation.

`commitInTransaction` and `putInTransaction` allow a command receipt, its course
revision and its telemetry event to commit as one unit. Errors are propagated;
there is no in-memory or fake-data fallback.

Durable values are JSON-normalized before commit. The first command returns the
same parsed JSON shape a replay returns; top-level `undefined`, cycles, BigInt
and other values that `JSON.stringify` cannot encode fail and roll back.

The matching schema is migration
`infra/supabase/migrations/0007_durable_execution_primitives.sql`; identity
repositories use `0008_identity_and_provisioning.sql`. Identity application
wiring must register the protocol-verified principal before creating a
membership. The current `IdentityAccessService` contract also does not expose an
outer unit of work, so a caller that needs invitation or SCIM changes to commit
across multiple repository methods must supply a transaction-aware executor or
add that service boundary before claiming workflow-level atomicity. Individual
repository methods are transactional and conflict-safe; there is no memory
fallback. Retention is intentionally unset pending approved tenant policy.
