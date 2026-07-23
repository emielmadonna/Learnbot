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
  providers/     named provider adapters (future)
  mcp/           MCP registry, policy and server (future)
  testing/       shared tenancy/conformance fixtures (future)
```

The initial slice intentionally contains no provider SDK and starts no local server.

## Commands

```bash
pnpm install
pnpm --filter @course-ai/console dev --port 3100
pnpm typecheck
pnpm test
```

The active development-server and parallel ownership rules are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Legacy input

`/Users/emielmadonna/Estie Starr` is read-only legacy input until an explicit migration plan is approved. Never commit its `.env`, recordings, provider credentials, private course media or generated vector artifacts.
