import { randomUUID } from "node:crypto";
import {
  CircleSourceError,
  listCircleCourses,
  readCircleCourse,
} from "../../../../../lib/source-connectors/circle";
import {
  SourceConnectorError,
  connectorErrorResponse,
  connectorRequestContext,
  connectorRpc,
  createSourceConnectorServiceClient,
  requiredUuid,
} from "../../../../../lib/source-connectors/server";

type ConnectionState = {
  configured?: boolean;
  accountLabel?: string | null;
  keyLast4?: string | null;
  status?: string | null;
  vaultReference?: string | null;
};

function providerError(error: unknown): never {
  if (error instanceof CircleSourceError) {
    const status =
      error.code === "circle_credential_invalid" ||
      error.code === "circle_plan_or_permission_required"
        ? 403
        : error.code === "circle_rate_limited"
          ? 429
          : error.code === "circle_course_not_found"
            ? 404
            : error.code === "circle_course_has_no_published_text"
              ? 422
              : 502;
    throw new SourceConnectorError(error.code, status);
  }
  throw new SourceConnectorError("circle_provider_unavailable", 502);
}

async function safeConnectionState(
  supabase: Awaited<ReturnType<typeof connectorRequestContext>>["supabase"],
) {
  const response = await supabase.rpc("learning_source_connection_state", {
    requested_provider: "circle",
  });
  if (response.error) {
    throw new SourceConnectorError("connector_database_unavailable", 503);
  }
  const result = response.data as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    throw new SourceConnectorError(
      typeof result?.code === "string" ? result.code : "connector_request_failed",
      400,
    );
  }
  return result;
}

async function circleRuntime(
  userId: string,
  tenantId: string,
): Promise<{ token: string; vaultReference: string }> {
  const service = createSourceConnectorServiceClient();
  const result = await connectorRpc(
    service,
    "learning_source_connection_runtime",
    {
      caller_auth_user_id: userId,
      target_tenant_id: tenantId,
      requested_provider: "circle",
    },
  );
  if (
    typeof result.credential !== "string" ||
    typeof result.vaultReference !== "string"
  ) {
    throw new SourceConnectorError("tenant_credential_not_configured", 409);
  }
  return {
    token: result.credential,
    vaultReference: result.vaultReference,
  };
}

export async function GET(request: Request) {
  try {
    const context = await connectorRequestContext(request);
    const state = await safeConnectionState(context.supabase);
    const connection = (state.connection ?? {}) as ConnectionState;
    if (connection.configured !== true) {
      return Response.json(
        {
          ok: true,
          configured: false,
          configurationRequired: "circle_token",
          courses: [],
          sources: state.sources ?? [],
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    let runtime;
    try {
      runtime = await circleRuntime(context.userId, context.tenantId);
    } catch (error) {
      if (
        error instanceof SourceConnectorError &&
        error.code === "server_secret_required"
      ) {
        return Response.json(
          {
            ok: true,
            configured: true,
            accountLabel: connection.accountLabel ?? null,
            keyLast4: connection.keyLast4 ?? null,
            configurationRequired: "server_secret",
            courses: [],
            sources: state.sources ?? [],
          },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }
      throw error;
    }

    let courses;
    try {
      courses = await listCircleCourses(runtime.token);
    } catch (error) {
      providerError(error);
    }
    return Response.json(
      {
        ok: true,
        configured: true,
        accountLabel: connection.accountLabel ?? null,
        keyLast4: connection.keyLast4 ?? null,
        configurationRequired: null,
        courses,
        sources: state.sources ?? [],
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as {
      action?: unknown;
      token?: unknown;
      accountLabel?: unknown;
      courseId?: unknown;
      circleCourseId?: unknown;
      replaceActiveKnowledge?: unknown;
    };
    const action = input.action;
    if (action === "configure" || action === "clear") {
      const context = await connectorRequestContext(request, {
        mutation: true,
        admin: true,
      });
      const token = action === "configure" && typeof input.token === "string"
        ? input.token.trim()
        : "";
      const accountLabel =
        typeof input.accountLabel === "string" ? input.accountLabel.trim() : "";
      if (
        action === "configure" &&
        (token.length < 20 || token.length > 1_000 || accountLabel.length > 160)
      ) {
        throw new SourceConnectorError("invalid_request");
      }
      if (action === "configure") {
        try {
          // Validate the account and plan before committing the token to Vault.
          // An invalid token must never produce a configured/success state.
          await listCircleCourses(token);
        } catch (error) {
          providerError(error);
        }
      }
      const result = await connectorRpc(
        createSourceConnectorServiceClient(),
        "learning_source_connection_set",
        {
          caller_auth_user_id: context.userId,
          target_tenant_id: context.tenantId,
          target_provider: "circle",
          raw_credential: token,
          account_label: accountLabel,
          clear_credential: action === "clear",
          requested_idempotency_key: `circle-connection:${randomUUID()}`,
        },
      );
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (action !== "import") {
      throw new SourceConnectorError("invalid_request");
    }
    const context = await connectorRequestContext(request, { mutation: true });
    if (
      typeof input.circleCourseId !== "string" ||
      !/^[0-9A-Za-z_-]{1,100}$/u.test(input.circleCourseId)
    ) {
      throw new SourceConnectorError("invalid_circle_course");
    }
    const runtime = await circleRuntime(context.userId, context.tenantId);
    let source;
    try {
      source = await readCircleCourse(runtime.token, input.circleCourseId);
    } catch (error) {
      providerError(error);
    }
    const createDestination =
      input.courseId === undefined ||
      input.courseId === null ||
      input.courseId === "" ||
      input.courseId === "new";
    let localCourseId: string;
    if (createDestination) {
      const created = await connectorRpc(
        context.supabase,
        "learning_create_source_course",
        {
          requested_title: source.course.name,
          requested_source_kind: "circle",
          requested_external_ref: source.course.id,
          requested_idempotency_key: `source-course:circle:${source.course.id}`,
        },
      );
      localCourseId = requiredUuid(created.courseId);
    } else {
      localCourseId = requiredUuid(input.courseId);
    }
    const result = await connectorRpc(
      createSourceConnectorServiceClient(),
      "learning_source_connector_sync",
      {
        caller_auth_user_id: context.userId,
        target_tenant_id: context.tenantId,
        target_course_id: localCourseId,
        source_kind: "circle",
        external_ref: source.course.id,
        source_name: source.course.name,
        source_configuration: {
          circleSpaceId: source.course.id,
          circleSpaceSlug: source.course.slug,
          circleSpaceUrl: source.course.url,
        },
        source_documents: source.documents,
        source_content_hash: source.contentHash,
        replace_active_knowledge: input.replaceActiveKnowledge === true,
        requested_idempotency_key: `circle:${source.course.id}:${randomUUID()}`,
        source_credential_vault_ref: runtime.vaultReference,
      },
    );
    return Response.json(
      {
        ...result,
        destination: {
          courseId: localCourseId,
          created: createDestination,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
