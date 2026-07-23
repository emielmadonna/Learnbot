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
    "list_platform_capabilities",
    "list_courses",
    "get_ingestion_job"
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

  console.log(`MCP smoke passed: ${expectedTools.length} tools and build plan`);
} finally {
  await client.close();
}
