# Course AI Platform

Enterprise multi-tenant learning assistants for course Creators and their Students.

The product combines:

- one Student conversation UI for text, voice, files, rich text and diagrams;
- fast course ingestion, cleanup, editing and republishing;
- Creator intelligence for questions, confusion, progress and opportunities;
- Platform Owner operations for tenants, providers, costs, ingestion and audit;
- provider-neutral capability routing;
- an MCP-first control plane for trusted agents and integrations.

## Source of truth

Read [the product documentation](docs/course-ai-platform/00-README.md) before implementation. Open decisions and blockers are tracked in [Risks and Decisions](docs/course-ai-platform/19-RISKS-AND-DECISIONS.md).

## Workspace boundaries

```text
apps/
  edge/          host-safe Edge API and streaming orchestration
  console/       Creator and Platform Owner web application
services/
  learning/      ingestion, cleanup, indexing and intelligence workers
packages/
  contracts/     provider-neutral domain and integration contracts
  application-services/
                 tenant-authorized UI/API/MCP service boundary
  identity-access/
                 verified identity, tenant selection, RBAC and embed trust
  course-authoring/
                 rich learning blocks, revisions, publishing and rollback
  learning-pipeline/
                 deterministic intake, versioning and rollback
  provider-router/
                 provider-neutral routing, fallback and telemetry
  realtime-voice/
                 provider-neutral sessions, events, barge-in and handoff
  widget-runtime/
                 framework-free Shadow-DOM companion and host adapters
  intelligence-core/
                 event quality, metrics and human-reviewed opportunities
  privacy-lifecycle/
                 access, export, deletion and policy-driven retention jobs
  mcp-server/    deny-by-default management MCP over shared APIs
infra/
  supabase/      ordered schema, forced RLS, storage and security tests
```

## Working development surfaces

With the shared server running, the current integrated development slice is at:

- Student chat, realtime voice and files: `http://127.0.0.1:3100/dev/chat`
- Learning ingestion and knowledge versions: `http://127.0.0.1:3100/dev/learning`
- Creator workspace: `http://127.0.0.1:3100/dev/creator`
- Teacher workspace: `http://127.0.0.1:3100/dev/teacher`
- Tenant branding: `http://127.0.0.1:3100/dev/branding`
- Platform administration: `http://127.0.0.1:3100/dev/admin`
- Embeddable Widget host simulator: `http://127.0.0.1:3100/dev/widget`

The UI, development APIs and management MCP share the same tenant-aware
application services. The chat API also runs through the provider router, so
development exercises tenant policy, funding source, deadline, adapter
telemetry and cost ledger paths rather than bypassing them.

## Commands

```bash
pnpm install
pnpm --filter @course-ai/console dev --port 3100
pnpm smoke:dev
pnpm --filter @course-ai/console smoke:authoring
pnpm verify:dev
pnpm supabase:verify
pnpm typecheck
pnpm test
pnpm build
```

The active development-server and parallel ownership rules are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Current delivery boundary

The local vertical slice is integrated and testable. The management MCP exposes
20 shared-service tools, including course creation, authoring, validation,
diagram approval, reprocessing, publishing and rollback guarded by exact
tenant/actor grants, expiry, budget, rate and idempotency controls. The
framework-free Widget is isolated in Shadow DOM and ships below 12KB gzipped;
the intelligence core validates versioned events and produces evidence-backed,
explicitly known/partial/unknown advisory metrics. The privacy lifecycle adds
tenant-safe, resumable access/export/delete/retention contracts with live
legal-hold suppression, deletion tombstones and export integrity without
inventing unresolved retention periods. Supabase has six ordered
migrations, 25 tenant-scoped tables, forced RLS/storage policies and SQL
security acceptance tests. This machine does not have a running Docker daemon,
so the structural verifier passes but the PostgreSQL policy tests have not yet
executed locally. The identity package provides the application boundary, but
real OIDC/SAML/client-credential verification, KMS-backed signing, durable
identity/replay repositories and transactional SCIM still require production
adapters. Named production provider credentials, durable multi-replica
outboxes/idempotency stores, production object storage, deployment secrets and
live Widget/Circle installation evidence, approved retention/region policies,
privacy lifecycle production adapters and UI, and load/recovery evidence remain
environment work—not claims made by the development UI.

## Legacy input

`/Users/emielmadonna/Estie Starr` is read-only legacy input until an explicit migration plan is approved. Never commit its `.env`, recordings, provider credentials, private course media or generated vector artifacts.
