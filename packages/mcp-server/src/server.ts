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

const server = new McpServer({
  name: "course-ai-management",
  version: "0.1.0"
});

function result<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

const tenantInput = {
  tenantId: z
    .literal(DEVELOPMENT_TENANT_ID)
    .describe("Authorized development tenant identifier")
};

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown MCP error";
  console.error(`Course AI management MCP failed: ${message}`);
  process.exit(1);
});
