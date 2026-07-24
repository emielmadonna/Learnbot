import {
  bearerToken,
  createAnonymousSupabaseClient,
  firstRpcRow,
  hashOpaque,
  jsonNoStore,
} from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) {
    return jsonNoStore(
      { error: "invalid_token" },
      401,
      { "WWW-Authenticate": 'Bearer realm="LearningBot Circle SSO"' },
    );
  }

  const result = await createAnonymousSupabaseClient().rpc("circle_oauth_userinfo", {
    requested_access_token_hash: hashOpaque(token),
  });
  if (result.error) return jsonNoStore({ error: "temporarily_unavailable" }, 503);
  const row = firstRpcRow(result.data);
  if (!row || row.ok !== true) {
    return jsonNoStore(
      { error: "invalid_token" },
      401,
      { "WWW-Authenticate": 'Bearer realm="LearningBot Circle SSO", error="invalid_token"' },
    );
  }

  return jsonNoStore({
    sub: row.sub,
    email: row.email,
    email_verified: true,
    name: row.name,
    preferred_username: row.email,
    tenant_id: row.tenant_id,
  });
}

export async function POST(request: Request) {
  return GET(request);
}
