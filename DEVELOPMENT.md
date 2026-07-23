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

## Implemented vertical slice

The repository now includes:

- tenant/request/provider/conversation/attachment/learning/MCP/event/cost contracts;
- one Student conversation for streamed text, browser speech, files and verified
  current-learning context;
- a dedicated realtime voice canvas driven by live Web Audio energy and spectral
  input, with tenant tinting, barge-in, cancellation-safe handoff and text
  continuity;
- Creator, Teacher, branding, learning-version and Platform Admin surfaces;
- course authoring with sanitized rich blocks, optimistic versions, validation,
  immutable revisions, publishing and rollback;
- membership-derived development sessions, tenant-match guards and
  actor-bound Student/voice ownership;
- tenant-safe in-memory application services used by UI, APIs and MCP;
- deterministic staged ingestion, selective reprocessing, atomic publish and
  rollback;
- provider-neutral routing with tenant policy, deadlines, compatible fallback,
  circuit state and attempt/cost telemetry;
- a management MCP whose mutations deny by default and require exact
  tenant/actor/grant/idempotency context;
- six Supabase migrations with 25 tenant-scoped tables, forced RLS, private
  storage policies and executable SQL negative tests.

## Honest delivery boundary

The current build is an evidence-backed development slice, not a production
certification. PostgreSQL security tests require Docker or an approved Supabase
development project. Production realtime transport/IdP adapters, durable
identity and replay repositories, durable queues and
outboxes, object storage, secret management, billing reconciliation,
retention/export/delete execution, load/recovery evidence and deployment
remediation remain explicit production milestones.

## Agent completion contract

Every task names its file allowlist, dependency assumptions, acceptance rows and non-goals. Handoff includes changed files, checks, screenshots/evidence when UI is involved, known limitations and any shared-contract request. Root independently reviews and runs shared checks before integration.
