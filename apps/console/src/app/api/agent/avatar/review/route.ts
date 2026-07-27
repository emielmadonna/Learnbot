import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../../lib/supabase/auth-boundary";
import {
  AgentRpcError,
  requireAgentRpcSuccess,
} from "../../../../../lib/supabase/agent-rpc";
import { authenticatedLearningClient } from "../../../../../lib/supabase/learning-route";

/**
 * The creator's review decision on a generated pose set (PLAN.md Section
 * 7.1: "review before publish... a generated likeness NEVER auto-publishes").
 * This is the only route that can move a set out of 'pending_review' — the
 * database RPC enforces the same tenant_owner/tenant_admin boundary
 * generation itself requires, so publishing someone else's tenant's set, or
 * publishing without having gone through generation and consent first, is
 * not reachable through this route or through a direct RPC call.
 */

const adminRoles = new Set(["tenant_owner", "tenant_admin"]);
const decisions = new Set(["publish", "reject"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeCodes = new Set([
  "access_denied",
  "idempotency_conflict",
  "invalid_request",
  "invalid_state",
  "not_found",
  "request_denied",
  "request_failed",
  "tenant_selection_required",
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
  const code =
    error instanceof AgentRpcError && safeCodes.has(error.code)
      ? error.code
      : "request_denied";
  const status =
    code === "access_denied"
      ? 403
      : code === "tenant_selection_required" || code === "idempotency_conflict"
        ? 409
        : code === "request_failed"
          ? 503
          : code === "not_found"
            ? 404
            : 400;
  return NextResponse.json(
    { ok: false, code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    await requireVerifiedUser(supabase);
    const context = await getCurrentTenantContext(supabase);
    if (!context.selected || !context.tenantId) {
      throw new AgentRpcError("tenant_selection_required");
    }
    if (!context.identityRole || !adminRoles.has(context.identityRole)) {
      throw new AgentRpcError("access_denied");
    }

    const body = (await request.json()) as unknown;
    if (!isRecord(body)) throw new AgentRpcError("invalid_request");
    const avatarSetId =
      typeof body.avatarSetId === "string" ? body.avatarSetId.trim() : "";
    const decision =
      typeof body.decision === "string" ? body.decision.trim().toLowerCase() : "";
    if (!uuidPattern.test(avatarSetId) || !decisions.has(decision)) {
      throw new AgentRpcError("invalid_request");
    }

    const operationId = crypto.randomUUID();
    const response = await supabase.rpc("agent_avatar_review_set", {
      target_avatar_set_id: avatarSetId,
      decision,
      request_id: `agent-avatar-review:${operationId}`,
      trace_id: `agent-avatar-review:${operationId}`,
      idempotency_key: `agent-avatar-review:${operationId}`,
    });
    if (response.error) throw new AgentRpcError("request_failed");
    const result = requireAgentRpcSuccess(response.data);

    return NextResponse.json(
      { ok: true, dataMode: "durable", avatarSet: result.avatarSet ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
