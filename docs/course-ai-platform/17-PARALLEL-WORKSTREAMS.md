# Parallel Workstreams

## Concurrency policy

Start with two workers only after repository inspection. Never exceed three concurrent workers. The root integrator owns decisions, shared contracts, Git integration and independent verification.

## Initial workstreams

| Workstream | Narrow ownership | Early outputs |
|---|---|---|
| Platform control plane | schema, migrations, RLS, auth, provider/agent contracts, Vault, audit, cost and management MCP | tenant-safe application services, contracts, conformance/isolation tests and read-only MCP |
| Learning pipeline | source intake, scan/extract/clean/structure/version/chunk/embed, diagram candidates and job orchestration | idempotent staged pipeline, draft/active versions, selective re-ingest and observable job states |
| Product experience | unified Student composer/runtime plus Creator/Teacher and Admin course operations | approved prototypes, text/voice/file continuity, course editor/ops UI and state matrices |

Start Platform control plane + Product experience. Add Learning pipeline only when inspection is complete, shared-contract ownership is assigned and memory pressure is healthy. After the first vertical slice, rotate capacity within these three lanes: intelligence/diagrams attach to Learning pipeline; voice/provider adapters attach to Product experience; commercial hardening attaches to Platform control plane.

## Parallel delivery map

| Window | Platform control plane | Learning pipeline | Product experience | Integration gate |
|---|---|---|---|---|
| Weeks 1–2 | tenancy/auth/audit/cost/provider/MCP contracts | source/version/job contract review | unified composer and course/admin prototypes | approved contracts and task flows |
| Weeks 3–6 | application services, read MCP, policy | upload through versioned retrieval, selective retry | text/file vertical slice, course workspace | one tenant/course end to end |
| Weeks 6–10 | MCP mutations, budgets, provider fallback | connectors, cleanup, diagrams, intelligence inputs | voice in same thread, Creator/Admin workflow depth | private-pilot acceptance |
| Weeks 10–18 | billing/privacy/SLO/restore hardening | scale/data-quality/recovery | accessibility/performance/pilot remediation | enterprise-beta evidence |

Calendar ranges overlap deliberately. A dependent slice begins only against a versioned contract and deterministic fake; live integration evidence is still serialized at the gate.

## File and dependency discipline

- Each worker receives a bounded goal, file allowlist, acceptance rows and explicit non-goals.
- One owner edits a shared contract at a time; changes are communicated before dependents update.
- UI, API and MCP may be implemented in parallel only after one tenant-aware application-service contract owns validation, authorization, versions and job state.
- No duplicate package installation or full-repository context dump.
- Serialize dependency installation, typecheck/build, test suites, browser automation, database resets and media processing.
- Do not run local LLMs or several development servers.
- Record server `{purpose, PID, port, started_at, owner}`; stop when unused.
- Before an intensive operation, check memory pressure/processes; defer if swap or pressure is elevated.

## Integration cadence

1. Worker self-checks scoped output.
2. Root reviews diff against source docs and security/cost/tenant effects.
3. Run narrow tests, then serialized shared suite.
4. Resolve contract drift before merging another slice.
5. Update acceptance evidence and decisions; stop idle processes.

Claims from workers are evidence leads, not proof. Root reruns critical checks and visually verifies UI artifacts.
