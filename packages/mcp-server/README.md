# Course AI management MCP

Provider-agnostic management control surface over MCP stdio. It uses the same
tenant-aware console APIs as the user interfaces; it never reads a database,
provider credential, or Vault directly.

The server now exposes eight production-data learning tools:

- `get_authenticated_learning_workspace`
- `search_authenticated_learning`
- `get_authenticated_learning_conversations`
- `start_authenticated_learning_conversation`
- `respond_in_authenticated_learning_conversation`
- `list_authenticated_quarantine_uploads`
- `create_authenticated_course_draft`
- `publish_authenticated_course`

They call authenticated `/api/learning/*` services with a standard bearer
credential. The tools can read the durable workspace, hybrid-search published
source evidence, list or start persisted conversations, record a grounded
exchange through the configured provider adapter, inspect private quarantine
jobs, create a private course draft, and publish an authorized course. The
control plane resolves the active tenant from the verified principal; the MCP
caller cannot submit or override a tenant identifier.

The 27 fixture-only tools from the original development set are hidden by
default. This includes `get_build_plan` and every tool bound to the fixed
development tenant or `/api/dev/*` routes. They are available only when the MCP
process sets the exact opt-in `COURSE_AI_MCP_FIXTURE_MODE=enabled`. Fixture
course, authoring, ingestion, branding, intelligence, and privacy operations
are not production-data or production-authorization evidence.
`get_mcp_health` remains visible in every mode and reports fixture exposure as
disabled with zero exposed tools unless the opt-in is active.

## Tools

Read tools:

- `get_build_plan`
- `get_mcp_health`
- `get_authenticated_learning_workspace` (durable, authenticated)
- `search_authenticated_learning` (durable, authenticated)
- `get_authenticated_learning_conversations` (durable, authenticated)
- `list_authenticated_quarantine_uploads` (durable, authenticated)
- `list_platform_capabilities`
- `list_courses`
- `get_ingestion_job`
- `get_platform_snapshot`
- `resolve_learning_context`
- `get_course_authoring_snapshot`
- `validate_course_draft`
- `get_intelligence_snapshot`
- `get_privacy_operations_snapshot`

Mutation tools:

- `start_authenticated_learning_conversation` (durable bearer identity)
- `respond_in_authenticated_learning_conversation` (durable bearer identity)
- `create_authenticated_course_draft` (durable bearer identity)
- `publish_authenticated_course` (durable bearer identity)
- `create_course_shell`
- `update_course_shell`
- `add_course_lesson`
- `save_lesson_content` (supports non-mutating `dryRun`)
- `approve_course_diagram`
- `publish_course_draft`
- `rollback_course_revision`
- `reprocess_learning_content`
- `start_learning_ingestion`
- `publish_learning_version`
- `publish_tenant_branding`
- `review_student_opportunity`
- `record_opportunity_feedback`
- `preview_privacy_job`
- `create_privacy_job`
- `execute_privacy_job`
- `verify_privacy_export_manifest`

`get_mcp_health` reports capability and authorization readiness without exposing
grant IDs, actors, tenants, or secrets.

## Durable learning authorization

Configure a verified user's short-lived bearer access token in the MCP process:

```bash
COURSE_AI_MCP_CONSOLE_BEARER_TOKEN="<short-lived-user-access-token>"
```

The token is forwarded only in the `Authorization: Bearer ...` request header.
It is bounded and validated before use, is never returned in MCP output, and is
not accepted as a tool argument. Missing or malformed configuration fails
closed. Because the current stdio transport has one process-wide environment,
this is a process-bound principal: run a separate MCP process per user and
rotate the token when the Supabase session refreshes.

This is a truthful authenticated learning lane, not the final remote MCP identity
architecture. Durable conversation mutations additionally require explicit,
bounded idempotency keys and send a same-origin header required by the console
mutation boundary. Grounded response availability also depends on the console's
server-side provider and conversation-operation-token configuration.
Production multi-user remote transport still requires
connection-bound token refresh, principal-filtered tool discovery, durable
grants, metering, and idempotency. The legacy mutation grants below continue to
authorize fixture operations only.

