# Privacy data lifecycle — preserved specification

**Status: SPECIFICATION ONLY. Nothing here is implemented. There is no privacy
or GDPR code path in this product today.**

If a client asks to export or delete their data right now, the answer is a
manual SQL procedure run by an operator against Supabase (see
[Manual runbook](#manual-runbook) below). There is no route, no RPC, no table
and no worker for access, export, deletion or retention.

## Provenance

`packages/privacy-lifecycle` (2168 lines) was deleted on 2026-07-26. It had zero
importers, zero API routes and zero tables; every repository in its
`src/repositories.ts` was an interface whose only implementations were the
in-memory `Memory*` fakes in `src/fakes.ts`. Its "deletion" mutated a JavaScript
`Map`. Keeping it was worse than deleting it, because `README.md` read as if the
capability shipped.

The type model below was the genuinely useful part of it and is preserved here
as the design target for the eventual implementation. Treat it as a starting
point, not a contract — the real implementation belongs in plpgsql with FK
integrity and an audit trail, matching how every other durable invariant in this
system is enforced.

## Data classes

Every personal-data record is classified into exactly one of these. A policy that
omits a rule for a class present in a job snapshot must **block**, not default.

```
profile | events | messages | derived_insights | evidence | vectors
assets | attachments | transcripts | voice_recordings | audit_legal
```

Disposition per class is one of `delete | deidentify | retain_minimal`.

## Retention policy

```ts
interface RetentionRule {
  dataClass: PersonalDataClass;
  /** Explicit input. There is deliberately no duration default. */
  retentionDays: number;
  disposition: DataDisposition;
}

interface RetentionPolicy {
  policyId: string;
  tenantId: TenantId;
  version: string;
  approvedBy: string;      // a named human, not a service account
  approvedAt: IsoTimestamp;
  effectiveAt: IsoTimestamp;
  legalHoldMode: "suppress";
  region?: string;
  rules: readonly RetentionRule[];
}
```

Two invariants carried over from the deleted package and worth keeping:

1. **No invented retention periods.** A missing `retentionDays` is a blocking
   error (`policy_missing_data_class_rule`), never a default. This is the same
   decision `0012:230` already encodes when it raises
   `O-13:retention_policy_decision_required`, and the same field
   `onboarding_workspaces.retention_policy_ref` (`0010:26`) is nullable for.
2. **Legal hold suppresses, it does not fail.** A held record is skipped and
   reported in `heldRecordIds`; the job completes as `partial`, not `failed`.

## Export manifest

```ts
interface ExportManifestItem {
  recordId: string;
  dataClass: PersonalDataClass;
  artifactRef: string;
  byteLength: number;
  sha256: string;
}

interface ExportManifest {
  schemaVersion: 1;
  manifestId: string;
  jobId: string;
  tenantId: TenantId;
  subjectId: string;
  identityTier: "verified" | "self_reported";  // never "anonymous"
  createdAt: IsoTimestamp;
  dataThrough: IsoTimestamp;
  items: readonly ExportManifestItem[];
  itemCount: number;
  totalBytes: number;
  rootSha256: string;
}
```

**Root hash algorithm** (preserved verbatim from
`packages/privacy-lifecycle/src/integrity.ts`, because a manifest whose
integrity check is not reproducible is not evidence):

1. Take the manifest without its `rootSha256` field.
2. Sort `items` by `recordId` using `localeCompare`.
3. Canonicalize: recursively sort every object's keys ascending; leave arrays in
   order.
4. `JSON.stringify` the canonical form.
5. `rootSha256 = sha256(hex)` of that string.

An anonymous subject cannot be exported — there is no identity to bind the
manifest to. That is a block reason (`anonymous_identity`), not an empty export.

## Job state model

```
kind    : access | export | delete | retention
status  : queued | running | partial | blocked | completed | failed
stage   : planning | processing | finalizing | done
```

Jobs are resumable and idempotent on `idempotencyKey`. A `delete` job
additionally requires a `policyRef` and a `confirmationGrantId` — deletion is
never a single-actor action.

Block reasons: `subject_not_found`, `anonymous_identity`,
`identity_tombstoned`, `policy_not_found`, `policy_invalid`,
`policy_missing_data_class_rule`, `legal_hold`, `record_unavailable`,
`adapter_failure`.

A completed deletion writes an identity tombstone (`subjectId`,
`identityTier`, `subjectDigest`, `deletedAt`, `jobId`, `policyVersion`,
`retainedLegalHoldIds`) so that a repeat request is answerable without
retaining the subject.

## Manual runbook

Until the above exists, this is the actual procedure. It is manual, it is
operator-run, and it should be quoted as such to any client who asks.

Personal data for a tenant lives in these tables:

| Table | Holds |
|---|---|
| `public.profiles` | display name, contact detail |
| `public.identity_principals` | verified identity binding |
| `public.identity_memberships` | tenant membership and role |
| `app_private.user_access_accounts` | managed account credentials state |
| `public.conversations` | conversation shells |
| `public.messages` | learner and assistant message bodies |
| `public.question_labels` | classifier output over learner questions |
| `public.question_signals` | aggregated question signals |
| `public.lesson_progress` | per-learner lesson completion |
| `public.learning_usage_events` | usage telemetry |
| `public.telemetry_outbox` | duplicated usage telemetry (currently undrained) |
| storage bucket `tenant-private` | uploaded files, brand assets, quarantine |

Order of operations for a deletion request: confirm no legal hold applies,
export first if the subject also requested access, delete storage objects under
the tenant prefix, then delete rows child-first so foreign keys hold, then
record what was done outside the database (there is no audit writer for this
path). `public.audit_ledger` is **not** written by any privacy operation.

Known gaps that make this runbook incomplete, and that the implementation must
close:

- No `dataThrough` snapshot — a manual delete races concurrent writes.
- No tombstone, so a repeat request is indistinguishable from a first one.
- No export integrity, so a delivered export cannot be verified later.
- No legal-hold registry at all.
