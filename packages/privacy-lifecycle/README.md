# Privacy Lifecycle

Provider-neutral, tenant-safe application contracts and deterministic reference
behavior for subject access, export, deletion and tenant retention workflows.
The package follows:

- `04-DATA-AND-INTELLIGENCE.md` privacy lifecycle;
- `15-SECURITY-AND-TENANCY.md` authorization/isolation requirements;
- `11-ADMIN-EXPERIENCE.md` asynchronous, idempotent, observable dangerous
  actions;
- SEC-01, SEC-02 and SEC-08 in `18-ACCEPTANCE-TESTS.md`;
- locked identity semantics from Product Specification §8.3;
- open decisions O-07 and O-13.

## Guarantees

- Every public operation accepts an authenticated tenant context and makes an
  exact authorization decision over actor, role, purpose, operation, target and
  deletion confirmation grant. The included authorizer is deny-by-default.
- Subject identity is repository-authoritative and explicitly
  `verified`, `self_reported` or `anonymous`. Anonymous identities and
  tombstoned identities produce honest blocked jobs rather than individual
  exports.
- Job creation is idempotent by tenant + key. Semantically changed key reuse is
  a conflict. Processing is bounded and resumable; retryable storage failures,
  unavailable records and legal holds remain `partial`/`blocked`, never false
  success.
- Export covers every record in the planned subject snapshot. Every canonical
  artifact has a SHA-256 and UTF-8 byte length; the sorted manifest body has a
  separate root SHA-256. Verification checks both the manifest and each
  artifact.
- Deletion requires a versioned, owner-approved policy and target-bound
  confirmation. Locked classes containing personal content, vectors or assets
  may only be deleted. Events/derived data may be deleted or deidentified.
  Audit/legal data may retain only minimal metadata when policy permits.
- Deletion reconciles records created while processing before it tombstones the
  subject. The tombstone retains identity tier, policy version, job, timestamp
  and a one-way subject digest, not personal content.
- Retention requires an explicit policy rule and `retentionDays` for every
  affected class. No duration, region, raw-audio setting or disposition is
  inferred.
- Active legal holds suppress deletion/retention before mutation and are
  rechecked on every resume.
- Job creation, replay/conflict, authorization denial, progress outcome and
  manifest verification produce tenant-scoped audit evidence without copying
  record payloads into the audit.

## O-07 / O-13 boundary

The package deliberately supplies no default retention period. A retention job
cannot plan without an exact tenant policy ID/version whose rules contain
explicit durations and dispositions. Voice recordings are simply a distinct
data class: production collection remains blocked until O-07 decides recording
and retention policy. Region is policy metadata, not a hardcoded routing
choice.

## In-memory reference behavior

The included stores provide deterministic:

- tenant-qualified identities, records, policies, jobs, receipts and audit;
- deletion, deidentification and minimal-metadata dispositions;
- one-shot failure injection and idempotent mutation receipts;
- live legal-hold release and job resumption;
- tenant-scoped export artifact/manifest storage and tamper fixtures;
- an exact-grant authorizer, clock and ID source.

They are test fakes, not production durability or compliance evidence.

## Production adapters and remaining gates

Production must add:

- Supabase/PostgreSQL repositories with forced RLS and negative isolation tests
  for every table/object operation;
- a real policy decision service and cryptographically verified,
  short-lived, exact-target confirmation grants;
- durable queue leases, checkpoint/CAS transactions, idempotency constraints
  and an outbox so mutation, job state and audit cannot diverge after a crash;
- a consistent deletion snapshot/lock that prevents writes during final
  reconciliation and tombstone commit;
- connectors that delete personal rows, pgvector vectors and Storage objects,
  and recompute or deidentify affected aggregates;
- immutable, minimized audit/legal storage with its separately approved
  retention/legal-hold policy;
- encrypted export archive/object storage, signed download authorization,
  streaming hashes and archive expiry/removal policy;
- authoritative legal-hold administration, release approval and privileged
  legal-access workflow;
- privacy policy approval, regions and class durations for O-13, plus O-07
  voice-recording decisions;
- student-facing/admin UI and the shared API/MCP adapters;
- a tenant-closure orchestrator for whole-tenant export/hard-delete. This
  reference service currently handles individual subject access/export/delete
  and tenant retention; the tenant closure path must enumerate every subject
  and tenant-only record through the same contracts.

## Commands

```sh
pnpm --dir packages/privacy-lifecycle typecheck
pnpm --dir packages/privacy-lifecycle build
pnpm --dir packages/privacy-lifecycle test
```
