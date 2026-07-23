#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CAPABILITIES } from "@course-ai/contracts";
import * as z from "zod/v4";
import {
  buildPlan,
  developmentCourses,
  developmentJobs,
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
  action: () => Promise<T>
): Promise<T> {
  authorizer.authorize(context, permission);
  return idempotencyStore.execute(context, operation, input, action);
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
        "request correlation metadata",
        "mutation idempotency",
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
      courses: z.array(
        z.object({
          courseId: z.string(),
          title: z.string(),
          status: z.string(),
          modules: z.number(),
          lessons: z.number(),
          activeVersion: z.number(),
          draftVersion: z.number().nullable(),
          updatedAt: z.string()
        })
      )
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ tenantId }) =>
    result({
      tenantId,
      courses: developmentCourses.map(({ tenantId: _, ...course }) => course)
    })
);

server.registerTool(
  "get_ingestion_job",
  {
    title: "Get ingestion job",
    description:
      "Read a tenant-scoped ingestion job and its current stage from the development fixture.",
    inputSchema: {
      ...tenantInput,
      jobId: z.string().min(1)
    },
    outputSchema: {
      found: z.boolean(),
      job: z
        .object({
          jobId: z.string(),
          courseId: z.string(),
          status: z.string(),
          currentStage: z.string(),
          completedItems: z.number(),
          totalItems: z.number(),
          issues: z.number(),
          updatedAt: z.string()
        })
        .optional()
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ tenantId, jobId }) => {
    const found = developmentJobs.find(
      (job) => job.tenantId === tenantId && job.jobId === jobId
    );

    if (!found) return result({ found: false });

    const { tenantId: _, ...job } = found;
    return result({ found: true, job });
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
      url: z.string().min(1),
      title: z.string().optional(),
      studentId: z.string().optional()
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
  "start_learning_ingestion",
  {
    title: "Start tenant learning ingestion",
    description:
      "Validate and ingest text into a reviewable draft knowledge version through the same pipeline used by the Creator console.",
    inputSchema: {
      ...mutationContextInput,
      title: z.string().min(1),
      body: z.string().min(1)
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
          )
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
      draftVersionId: z.string().min(1),
      expectedActiveVersionId: z.string().optional()
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
          )
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
      assistantName: z.string().min(1),
      primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      welcome: z.string().min(1),
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
          )
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
