# Postgres durable execution adapters

This package contains provider-neutral Postgres primitives for operations that
must survive process restarts:

- fingerprinted command receipts and exact-result replay;
- append-only course snapshots with a locked, compare-and-swap revision head;
- a transactional telemetry outbox with dedupe, bounded claims, leases,
  acknowledgement and caller-scheduled retry.

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
`infra/supabase/migrations/0007_durable_execution_primitives.sql`. Retention is
intentionally unset pending approved tenant policy.
