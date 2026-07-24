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
      "course.create",
      "course.update",
      "course.authoring.edit",
      "course.authoring.diagram.approve",
      "course.authoring.publish",
      "course.authoring.rollback",
      "intelligence.opportunity.review",
      "privacy.access_export.manage",
      "privacy.delete.manage",
      "privacy.retention.manage",
      "privacy.manifest.verify",
      "learning.ingestion.start",
      "learning.version.publish",
      "branding.publish",
    ],
    expiresAt: "2099-01-01T00:00:00.000Z",
    budgetUsd: 2,
    maxRequestsPerMinute: 100,
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

test("expired grants and over-budget mutations fail before invocation", () => {
  const expired = JSON.stringify([
    {
      grantId: "grant_creator",
      tenantId: context.tenantId,
      actorId: context.actorId,
      tokenSha256: createHash("sha256")
        .update(context.grantToken)
        .digest("hex"),
      permissions: ["branding.publish"],
      expiresAt: "2025-01-01T00:00:00.000Z",
      budgetUsd: 1,
      maxRequestsPerMinute: 100,
    },
  ]);
  const expiredAuthorizer = new GrantAuthorizer(
    parseGrantConfiguration(expired),
  );
  assert.throws(
    () =>
      expiredAuthorizer.authorize(context, "branding.publish", {
        operation: "branding",
        estimatedCostUsd: 0.01,
        nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    (error: unknown) =>
      error instanceof McpSafeError && error.code === "MCP_ACCESS_DENIED",
  );

  const budgeted = JSON.stringify([
    {
      grantId: "grant_creator",
      tenantId: context.tenantId,
      actorId: context.actorId,
      tokenSha256: createHash("sha256")
        .update(context.grantToken)
        .digest("hex"),
      permissions: ["branding.publish"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      budgetUsd: 0.015,
      maxRequestsPerMinute: 100,
    },
  ]);
  const budgetAuthorizer = new GrantAuthorizer(
    parseGrantConfiguration(budgeted),
  );
  budgetAuthorizer.authorize(context, "branding.publish", {
    operation: "branding-1",
    estimatedCostUsd: 0.01,
  });
  assert.throws(
    () =>
      budgetAuthorizer.authorize(
        { ...context, idempotencyKey: "idempotency-0002" },
        "branding.publish",
        {
          operation: "branding-2",
          estimatedCostUsd: 0.01,
        },
      ),
    (error: unknown) =>
      error instanceof McpSafeError && error.code === "MCP_ACCESS_DENIED",
  );
});

test("budget reservation is idempotent for the same operation and key", () => {
  const authorizer = new GrantAuthorizer(parseGrantConfiguration(grants));
  authorizer.authorize(context, "branding.publish", {
    operation: "publish-branding",
    estimatedCostUsd: 1.5,
  });
  authorizer.authorize(
    { ...context, requestId: "request-0002" },
    "branding.publish",
    {
      operation: "publish-branding",
      estimatedCostUsd: 1.5,
    },
  );
  assert.throws(
    () =>
      authorizer.authorize(
        { ...context, idempotencyKey: "idempotency-0003" },
        "branding.publish",
        {
          operation: "publish-branding",
          estimatedCostUsd: 1.5,
        },
      ),
    McpSafeError,
  );
});

test("grant rate limiting does not count an idempotent replay twice", () => {
  const limited = JSON.stringify([
    {
      grantId: "grant_creator",
      tenantId: context.tenantId,
      actorId: context.actorId,
      tokenSha256: createHash("sha256")
        .update(context.grantToken)
        .digest("hex"),
      permissions: ["branding.publish"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      budgetUsd: 10,
      maxRequestsPerMinute: 1,
    },
  ]);
  const authorizer = new GrantAuthorizer(parseGrantConfiguration(limited));
  const nowMs = Date.parse("2026-07-23T12:00:00.000Z");
  authorizer.authorize(context, "branding.publish", {
    operation: "publish-branding",
    estimatedCostUsd: 0.01,
    nowMs,
  });
  assert.doesNotThrow(() =>
    authorizer.authorize(
      { ...context, requestId: "request-replay" },
      "branding.publish",
      {
        operation: "publish-branding",
        estimatedCostUsd: 0.01,
        nowMs,
      },
    ),
  );
  assert.throws(
    () =>
      authorizer.authorize(
        {
          ...context,
          requestId: "request-limited",
          idempotencyKey: "idempotency-limited",
        },
        "branding.publish",
        {
          operation: "publish-branding-again",
          estimatedCostUsd: 0.01,
          nowMs,
        },
      ),
    (error: unknown) =>
      error instanceof McpSafeError &&
      error.code === "MCP_ACCESS_DENIED" &&
      error.retryable,
  );
  assert.doesNotThrow(() =>
    authorizer.authorize(
      {
        ...context,
        requestId: "request-next-window",
        idempotencyKey: "idempotency-next-window",
      },
      "branding.publish",
      {
        operation: "publish-branding-next-window",
        estimatedCostUsd: 0.01,
        nowMs: nowMs + 60_001,
      },
    ),
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

test("oversized control-plane output is rejected before reaching the MCP client", async () => {
  const client = new ConsoleApiClient(
    "https://control.invalid",
    async () =>
      new Response(JSON.stringify({ value: "x".repeat(512) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    128,
  );
  await assert.rejects(
    client.request("/large", {}, context.requestId),
    (error: unknown) =>
      error instanceof McpSafeError &&
      error.code === "MCP_UPSTREAM_REJECTED" &&
      /safe limit/i.test(error.message),
  );
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
