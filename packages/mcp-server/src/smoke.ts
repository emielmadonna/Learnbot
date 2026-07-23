import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "course-ai-smoke-client",
  version: "0.1.0"
});
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"]
});

await client.connect(transport);

try {
  const tools = await client.listTools();
  const expectedTools = [
    "get_build_plan",
    "get_mcp_health",
    "list_platform_capabilities",
    "list_courses",
    "get_ingestion_job",
    "get_platform_snapshot",
    "resolve_learning_context",
    "start_learning_ingestion",
    "publish_learning_version",
    "publish_tenant_branding"
  ];
  const names = tools.tools.map((tool) => tool.name);

  for (const expected of expectedTools) {
    if (!names.includes(expected)) {
      throw new Error(`Missing MCP tool: ${expected}`);
    }
  }

  const plan = await client.callTool({
    name: "get_build_plan",
    arguments: {}
  });

  if (!plan.structuredContent || plan.isError) {
    throw new Error("Build-plan MCP call did not return structured content");
  }

  const health = await client.callTool({
    name: "get_mcp_health",
    arguments: {}
  });

  if (!health.structuredContent || health.isError) {
    throw new Error("MCP health call did not return structured content");
  }

  const snapshot = await client.callTool({
    name: "get_platform_snapshot",
    arguments: { tenantId: "tenant_northstar_demo" }
  });

  if (!snapshot.structuredContent || snapshot.isError) {
    throw new Error("Platform snapshot MCP call did not return structured content");
  }

  const deniedMutation = await client.callTool({
    name: "publish_tenant_branding",
    arguments: {
      tenantId: "tenant_northstar_demo",
      actorId: "actor_unauthorized_smoke",
      requestId: "request-smoke-denied",
      grantId: "grant_missing",
      grantToken: "definitely-not-authorized",
      idempotencyKey: "idempotency-smoke-denied",
      assistantName: "Unauthorized",
      primary: "#000000",
      accent: "#000000",
      surface: "#ffffff",
      welcome: "This write must never happen.",
      voice: "Harbor",
      attribution: true,
      privacyLink: true
    }
  });

  const deniedText = JSON.stringify(deniedMutation.content);
  if (
    !deniedMutation.isError ||
    !deniedText.includes("MCP_ACCESS_DENIED")
  ) {
    throw new Error("Unauthorized MCP mutation did not fail closed safely");
  }

  console.log(
    `MCP smoke passed: ${expectedTools.length} tools, health, shared API snapshot and denied write`
  );
} finally {
  await client.close();
}
