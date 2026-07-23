import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ConsoleApiClient,
  GrantAuthorizer,
  IdempotencyStore,
  McpSafeError,
  mutationHeaders,
  parseGrantConfiguration,
  safeError,
  type MutationContext,
} from "./enterprise-control.js";

const context: MutationContext = {
  tenantId: "tenant_northstar_demo",
  actorId: "actor_creator_1",
  requestId: "request-0001",
  grantId: "grant_creator",
  grantToken: "correct-horse-battery-staple",
  idempotencyKey: "idempotency-0001",
};

const grants = JSON.stringify([
  {
    grantId: "grant_creator",
    tenantId: "tenant_northstar_demo",
    actorId: "actor_creator_1",
    tokenSha256: createHash("sha256")
      .update(context.grantToken)
      .digest("hex"),
    permissions: [
      "learning.ingestion.start",
      "learning.version.publish",
      "branding.publish",
    ],
  },
]);

test("write grants deny by default when none are configured", () => {
  const authorizer = new GrantAuthorizer(parseGrantConfiguration(undefined));
  assert.throws(
    () => authorizer.authorize(context, "branding.publish"),
    (error: unknown) =>
      error instanceof McpSafeError && error.code === "MCP_ACCESS_DENIED",
  );
});

test("write grants deny cross-tenant and cross-actor use", () => {
  const authorizer = new GrantAuthorizer(parseGrantConfiguration(grants));
  authorizer.authorize(context, "branding.publish");
  assert.throws(
    () =>
      authorizer.authorize(
        { ...context, tenantId: "tenant_other" },
        "branding.publish",
      ),
    (error: unknown) =>
      error instanceof McpSafeError &&
      error.code === "MCP_ACCESS_DENIED" &&
      error.requestId === context.requestId,
  );
  assert.throws(
    () =>
      authorizer.authorize(
        { ...context, grantToken: "incorrect-secret-value" },
        "branding.publish",
      ),
    (error: unknown) =>
      error instanceof McpSafeError && error.code === "MCP_ACCESS_DENIED",
  );
  assert.throws(
    () =>
      authorizer.authorize(
        { ...context, actorId: "actor_other" },
        "branding.publish",
      ),
    (error: unknown) =>
      error instanceof McpSafeError && error.code === "MCP_ACCESS_DENIED",
  );
});

test("malformed grant configuration fails closed", () => {
  const authorizer = new GrantAuthorizer(
    parseGrantConfiguration('[{"grantId":"partial"}]'),
  );
  assert.equal(authorizer.configurationValid, false);
  assert.throws(
    () => authorizer.authorize(context, "branding.publish"),
    (error: unknown) =>
      error instanceof McpSafeError &&
      error.code === "MCP_INVALID_CONFIGURATION",
  );
});

test("idempotent mutations share one in-flight operation and replay its result", async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const action = async () => {
    calls += 1;
    await Promise.resolve();
    return { version: 4 };
  };
  const [first, concurrent] = await Promise.all([
    store.execute(context, "publish", { version: 4 }, action),
    store.execute(context, "publish", { version: 4 }, action),
  ]);
  const replay = await store.execute(
    { ...context, requestId: "request-0002" },
    "publish",
    { version: 4 },
    action,
  );
  assert.deepEqual(first, { version: 4 });
  assert.deepEqual(concurrent, first);
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
});

test("an idempotency key cannot be replayed with different input", async () => {
  const store = new IdempotencyStore();
  await store.execute(context, "publish", { version: 4 }, async () => "ok");
  await assert.rejects(
    store.execute(context, "publish", { version: 5 }, async () => "unsafe"),
    (error: unknown) =>
      error instanceof McpSafeError &&
      error.code === "MCP_IDEMPOTENCY_CONFLICT",
  );
});

test("failed operations are not cached as successful idempotent results", async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  await assert.rejects(
    store.execute(context, "publish", { version: 4 }, async () => {
      calls += 1;
      throw new Error("temporary");
    }),
  );
  const result = await store.execute(
    context,
    "publish",
    { version: 4 },
    async () => {
      calls += 1;
      return "recovered";
    },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("control-plane failures are safe and never expose upstream secrets", async () => {
  const client = new ConsoleApiClient(
    "https://control.invalid",
    async () =>
      new Response(
        JSON.stringify({
          message: "database password super-secret and internal stack",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
  );
  let thrown: unknown;
  try {
    await client.request("/mutation", { method: "POST" }, context.requestId);
  } catch (error: unknown) {
    thrown = error;
  }
  const payload = safeError(thrown);
  assert.equal(payload.code, "MCP_UPSTREAM_REJECTED");
  assert.equal(payload.retryable, true);
  assert.equal(payload.requestId, context.requestId);
  assert.doesNotMatch(JSON.stringify(payload), /super-secret|database password/i);
});

test("mutation metadata is complete and audit friendly", () => {
  assert.deepEqual(mutationHeaders(context), {
    "x-course-ai-tenant-id": context.tenantId,
    "x-course-ai-actor-id": context.actorId,
    "x-course-ai-request-id": context.requestId,
    "x-course-ai-mcp-grant-id": context.grantId,
    "idempotency-key": context.idempotencyKey,
  });
});
