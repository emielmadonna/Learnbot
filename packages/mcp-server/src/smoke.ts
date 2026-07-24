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
      "branding.publish",
      "intelligence.opportunity.review",
      "privacy.access_export.manage",
      "privacy.manifest.verify"
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
    COURSE_AI_MCP_FIXTURE_MODE: "enabled",
    COURSE_AI_MCP_GRANTS: process.env.COURSE_AI_MCP_GRANTS,
    ...(process.env.COURSE_AI_CONSOLE_URL
      ? { COURSE_AI_CONSOLE_URL: process.env.COURSE_AI_CONSOLE_URL }
      : {}),
    ...(process.env.COURSE_AI_MCP_CONSOLE_BEARER_TOKEN
      ? {
          COURSE_AI_MCP_CONSOLE_BEARER_TOKEN:
            process.env.COURSE_AI_MCP_CONSOLE_BEARER_TOKEN,
        }
      : {}),
  },
});

await client.connect(transport);

try {
  const tools = await client.listTools();
  const expectedTools = [
    "get_build_plan",
    "get_mcp_health",
    "get_authenticated_learning_workspace",
    "search_authenticated_learning",
    "get_authenticated_learning_conversations",
    "start_authenticated_learning_conversation",
    "respond_in_authenticated_learning_conversation",
    "list_authenticated_quarantine_uploads",
    "create_authenticated_course_draft",
    "publish_authenticated_course",
    "list_platform_capabilities",
    "list_courses",
    "get_ingestion_job",
    "get_platform_snapshot",
    "resolve_learning_context",
    "get_course_authoring_snapshot",
    "validate_course_draft",
    "get_intelligence_snapshot",
    "review_student_opportunity",
    "record_opportunity_feedback",
    "get_privacy_operations_snapshot",
    "preview_privacy_job",
    "create_privacy_job",
    "execute_privacy_job",
    "verify_privacy_export_manifest",
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

  if (process.env.COURSE_AI_MCP_CONSOLE_BEARER_TOKEN) {
    const durableWorkspace = await client.callTool({
      name: "get_authenticated_learning_workspace",
      arguments: {},
    });
    if (!durableWorkspace.structuredContent || durableWorkspace.isError) {
      throw new Error(
        "Authenticated durable workspace MCP call did not return structured content",
      );
    }

    const durableSearch = await client.callTool({
      name: "search_authenticated_learning",
      arguments: { query: "learning", limit: 2 },
    });
    if (!durableSearch.structuredContent || durableSearch.isError) {
      throw new Error(
        "Authenticated durable search MCP call did not return structured content",
      );
    }

    const durableConversations = await client.callTool({
      name: "get_authenticated_learning_conversations",
      arguments: {},
    });
    if (
      !durableConversations.structuredContent ||
      durableConversations.isError
    ) {
      throw new Error(
        "Authenticated durable conversation MCP call did not return structured content",
      );
    }
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

  const intelligence = await client.callTool({
    name: "get_intelligence_snapshot",
    arguments: { tenantId: "tenant_northstar_demo" }
  });
  const intelligenceContent = intelligence.structuredContent as
    | { snapshot?: { opportunity?: { id?: string } } }
    | undefined;
  const opportunityId = intelligenceContent?.snapshot?.opportunity?.id;
  if (
    intelligence.isError ||
    typeof opportunityId !== "string" ||
    opportunityId.length === 0
  ) {
    throw new Error(
      `Intelligence snapshot omitted its tenant-scoped opportunity: ${JSON.stringify(intelligence)}`,
    );
  }

  const feedback = await client.callTool({
    name: "record_opportunity_feedback",
    arguments: {
      tenantId: "tenant_northstar_demo",
      actorId: "actor_creator_smoke",
      requestId: "request-smoke-intelligence-feedback",
      grantId: "grant_smoke_creator",
      grantToken,
      idempotencyKey: "idempotency-smoke-intelligence-feedback",
      opportunityId,
      kind: "helpful",
      note: "Deterministic MCP integration evidence."
    }
  });
  if (!feedback.structuredContent || feedback.isError) {
    throw new Error(
      `Authorized MCP intelligence feedback failed: ${JSON.stringify(feedback)}`,
    );
  }

  const privacy = await client.callTool({
    name: "get_privacy_operations_snapshot",
    arguments: { tenantId: "tenant_northstar_demo" }
  });
  const privacyContent = privacy.structuredContent as
    | { manifests?: Array<{ manifestId?: string }> }
    | undefined;
  const manifestId = privacyContent?.manifests?.[0]?.manifestId;
  if (
    privacy.isError ||
    typeof manifestId !== "string" ||
    manifestId.length === 0
  ) {
    throw new Error(
      `Privacy snapshot omitted its fixture export manifest: ${JSON.stringify(privacy)}`,
    );
  }

  const manifestVerification = await client.callTool({
    name: "verify_privacy_export_manifest",
    arguments: {
      tenantId: "tenant_northstar_demo",
      actorId: "actor_creator_smoke",
      requestId: "request-smoke-privacy-manifest",
      grantId: "grant_smoke_creator",
      grantToken,
      idempotencyKey: "idempotency-smoke-privacy-manifest",
      manifestId
    }
  });
  if (
    !manifestVerification.structuredContent ||
    manifestVerification.isError
  ) {
    throw new Error(
      `Authorized MCP privacy verification failed: ${JSON.stringify(manifestVerification)}`,
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
    `MCP smoke passed: ${expectedTools.length} tools, shared authoring/intelligence/privacy snapshots, authorized authoring/course/feedback/privacy writes and denied write`
  );
} finally {
  await client.close();
}
