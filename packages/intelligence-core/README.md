# Intelligence Core

Provider-neutral, tenant-safe data and advisory intelligence foundations for
LearningBot. The package implements the approved scope in:

- `04-DATA-AND-INTELLIGENCE.md`
- `05-STUDENT-OPPORTUNITY-ENGINE.md`
- acceptance criteria INT-01/02/03 and OPP-01/02/03

## Guarantees

- The event taxonomy is a closed, schema-versioned discriminated union.
  Unknown types, future versions, malformed envelopes and mismatched payloads
  are quarantined, never coerced.
- Append is idempotent by tenant + event ID and tenant + delivery idempotency
  key. Semantically changed key reuse is quarantined as a conflict.
- Data health records source state, data-through time and identity coverage.
  Metrics are explicitly `known`, `partial` or `unknown`; degraded/missing input
  cannot silently become a known zero.
- Confusion, trailing-30-day content-gap, stall and module-velocity functions
  implement the documented formulas and preserve evidence references.
- Individual opportunities require eligible identity/consent/coverage,
  caller-supplied freshness and expiry decisions, same-tenant evidence,
  policy version and confidence.
- Opportunity lifecycle and feedback writes require a Creator/Owner actor and
  commit with an audit entry. The API exposes no messaging, pricing, access,
  outreach or other consequential action capability.

## Deliberate O-09 boundary

This package does **not** calculate an opportunity score or choose:

- component weights;
- minimum-data or review thresholds;
- a freshness/staleness duration;
- an expiry duration;
- an offer match;
- calibration/backtest release gates.

Those are blocked by O-09. `OpportunityCandidate` therefore requires
`policyVersion`, `evidenceThrough`, a caller-evaluated freshness state and an
explicit `expiresAt` supplied by an owner-approved policy. Invalid or incomplete
candidates are suppressed. Feedback remains separate from observed behavior and
does not alter a score or policy automatically.

## Production adapters still required

The included repositories and clock are deterministic in-memory fakes for unit
and integration tests. Production must provide:

- PostgreSQL/Supabase event storage with atomic unique constraints for
  `(tenant_id,event_id)` and non-null `(tenant_id,idempotency_key)`;
- append-only raw fact storage and a durable quarantine queue with restricted
  inspection and replay;
- RLS-enforced evidence and opportunity repositories;
- a transaction/CAS that commits each lifecycle status change and audit record
  together, and each feedback and audit record together;
- an authoritative, monotonic server clock/ID source;
- source-health adapters that derive coverage from connector checkpoints,
  expected deliveries and ingestion lag;
- retention, export, deletion/de-identification and legal-hold adapters;
- approved O-09 policy configuration and per-tenant backtesting before any
  production opportunity scoring.

The in-memory fakes enforce tenant-qualified keys, but they are not durable and
are not substitutes for database RLS/isolation tests.

## Commands

```sh
pnpm --dir packages/intelligence-core typecheck
pnpm --dir packages/intelligence-core build
pnpm --dir packages/intelligence-core test
```
