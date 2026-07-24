import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
const durableTools = [
  "get_mcp_health",
  "get_authenticated_learning_workspace",
  "search_authenticated_learning",
  "get_authenticated_learning_conversations",
  "start_authenticated_learning_conversation",
  "respond_in_authenticated_learning_conversation",
  "list_authenticated_quarantine_uploads",
  "create_authenticated_course_draft",
  "publish_authenticated_course",
].sort();

async function inspectServer(fixtureMode?: string) {
  const modeLabel = fixtureMode ?? "default";
  const environment = { ...getDefaultEnvironment() };
  delete environment.COURSE_AI_MCP_FIXTURE_MODE;
  const client = new Client({
    name: `course-ai-discovery-${modeLabel}`,
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...environment,
      ...(fixtureMode
        ? { COURSE_AI_MCP_FIXTURE_MODE: fixtureMode }
        : {}),
    },
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const health = await client.callTool({
      name: "get_mcp_health",
      arguments: {},
    });
    return {
      names: tools.tools.map((tool) => tool.name).sort(),
      health: health.structuredContent as
        | {
          legacyDevelopmentSurface?: {
            fixtureModeEnabled?: boolean;
            exposedToolCount?: number;
          };
          writeAuthorization?: {
            fixtureModeEnabled?: boolean;
            configuredGrantCount?: number;
            permissions?: string[];
          };
          }
        | undefined,
    };
  } finally {
    await client.close();
  }
}

test("default production discovery exposes only health and durable tools", async () => {
  const discovered = await inspectServer();
  assert.deepEqual(discovered.names, durableTools);
  assert.deepEqual(discovered.health?.legacyDevelopmentSurface, {
    dataMode: "fixture",
    routePrefix: "/api/dev",
    fixtureModeEnabled: false,
    exposedToolCount: 0,
    availableFixtureToolCount: 27,
    productionEvidence: false,
  });
  assert.deepEqual(discovered.health?.writeAuthorization, {
    denyByDefault: true,
    fixtureModeEnabled: false,
    configurationValid: true,
    configuredGrantCount: 0,
    permissions: [],
  });
});

test("exact fixture opt-in exposes the legacy development tools", async () => {
  const discovered = await inspectServer("enabled");
  assert.equal(discovered.names.length, 36);
  assert.ok(discovered.names.includes("get_build_plan"));
  assert.ok(discovered.names.includes("list_courses"));
  assert.ok(discovered.names.includes("publish_tenant_branding"));
  assert.equal(
    discovered.health?.legacyDevelopmentSurface?.fixtureModeEnabled,
    true,
  );
  assert.equal(
    discovered.health?.legacyDevelopmentSurface?.exposedToolCount,
    27,
  );
});

test("non-exact fixture values remain production-safe", async () => {
  const discovered = await inspectServer("true");
  assert.deepEqual(discovered.names, durableTools);
  assert.equal(
    discovered.health?.legacyDevelopmentSurface?.fixtureModeEnabled,
    false,
  );
  assert.equal(
    discovered.health?.legacyDevelopmentSurface?.exposedToolCount,
    0,
  );
});