## Fixture compatibility mode

Production discovery exposes exactly nine tools: general health plus the eight
durable authenticated learning tools. To run the legacy development fixture
surface intentionally:

```bash
COURSE_AI_MCP_FIXTURE_MODE=enabled pnpm --filter @course-ai/mcp-server smoke
```

The value is exact and case-sensitive. Missing, empty, `true`, or any value
other than `enabled` leaves fixture tools undiscoverable. The smoke client also
passes this opt-in explicitly to its child MCP process. Never configure fixture
mode in a deployed production MCP process.

## Write authorization

Legacy fixture writes deny by default. Configure their least-privilege grants through
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
    ],
    "expiresAt": "2026-07-24T20:00:00.000Z",
    "budgetUsd": 10,
    "maxRequestsPerMinute": 60
  }
]
```

The example digest is SHA-256 for the illustrative token
`correct-horse-battery-staple`; issue a random, high-entropy token in real
environments and store only its digest in the grant configuration.

Every legacy fixture mutation requires `tenantId`, `actorId`, `requestId`, `grantId`,
`grantToken`, and an `idempotencyKey`. A grant is valid only for its exact
tenant, actor, token digest, and permission. Missing, malformed, cross-tenant,
cross-actor, invalid-token, expired, over-budget, and insufficient grants fail
closed. Per-grant request limits are enforced in a rolling one-minute window.
Each operation reserves its conservative estimate against the grant budget,
with replay-safe rate and budget accounting by operation and idempotency key.
Grant data and token digests are server-side configuration. The supplied token
is used only for constant-time authorization and is never forwarded to the
control plane, logged, returned, or included in idempotency fingerprints.

The control surface forwards tenant, actor, request, grant, and idempotency
metadata as control-plane headers and includes non-secret MCP request context in
the mutation body for audit correlation. Course reads and mutations call the
same courses, authoring, and ingestion API boundaries used by the console.

## Idempotency and safe failures

Mutation results are deduplicated in-process by tenant, actor, operation, and
idempotency key. Concurrent identical calls share one operation; replaying the
same key with different input is rejected. Failed operations can be retried.
Errors return JSON with a stable code, safe message, retryability, and request
ID. Raw upstream messages and stack traces are never returned to an MCP client.

The current idempotency, budget-reservation, and rate-window stores are
intentionally process-local. Production deployment still needs durable shared
idempotency/outbox and grant-metering stores so restarts and multiple MCP
replicas preserve the same guarantees. It also needs a connection-bound
principal/registry adapter to hide tools the connected principal cannot
discover; this development stdio server lists its schemas but still denies
unauthorized invocation before the control plane is called.

Intelligence review requires `intelligence.opportunity.review`. Privacy grants
are separated by risk: `privacy.access_export.manage`,
`privacy.delete.manage`, `privacy.retention.manage`, and
`privacy.manifest.verify`. Delete and retention creation also require the exact
one-use preview token and confirmation phrase returned by
`preview_privacy_job`; an MCP grant alone cannot bypass that confirmation.

## Run and verify

```bash
pnpm --filter @course-ai/mcp-server typecheck
pnpm --filter @course-ai/mcp-server test
pnpm --filter @course-ai/mcp-server smoke
node packages/mcp-server/dist/server.js
```

The fixture smoke test expects the shared console API at
`COURSE_AI_CONSOLE_URL` (default `http://127.0.0.1:3100`). Unit tests cover
deny-by-default authorization, cross-tenant and cross-actor denial, malformed
grant configuration, expiry and budget denial, idempotent reservation and
rate enforcement, mutation replay/conflicts, bounded output, audit metadata,
and safe upstream failures. The stdio smoke verifies discovery of all 36 tools.
When a durable bearer is provided, it also reads the authenticated workspace,
searches published learning, and reads persisted conversations. The fixture
portion continues to verify shared authoring, intelligence, and privacy
snapshots, authorized authoring, course, feedback, and manifest operations, and
a denied write.
