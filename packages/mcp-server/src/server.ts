#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CAPABILITIES } from "@course-ai/contracts";
import * as z from "zod/v4";
import {
  buildPlan,
  DEVELOPMENT_TENANT_ID
} from "./demo-data.js";
import {
  ConsoleApiClient,
  GrantAuthorizer,
  IdempotencyStore,
  mutationHeaders,
  parseGrantConfiguration,
  safeError,
  WRITE_PERMISSIONS,
  type MutationContext,
  type SafeErrorPayload,
  type WritePermission
} from "./enterprise-control.js";

const server = new McpServer({
  name: "course-ai-management",
  version: "0.1.0"
});

const consoleBaseUrl =
  process.env.COURSE_AI_CONSOLE_URL ?? "http://127.0.0.1:3100";
const consoleClient = new ConsoleApiClient(consoleBaseUrl);
const authorizer = new GrantAuthorizer(
  parseGrantConfiguration(process.env.COURSE_AI_MCP_GRANTS)
);
const idempotencyStore = new IdempotencyStore();

async function consoleRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return consoleClient.request<T>(path, {
    ...(init?.method ? { method: init.method } : {}),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
    ...(init?.headers
      ? { headers: Object.fromEntries(new Headers(init.headers).entries()) }
      : {})
  });
}

function result<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function errorResult(error: unknown, requestId?: string) {
  const payload: { error: SafeErrorPayload } = {
    error: safeError(error, requestId)
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
  };
}

const tenantInput = {
  tenantId: z
    .literal(DEVELOPMENT_TENANT_ID)
    .describe("Authorized development tenant identifier")
};

const mutationContextInput = {
  tenantId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128),
  requestId: z.string().min(8).max(128),
  grantId: z.string().min(1).max(128),
  grantToken: z.string().min(16).max(512),
  idempotencyKey: z.string().min(8).max(256)
};

const authoringSnapshotOutput = {
  course: z.record(z.string(), z.unknown()),
  lesson: z.record(z.string(), z.unknown()),
  editorContent: z.string(),
  validation: z.record(z.string(), z.unknown()),
  publishValidation: z.record(z.string(), z.unknown()),
  revisions: z.array(z.record(z.string(), z.unknown())),
  diagramCandidate: z.record(z.string(), z.unknown())
};

function contextFrom(input: {
  tenantId: string;
  actorId: string;
  requestId: string;
  grantId: string;
  grantToken: string;
  idempotencyKey: string;
}): MutationContext {
  return input;
}

async function authorizedMutation<T>(
  context: MutationContext,
  permission: WritePermission,
  operation: string,
  input: unknown,
  action: () => Promise<T>,
  estimatedCostUsd = 0,
): Promise<T> {
  authorizer.authorize(context, permission, {
    operation,
    estimatedCostUsd,
  });
  return idempotencyStore.execute(context, operation, input, action);
}

function controlPlaneMutationBody(
  context: MutationContext,
  input: Record<string, unknown>,
) {
  return JSON.stringify({
    ...input,
    tenantId: context.tenantId,
    idempotencyKey: context.idempotencyKey,
    mcpContext: {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestId: context.requestId,
      grantId: context.grantId,
    },
  });
}

async function authorizedConsoleMutation<T>(
  context: MutationContext,
  permission: WritePermission,
  operation: string,
  path: string,
  input: Record<string, unknown>,
  estimatedCostUsd: number,
): Promise<T> {
  return authorizedMutation(
    context,
    permission,
    operation,
    input,
    () =>
      consoleClient.request<T>(
        path,
        {
          method: "POST",
          headers: mutationHeaders(context),
          body: controlPlaneMutationBody(context, input),
        },
        context.requestId,
      ),
    estimatedCostUsd,
  );
}

