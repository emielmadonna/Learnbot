import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import {
  AgentRpcError,
  agentOperationFields,
  listAgentConfigurationRevisions,
  rollbackAgentConfiguration,
} from "../../../../lib/supabase/agent-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";

const conflictCodes = new Set([
  "idempotency_conflict",
  "tenant_selection_required",
  "version_conflict",
]);
const safeCodes = new Set([
  "access_denied",
  "idempotency_conflict",
  "invalid_request",
  "request_denied",
  "request_failed",
  "revision_not_found",
  "tenant_not_found",
  "tenant_selection_required",
  "version_conflict",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof AgentRpcError) {
    const code = safeCodes.has(error.code) ? error.code : "request_denied";
    const status =
      code === "request_failed"
        ? 503
        : code === "access_denied"
          ? 403
          : code === "revision_not_found"
            ? 404
            : conflictCodes.has(code)
              ? 409
              : 400;
    return NextResponse.json(
      { ok: false, code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_denied" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

/** Lists every draft/published/retired version of this tenant's assistant. */
export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const revisions = await listAgentConfigurationRevisions(supabase);
    return NextResponse.json(revisions, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Restores an earlier version as a new draft or published head. Nothing is
 * rewritten in place — a rollback is itself a new, auditable version, the
 * same shape `learning_rollback_course` uses for course content.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const body = (await request.json()) as unknown;
    if (!isRecord(body)) throw new AgentRpcError("invalid_request");
    const targetVersion = Number(body.targetVersion);
    const expectedVersion = Number(body.expectedVersion);
    if (
      !Number.isSafeInteger(targetVersion) ||
      targetVersion < 1 ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0
    ) {
      throw new AgentRpcError("invalid_request");
    }
    const written = await rollbackAgentConfiguration(
      supabase,
      {
        targetVersion,
        publish: body.publish === true,
        expectedVersion,
      },
      agentOperationFields("agent-configuration-rollback"),
    );
    return NextResponse.json(written, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
