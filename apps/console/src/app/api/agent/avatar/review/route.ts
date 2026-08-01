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
import {
  getWidgetSettings,
  updateWidgetSettings,
  widgetOperationFields,
} from "../../../../../lib/supabase/widget-rpc";
import type { SupabaseClient } from "@supabase/supabase-js";

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

async function syncPublishedAvatarToWidget(
  supabase: SupabaseClient,
  avatarSet: unknown,
) {
  if (!isRecord(avatarSet) || !isRecord(avatarSet.poses)) return false;
  const idle = isRecord(avatarSet.poses.idle) ? avatarSet.poses.idle : null;
  const storageKey =
    idle && typeof idle.storageKey === "string" ? idle.storageKey : "";
  if (!storageKey || storageKey.includes("..")) return false;

  try {
    const snapshot = await getWidgetSettings(supabase);
    if (!snapshot.widgetKey || !snapshot.assetPrefix) return false;
    const downloaded = await supabase.storage
      .from("tenant-private")
      .download(storageKey);
    if (downloaded.error || !downloaded.data) return false;

    const prefix = snapshot.assetPrefix.endsWith("/")
      ? snapshot.assetPrefix
      : `${snapshot.assetPrefix}/`;
    const publicPath = `${prefix}${crypto.randomUUID()}/avatar.png`;
    const uploaded = await supabase.storage
      .from("widget-public")
      .upload(publicPath, downloaded.data, {
        cacheControl: "3600",
        contentType: "image/png",
        upsert: false,
      });
    if (uploaded.error) return false;

    try {
      await updateWidgetSettings(
        supabase,
        {
          ...snapshot.settings,
          avatarObjectPath: publicPath,
          expectedVersion: snapshot.expectedVersion,
          publish: snapshot.liveStatus === "live",
          rotateKey: false,
        },
        widgetOperationFields("widget.avatar.sync"),
      );
      return true;
    } catch {
      await supabase.storage.from("widget-public").remove([publicPath]);
      return false;
    }
  } catch {
    // Avatar review is authoritative; an unconfigured or concurrently edited
    // widget must not roll back a valid publish decision.
    return false;
  }
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
    const widgetAvatarSynced =
      decision === "publish"
        ? await syncPublishedAvatarToWidget(supabase, result.avatarSet)
        : false;

    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        avatarSet: result.avatarSet ?? null,
        widgetAvatarSynced,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
