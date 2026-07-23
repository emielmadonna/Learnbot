# Course AI management MCP

Local, read-only development MCP server over stdio.

It currently exposes:

- `get_build_plan`
- `list_platform_capabilities`
- `list_courses`
- `get_ingestion_job`

The fixtures prove protocol wiring only. Production tools must call the same tenant-aware application services as the UI/API, with authentication, policy grants, idempotency, audit and cost telemetry. They must never access the database or Vault directly.

```bash
pnpm --filter @course-ai/mcp-server build
node packages/mcp-server/dist/server.js
```

Mutating course, ingestion and publish tools are intentionally deferred until their shared application services exist.
