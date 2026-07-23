# Course AI management MCP

Provider-agnostic management control surface over MCP stdio. It uses the same
tenant-aware console APIs as the user interfaces; it never reads a database,
provider credential, or Vault directly.

## Tools

Read tools:

- `get_build_plan`
- `get_mcp_health`
- `list_platform_capabilities`
- `list_courses`
- `get_ingestion_job`
- `get_platform_snapshot`
- `resolve_learning_context`

Grant-controlled mutation tools:

- `start_learning_ingestion`
- `publish_learning_version`
- `publish_tenant_branding`

`get_mcp_health` reports capability and authorization readiness without exposing
grant IDs, actors, tenants, or secrets.

## Write authorization

Writes deny by default. Configure least-privilege grants through
`COURSE_AI_MCP_GRANTS`:

```json
[
  {
    "grantId": "grant_creator",
    "tenantId": "tenant_northstar_demo",
    "actorId": "actor_creator_1",
    "tokenSha256": "87cbebfeebc05f7c54ac9336c4b4bbec831227a641951a4bde7edd56020f8590",
    "permissions": [
      "learning.ingestion.start",
      "learning.version.publish",
      "branding.publish"
    ]
  }
]
```

The example digest is SHA-256 for the illustrative token
`correct-horse-battery-staple`; issue a random, high-entropy token in real
environments and store only its digest in the grant configuration.

Every mutation requires `tenantId`, `actorId`, `requestId`, `grantId`,
`grantToken`, and an `idempotencyKey`. A grant is valid only for its exact
tenant, actor, token digest, and permission. Missing, malformed, cross-tenant,
cross-actor, invalid-token, and insufficient grants fail closed. Grant data and
token digests are server-side configuration. The supplied token is used only
for constant-time authorization and is never forwarded to the control plane,
logged, returned, or included in idempotency fingerprints.

The control surface forwards tenant, actor, request, grant, and idempotency
metadata as control-plane headers and includes non-secret MCP request context in
the mutation body for audit correlation.

## Idempotency and safe failures

Mutation results are deduplicated in-process by tenant, actor, operation, and
idempotency key. Concurrent identical calls share one operation; replaying the
same key with different input is rejected. Failed operations can be retried.
Errors return JSON with a stable code, safe message, retryability, and request
ID. Raw upstream messages and stack traces are never returned to an MCP client.

The current store is intentionally process-local. Production deployment still
needs a durable shared idempotency/outbox store so restarts and multiple MCP
replicas preserve the same guarantee.

## Run and verify

```bash
pnpm --filter @course-ai/mcp-server typecheck
pnpm --filter @course-ai/mcp-server test
pnpm --filter @course-ai/mcp-server smoke
node packages/mcp-server/dist/server.js
```

The smoke test expects the shared console API at
`COURSE_AI_CONSOLE_URL` (default `http://127.0.0.1:3100`). Unit tests cover
deny-by-default authorization, cross-tenant and cross-actor denial, malformed
grant configuration, idempotent mutation replay and conflicts, audit metadata,
and safe upstream failures.
