# Parallel Workstreams

## Concurrency policy

Start with two workers only after repository inspection. Never exceed three concurrent workers. The root integrator owns decisions, shared contracts, Git integration and independent verification.

## Initial workstreams

| Workstream | Narrow ownership | Early outputs |
|---|---|---|
| Foundations & security | schema, migrations, RLS, provider contracts, Vault, isolation, audit, cost | migrations, contracts, conformance and isolation tests |
| UX & prototype | sitemap, flows, design system, required mockups | approved Student/Creator/Admin prototypes and state matrices |
| Runtime architecture | Edge contracts, retrieval, Widget plan, voice sessions, Events, MCP registry | interface packages, sequence/state specs and fake adapters |

Start Foundations + UX. Add Runtime only when inspection is complete, shared-contract ownership is assigned and memory pressure is healthy.

## File and dependency discipline

- Each worker receives a bounded goal, file allowlist, acceptance rows and explicit non-goals.
- One owner edits a shared contract at a time; changes are communicated before dependents update.
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
