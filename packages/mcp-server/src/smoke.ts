import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const grantToken = "mcp-smoke-authorized-grant-token";
process.env.COURSE_AI_MCP_GRANTS = JSON.stringify([
  {
    grantId: "grant_smoke_creator",
    tenantId: "tenant_northstar_demo",
    actorId: "actor_creator_smoke",
    tokenSha256: createHash("sha256").update(grantToken).digest("hex"),
    permissions: [
      "course.create",
      "course.authoring.edit",
      "branding.publish"
    ],
    expiresAt: "2099-01-01T00:00:00.000Z",
    budgetUsd: 1,
    maxRequestsPerMinute: 100
  }
]);

const client = new Client({
  name: "course-ai-smoke-client",
  version: "0.1.0"
});
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  env: {
    ...getDefaultEnvironment(),
    COURSE_AI_MCP_GRANTS: process.env.COURSE_AI_MCP_GRANTS,
  },
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
    "get_course_authoring_snapshot",
    "validate_course_draft",
    "create_course_shell",
    "update_course_shell",
    "add_course_lesson",
    "save_lesson_content",
    "approve_course_diagram",
    "publish_course_draft",
    "rollback_course_revision",
    "reprocess_learning_content",
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

  const authoring = await client.callTool({
    name: "get_course_authoring_snapshot",
    arguments: { tenantId: "tenant_northstar_demo" }
  });
  if (!authoring.structuredContent || authoring.isError) {
    throw new Error("Authoring snapshot MCP call did not return structured content");
  }
  const authoringContent = authoring.structuredContent as {
    course?: { version?: number };
    lesson?: { lessonId?: string };
    editorContent?: string;
  };
  const currentVersion = authoringContent.course?.version;
  const lessonId = authoringContent.lesson?.lessonId;
  if (
    typeof currentVersion !== "number" ||
    typeof lessonId !== "string" ||
    typeof authoringContent.editorContent !== "string"
  ) {
    throw new Error("Authoring snapshot omitted its versioned lesson target");
  }

  const dryRun = await client.callTool({
    name: "save_lesson_content",
    arguments: {
      tenantId: "tenant_northstar_demo",
      actorId: "actor_creator_smoke",
      requestId: "request-smoke-dry-run",
      grantId: "grant_smoke_creator",
      grantToken,
      idempotencyKey: "idempotency-smoke-dry-run",
      lessonId,
      expectedVersion: currentVersion,
      format: "plain_text",
      content: authoringContent.editorContent,
      dryRun: true
    }
  });
  const dryRunContent = dryRun.structuredContent as
    | { dryRun?: boolean }
    | undefined;
  if (
    !dryRunContent ||
    dryRun.isError ||
    dryRunContent.dryRun !== true
  ) {
    throw new Error(
      `Authorized MCP authoring dry-run failed: ${JSON.stringify(dryRun)}`,
    );
  }

  const createdCourse = await client.callTool({
    name: "create_course_shell",
    arguments: {
      tenantId: "tenant_northstar_demo",
      actorId: "actor_creator_smoke",
      requestId: "request-smoke-create-course",
      grantId: "grant_smoke_creator",
      grantToken,
      idempotencyKey: "idempotency-smoke-create-course",
      title: "MCP Smoke Course",
      slug: "mcp-smoke-course",
      description: "Created through the tenant-aware management MCP smoke."
    }
  });
  const createdContent = createdCourse.structuredContent as
    | { course?: { title?: string; status?: string } }
    | undefined;
  if (
    createdCourse.isError ||
    createdContent?.course?.title !== "MCP Smoke Course" ||
    createdContent.course.status !== "draft"
  ) {
    throw new Error(
      `Authorized MCP course creation failed: ${JSON.stringify(createdCourse)}`,
    );
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
    `MCP smoke passed: ${expectedTools.length} tools, shared API snapshots, authorized authoring dry-run/course create and denied write`
  );
} finally {
  await client.close();
}