server.registerTool(
  "get_build_plan",
  {
    title: "Get development build plan",
    description:
      "Read the current parallel development lanes and vertical-slice boundary.",
    inputSchema: {},
    outputSchema: {
      sprint: z.string(),
      sharedConsole: z.string(),
      lanes: z.array(z.string()),
      boundary: z.string()
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => result({ ...buildPlan, lanes: [...buildPlan.lanes] })
);

server.registerTool(
  "get_mcp_health",
  {
    title: "Get MCP control-surface health",
    description:
      "Discover control-surface capabilities and whether least-privilege write grants are configured, without exposing grant identities or secrets.",
    inputSchema: {},
    outputSchema: {
      status: z.enum(["ready", "read_only", "misconfigured"]),
      transport: z.literal("stdio"),
      consoleBaseUrl: z.string(),
      writeAuthorization: z.object({
        denyByDefault: z.literal(true),
        configurationValid: z.boolean(),
        configuredGrantCount: z.number(),
        permissions: z.array(z.string())
      }),
      safeguards: z.array(z.string())
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () =>
    result({
      status: !authorizer.configurationValid
        ? ("misconfigured" as const)
        : authorizer.configuredGrantCount > 0
          ? ("ready" as const)
          : ("read_only" as const),
      transport: "stdio" as const,
      consoleBaseUrl,
      writeAuthorization: {
        denyByDefault: true as const,
        configurationValid: authorizer.configurationValid,
        configuredGrantCount: authorizer.configuredGrantCount,
        permissions: [...WRITE_PERMISSIONS]
      },
      safeguards: [
        "tenant-and-actor-bound grants",
        "grant expiry, rate limits and replay-safe budget reservation",
        "request correlation metadata",
        "mutation idempotency",
        "bounded input and output",
        "safe upstream errors"
      ]
    })
);

server.registerTool(
  "list_platform_capabilities",
  {
    title: "List platform capabilities",
    description:
      "Read the provider-neutral capabilities understood by the platform contracts.",
    inputSchema: tenantInput,
    outputSchema: {
      tenantId: z.string(),
      capabilities: z.array(z.string())
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ tenantId }) =>
    result({ tenantId, capabilities: [...CAPABILITIES] })
);

server.registerTool(
  "list_courses",
  {
    title: "List courses",
    description:
      "Read course summaries for the explicitly authorized development tenant.",
    inputSchema: tenantInput,
    outputSchema: {
      tenantId: z.string(),
      courses: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ tenantId }) => {
    const response = await consoleRequest<{
      courses: Record<string, unknown>[];
    }>("/api/dev/courses");
    return result({
      tenantId,
      courses: response.courses
    });
  }
);

server.registerTool(
  "get_ingestion_job",
  {
    title: "Get ingestion job",
    description:
      "Read a tenant-scoped ingestion job and its current stage from the development fixture.",
    inputSchema: {
      ...tenantInput,
      jobId: z.string().min(1).max(128)
    },
    outputSchema: {
      found: z.boolean(),
      job: z.record(z.string(), z.unknown()).optional()
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ tenantId, jobId }) => {
    const snapshot = await consoleRequest<{
      initialJob?: Record<string, unknown>;
    }>("/api/dev/ingestion");
    const job =
      snapshot.initialJob?.jobId === jobId ? snapshot.initialJob : undefined;
    return job
      ? result({ found: true, job: { ...job, tenantId } })
      : result({ found: false });
  }
);

server.registerTool(
  "get_platform_snapshot",
  {
    title: "Get tenant platform snapshot",
    description:
      "Read the tenant, published branding, courses, ingestion jobs, audit summary, cost summary and active knowledge version through the same API used by the console.",
    inputSchema: tenantInput,
    outputSchema: {
      tenantId: z.string(),
      tenant: z.record(z.string(), z.unknown()),
      branding: z.record(z.string(), z.unknown()),
      courses: z.array(z.record(z.string(), z.unknown())),
      jobs: z.array(z.record(z.string(), z.unknown())),
      audit: z.array(z.record(z.string(), z.unknown())),
      cost: z.record(z.string(), z.unknown()),
      knowledge: z.record(z.string(), z.unknown())
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ tenantId }) => {
    const snapshot = await consoleRequest<{
      tenant: Record<string, unknown>;
      branding: Record<string, unknown>;
      courses: Record<string, unknown>[];
      jobs: Record<string, unknown>[];
      audit: Record<string, unknown>[];
      cost: Record<string, unknown>;
      knowledge: Record<string, unknown>;
    }>("/api/dev/platform");
    return result({
      tenantId,
      tenant: snapshot.tenant,
      branding: snapshot.branding,
      courses: snapshot.courses,
      jobs: snapshot.jobs,
      audit: snapshot.audit,
      cost: snapshot.cost,
      knowledge: snapshot.knowledge
    });
  }
);

server.registerTool(
  "resolve_learning_context",
  {
    title: "Resolve current learning context",
    description:
      "Resolve an authorized tenant URL to its verified course, module, lesson and learner progress context.",
    inputSchema: {
      ...tenantInput,
      url: z.string().min(1).max(2_048),
      title: z.string().max(500).optional(),
      studentId: z.string().max(128).optional()
    },
    outputSchema: {
      context: z.record(z.string(), z.unknown())
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ url, title, studentId }) => {
    const context = await consoleRequest<Record<string, unknown>>(
      "/api/dev/context",
      {
        method: "POST",
        body: JSON.stringify({ url, title, studentId })
      }
    );
    return result({ context });
  }
);

server.registerTool(
  "get_course_authoring_snapshot",
  {
    title: "Get course authoring snapshot",
    description:
      "Read the current course draft, selected lesson, validation results, diagram candidate and immutable revisions from the same authoring service used by the Learning console.",
    inputSchema: {
      ...tenantInput,
      lessonId: z.string().min(1).max(128).optional()
    },
    outputSchema: authoringSnapshotOutput,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ lessonId }) => {
    const suffix = lessonId
      ? `?lessonId=${encodeURIComponent(lessonId)}`
      : "";
    const snapshot = await consoleRequest<
      Record<string, unknown>
    >(`/api/dev/authoring${suffix}`);
    return result(snapshot);
  }
);

server.registerTool(
  "validate_course_draft",
  {
    title: "Validate course draft",
    description:
      "Return the current draft and publish validation results without mutating content.",
    inputSchema: tenantInput,
    outputSchema: {
      courseId: z.string(),
      version: z.number(),
      status: z.string(),
      validation: z.record(z.string(), z.unknown()),
      publishValidation: z.record(z.string(), z.unknown())
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async () => {
    const snapshot = await consoleRequest<{
      course: { courseId: string; version: number; status: string };
      validation: Record<string, unknown>;
      publishValidation: Record<string, unknown>;
    }>("/api/dev/authoring");
    return result({
      courseId: snapshot.course.courseId,
      version: snapshot.course.version,
      status: snapshot.course.status,
      validation: snapshot.validation,
      publishValidation: snapshot.publishValidation
    });
  }
);

server.registerTool(
  "create_course_shell",
  {
    title: "Create course shell",
    description:
      "Create a private tenant course draft through the same application service used by the Creator UI.",
    inputSchema: {
      ...mutationContextInput,
      title: z.string().min(1).max(160),
      slug: z.string().min(1).max(160).optional(),
      description: z.string().max(2_000).optional()
    },
    outputSchema: {
      course: z.record(z.string(), z.unknown())
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const response = await authorizedConsoleMutation<{
        course: Record<string, unknown>;
      }>(
        context,
        "course.create",
        "create_course_shell",
        "/api/dev/courses",
        {
          action: "create",
          title: input.title,
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.description ? { description: input.description } : {})
        },
        0.02
      );
      return result(response);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "update_course_shell",
  {
    title: "Update course shell",
    description:
      "Update course metadata with optimistic version protection through the shared application service.",
    inputSchema: {
      ...mutationContextInput,
      courseId: z.string().min(1).max(128),
      expectedVersion: z.number().int().positive(),
      title: z.string().min(1).max(160).optional(),
      slug: z.string().min(1).max(160).optional(),
      description: z.string().max(2_000).nullable().optional()
    },
    outputSchema: {
      course: z.record(z.string(), z.unknown())
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const response = await authorizedConsoleMutation<{
        course: Record<string, unknown>;
      }>(
        context,
        "course.update",
        "update_course_shell",
        "/api/dev/courses",
        {
          action: "update",
          courseId: input.courseId,
          expectedVersion: input.expectedVersion,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.description === undefined
            ? {}
            : { description: input.description })
        },
        0.01
      );
      return result(response);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "add_course_lesson",
  {
    title: "Add course lesson",
    description:
      "Add a lesson to the active course authoring draft with optimistic version protection.",
    inputSchema: {
      ...mutationContextInput,
      expectedVersion: z.number().int().positive(),
      title: z.string().min(1).max(160)
    },
    outputSchema: authoringSnapshotOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const snapshot = await authorizedConsoleMutation<
        Record<string, unknown>
      >(
        context,
        "course.authoring.edit",
        "add_course_lesson",
        "/api/dev/authoring",
        {
          action: "add_lesson",
          expectedVersion: input.expectedVersion,
          title: input.title
        },
        0.02
      );
      return result(snapshot);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "save_lesson_content",
  {
    title: "Save or preview lesson content",
    description:
      "Preview the exact lesson target or import sanitized plain text/Markdown into a versioned draft. Dry-run never mutates.",
    inputSchema: {
      ...mutationContextInput,
      lessonId: z.string().min(1).max(128),
      expectedVersion: z.number().int().positive(),
      format: z.enum(["plain_text", "markdown"]),
      content: z.string().min(1).max(250_000),
      dryRun: z.boolean().default(false)
    },
    outputSchema: {
      dryRun: z.boolean().optional(),
      target: z.record(z.string(), z.unknown()).optional(),
      course: z.record(z.string(), z.unknown()).optional(),
      lesson: z.record(z.string(), z.unknown()).optional(),
      editorContent: z.string().optional(),
      validation: z.record(z.string(), z.unknown()).optional(),
      publishValidation: z.record(z.string(), z.unknown()).optional(),
      revisions: z.array(z.record(z.string(), z.unknown())).optional(),
      diagramCandidate: z.record(z.string(), z.unknown()).optional()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    const mutation = {
      action: "import",
      lessonId: input.lessonId,
      expectedVersion: input.expectedVersion,
      format: input.format,
      content: input.content
    };
    try {
      if (input.dryRun) {
        return result(
          await authorizedMutation(
            context,
            "course.authoring.edit",
            "save_lesson_content:dry_run",
            mutation,
            async () => {
              const snapshot = await consoleRequest<{
                course: { version: number };
                lesson: { lessonId: string };
              }>(
                `/api/dev/authoring?lessonId=${encodeURIComponent(input.lessonId)}`
              );
              return {
                dryRun: true,
                target: {
                  lessonId: snapshot.lesson.lessonId,
                  currentVersion: snapshot.course.version,
                  expectedVersion: input.expectedVersion,
                  format: input.format,
                  inputCharacters: input.content.length,
                  effect: "replace_lesson_blocks_after_shared_sanitization"
                }
              };
            },
            0,
          ),
        );
      }
      const snapshot = await authorizedConsoleMutation<
        Record<string, unknown>
      >(
        context,
        "course.authoring.edit",
        "save_lesson_content",
        "/api/dev/authoring",
        mutation,
        0.04
      );
      return result(snapshot);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "approve_course_diagram",
  {
    title: "Approve course diagram candidate",
    description:
      "Approve a tenant-bound diagram candidate with required accessible text.",
    inputSchema: {
      ...mutationContextInput,
      lessonId: z.string().min(1).max(128),
      expectedVersion: z.number().int().positive(),
      altText: z.string().min(1).max(1_000),
      caption: z.string().min(1).max(500)
    },
    outputSchema: authoringSnapshotOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const snapshot = await authorizedConsoleMutation<
        Record<string, unknown>
      >(
        context,
        "course.authoring.diagram.approve",
        "approve_course_diagram",
        "/api/dev/authoring",
        {
          action: "approve_diagram",
          lessonId: input.lessonId,
          expectedVersion: input.expectedVersion,
          altText: input.altText,
          caption: input.caption
        },
        0.03
      );
      return result(snapshot);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "publish_course_draft",
  {
    title: "Publish course draft",
    description:
      "Publish a validated course authoring draft with optimistic version protection and an audit note.",
    inputSchema: {
      ...mutationContextInput,
      expectedVersion: z.number().int().positive(),
      auditNote: z.string().min(8).max(1_000)
    },
    outputSchema: authoringSnapshotOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const snapshot = await authorizedConsoleMutation<
        Record<string, unknown>
      >(
        context,
        "course.authoring.publish",
        "publish_course_draft",
        "/api/dev/authoring",
        {
          action: "publish",
          expectedVersion: input.expectedVersion,
          auditNote: input.auditNote
        },
        0.05
      );
      return result(snapshot);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "rollback_course_revision",
  {
    title: "Roll back course revision",
    description:
      "Append a rollback revision that restores an exact earlier course snapshot.",
    inputSchema: {
      ...mutationContextInput,
      expectedVersion: z.number().int().positive(),
      targetVersion: z.number().int().positive(),
      auditNote: z.string().min(8).max(1_000)
    },
    outputSchema: authoringSnapshotOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const snapshot = await authorizedConsoleMutation<
        Record<string, unknown>
      >(
        context,
        "course.authoring.rollback",
        "rollback_course_revision",
        "/api/dev/authoring",
        {
          action: "rollback",
          expectedVersion: input.expectedVersion,
          targetVersion: input.targetVersion,
          auditNote: input.auditNote
        },
        0.03
      );
      return result(snapshot);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "reprocess_learning_content",
  {
    title: "Selectively reprocess learning content",
    description:
      "Create a scoped replacement draft while active retrieval remains on the last published version.",
    inputSchema: {
      ...mutationContextInput,
      body: z.string().min(1).max(250_000)
    },
    outputSchema: {
      action: z.string(),
      result: z.record(z.string(), z.unknown()),
      active: z.record(z.string(), z.unknown()).optional(),
      versions: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const response = await authorizedConsoleMutation<{
        action: string;
        result: Record<string, unknown>;
        active?: Record<string, unknown>;
        versions: Record<string, unknown>[];
      }>(
        context,
        "learning.ingestion.start",
        "reprocess_learning_content",
        "/api/dev/ingestion",
        {
          action: "reprocess",
          body: input.body
        },
        0.5
      );
      return result(response);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "start_learning_ingestion",
  {
    title: "Start tenant learning ingestion",
    description:
      "Validate and ingest text into a reviewable draft knowledge version through the same pipeline used by the Creator console.",
    inputSchema: {
      ...mutationContextInput,
      title: z.string().min(1).max(160),
      body: z.string().min(1).max(250_000)
    },
    outputSchema: {
      action: z.string(),
      job: z.record(z.string(), z.unknown()),
      active: z.record(z.string(), z.unknown()).optional(),
      versions: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const response = await authorizedMutation(
        context,
        "learning.ingestion.start",
        "start_learning_ingestion",
        { title: input.title, body: input.body },
        () =>
          consoleClient.request<{
            action: string;
            job: Record<string, unknown>;
            active?: Record<string, unknown>;
            versions: Record<string, unknown>[];
          }>(
            "/api/dev/ingestion",
            {
              method: "POST",
              headers: mutationHeaders(context),
              body: JSON.stringify({
                action: "start",
                title: input.title,
                body: input.body,
                idempotencyKey: context.idempotencyKey,
                mcpContext: {
                  tenantId: context.tenantId,
                  actorId: context.actorId,
                  requestId: context.requestId,
                  grantId: context.grantId
                }
              })
            },
            context.requestId
          ),
        0.75,
      );
      return result(response);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "publish_learning_version",
  {
    title: "Publish a reviewed learning version",
    description:
      "Atomically publish a draft knowledge version when the expected active version still matches.",
    inputSchema: {
      ...mutationContextInput,
      draftVersionId: z.string().min(1).max(128),
      expectedActiveVersionId: z.string().max(128).optional()
    },
    outputSchema: {
      action: z.string(),
      published: z.record(z.string(), z.unknown()),
      active: z.record(z.string(), z.unknown()),
      versions: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    try {
      const response = await authorizedMutation(
        context,
        "learning.version.publish",
        "publish_learning_version",
        {
          draftVersionId: input.draftVersionId,
          expectedActiveVersionId: input.expectedActiveVersionId
        },
        () =>
          consoleClient.request<{
            action: string;
            published: Record<string, unknown>;
            active: Record<string, unknown>;
            versions: Record<string, unknown>[];
          }>(
            "/api/dev/ingestion",
            {
              method: "POST",
              headers: mutationHeaders(context),
              body: JSON.stringify({
                action: "publish",
                draftVersionId: input.draftVersionId,
                expectedActiveVersionId: input.expectedActiveVersionId,
                idempotencyKey: context.idempotencyKey,
                mcpContext: {
                  tenantId: context.tenantId,
                  actorId: context.actorId,
                  requestId: context.requestId,
                  grantId: context.grantId
                }
              })
            },
            context.requestId
          ),
        0.02,
      );
      return result(response);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

server.registerTool(
  "publish_tenant_branding",
  {
    title: "Publish tenant assistant branding",
    description:
      "Save and publish tenant assistant identity, colors, welcome copy and voice through the same application service used by the Branding console.",
    inputSchema: {
      ...mutationContextInput,
      assistantName: z.string().min(1).max(80),
      primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      welcome: z.string().min(1).max(1_000),
      voice: z.enum(["Harbor", "Meadow", "Sol"]),
      attribution: z.boolean(),
      privacyLink: z.boolean()
    },
    outputSchema: {
      published: z.record(z.string(), z.unknown())
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (input) => {
    const context = contextFrom(input);
    const branding = {
      assistantName: input.assistantName,
      primary: input.primary,
      accent: input.accent,
      surface: input.surface,
      welcome: input.welcome,
      voice: input.voice,
      attribution: input.attribution,
      privacyLink: input.privacyLink
    };
    try {
      const response = await authorizedMutation(
        context,
        "branding.publish",
        "publish_tenant_branding",
        branding,
        () =>
          consoleClient.request<{
            published: Record<string, unknown>;
          }>(
            "/api/dev/branding",
            {
              method: "POST",
              headers: mutationHeaders(context),
              body: JSON.stringify({
                ...branding,
                idempotencyKey: context.idempotencyKey,
                mcpContext: {
                  tenantId: context.tenantId,
                  actorId: context.actorId,
                  requestId: context.requestId,
                  grantId: context.grantId
                }
              })
            },
            context.requestId
          ),
        0.01,
      );
      return result(response);
    } catch (error: unknown) {
      return errorResult(error, context.requestId);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown MCP error";
  console.error(`Course AI management MCP failed: ${message}`);
  process.exit(1);
});
