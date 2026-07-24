import { NextResponse } from "next/server";
import {
  getCurrentTenantContext,
} from "../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  CIRCLE_OAUTH_SCOPES,
  firstRpcRow,
  isSafeCircleRedirectUri,
  jsonNoStore,
  oauthEndpoints,
} from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const context = await getCurrentTenantContext(supabase);
    if (!context.selected || !context.tenantId) return jsonNoStore({ code: "tenant_selection_required" }, 401);
    const result = await supabase.rpc("circle_oauth_list_clients");
    if (result.error) return jsonNoStore({ code: "circle_sso_unavailable" }, 503);
    const clients = Array.isArray(result.data) ? result.data : [];
    return jsonNoStore({
      tenantId: context.tenantId,
      endpoints: oauthEndpoints(request),
      scopes: CIRCLE_OAUTH_SCOPES,
      clients: clients.map((client) => ({
        clientId: client.client_id,
        tenantId: client.tenant_id,
        redirectUri: client.redirect_uri,
        scopes: client.scopes,
        enabled: client.enabled,
        createdAt: client.created_at,
      })),
    });
  } catch {
    return jsonNoStore({ code: "authentication_required" }, 401);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const context = await getCurrentTenantContext(supabase);
    if (
      !context.selected ||
      !context.tenantId ||
      !["tenant_owner", "tenant_admin"].includes(context.identityRole ?? "")
    ) {
      return jsonNoStore({ code: "access_denied" }, 403);
    }
    const input = (await request.json()) as Record<string, unknown>;
    const redirectUri = typeof input.redirectUri === "string" ? input.redirectUri.trim() : "";
    if (!isSafeCircleRedirectUri(redirectUri)) {
      return jsonNoStore({ code: "invalid_redirect_uri" }, 400);
    }
    const result = await supabase.rpc("circle_oauth_register_client", {
      requested_redirect_uri: redirectUri,
      requested_scopes: [...CIRCLE_OAUTH_SCOPES],
    });
    if (result.error) return jsonNoStore({ code: "circle_sso_unavailable" }, 503);
    const row = firstRpcRow(result.data);
    if (!row || row.ok !== true || row.tenant_id !== context.tenantId) {
      return jsonNoStore({ code: typeof row?.code === "string" ? row.code : "access_denied" }, 403);
    }
    return NextResponse.json(
      {
        tenantId: row.tenant_id,
        clientId: row.client_id,
        clientSecret: row.client_secret,
        redirectUri: row.redirect_uri,
        scopes: row.scopes,
        endpoints: oauthEndpoints(request),
        secretNotice: "Save this client secret now. It is returned once and cannot be recovered.",
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    return jsonNoStore({ code: "authentication_required" }, 401);
  }
}
