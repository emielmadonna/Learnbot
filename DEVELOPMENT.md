# Development coordination

## Shared local stack

Only the root integrator starts or stops shared services.

| Service | URL / port | Owner | Purpose |
|---|---|---|---|
| Console | `http://127.0.0.1:3100` | root integrator | Student, Creator, Admin, learning and MCP UI prototypes |

The current console process is recorded by PID at runtime; never hard-code a PID into source control. Agents use hot reload on the shared server and must not launch another copy.

Planned additions are one local Edge API and one shared fake/provider/data process. They receive fixed documented ports only when implemented. Do not create one server per module.

## Parallel ownership

| Lane | Owns | Does not edit |
|---|---|---|
| Control plane | tenancy/auth/RLS, application-service boundary, providers, audit/cost, management MCP | feature UI route internals |
| Learning pipeline | source intake, scanning, extraction, cleanup, structure, versions, diagrams, jobs | chat/runtime and tenant auth |
| Product experience | unified chat, course workspace, Creator/Admin screens, interaction/accessibility | provider SDKs, database access |
| Root integration | root config, shared dev server, shared navigation, dependency changes, integration tests, Git | agent-owned route internals while active |

One file has one owner at a time. A lane requests shared-contract changes from the root integrator instead of editing across boundaries.

## Four-day acceleration target

This is a vertical-slice sprint, not an enterprise-production claim.

### Day 1 — shared contracts and interactive surfaces

- tenant/request/provider/conversation/attachment/learning/MCP/Event/cost contracts;
- live console with unified Student conversation and fast course workspace;
- deterministic fake tenant/course/provider data;
- route-level responsive and keyboard checks.

### Day 2 — application-service spine

- in-memory/fake application services behind the real contracts;
- upload intent → scan/extract stage simulation → draft knowledge version;
- unified chat request using draft/active retrieval fixtures;
- read-only management MCP resources and job status.

### Day 3 — first real vertical path

- local persistence or approved Supabase development project;
- tenant isolation/RLS migrations and negative tests;
- one real text/embedding/storage adapter behind routers;
- file upload, selective re-ingest, publish/rollback and audit/cost traces.

### Day 4 — integration and handoff

- Creator/Admin route integration;
- error/degraded/permission states;
- browser checks for desktop/mobile/keyboard;
- serialized typecheck/build/test;
- evidence ledger, blockers and next sprint.

## Honest delivery boundary

Four days can produce a convincing, testable end-to-end development slice. It cannot honestly produce the enterprise-ready system described in the acceptance contract. Production multi-tenancy, voice provider hardening, full diagrams, all connectors, billing, retention/export/delete, load/recovery evidence and pilot remediation remain subsequent parallel milestones.

## Agent completion contract

Every task names its file allowlist, dependency assumptions, acceptance rows and non-goals. Handoff includes changed files, checks, screenshots/evidence when UI is involved, known limitations and any shared-contract request. Root independently reviews and runs shared checks before integration.
