import {
  createAnonymousSupabaseClient,
  createOpaqueToken,
  createPkceS256Challenge,
  firstRpcRow,
  hashOpaque,
  jsonNoStore,
  parseBasicAuthorization,
  readCircleOAuthClient,
} from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenError(error: string, status: number, headers?: HeadersInit) {
  return jsonNoStore({ error }, status, headers);
}

export async function POST(request: Request) {
  const raw = await request.text();
  const body = new URLSearchParams(raw);
  const basic = parseBasicAuthorization(request.headers.get("authorization"));
  const clientId = body.get("client_id")?.trim() || basic?.clientId || "";
  const clientSecret = body.get("client_secret") || basic?.clientSecret || "";
  const code = body.get("code") || "";
  const redirectUri = body.get("redirect_uri") || "";
  const verifier = body.get("code_verifier") || "";

  if (body.get("grant_type") !== "authorization_code" || !clientId || !clientSecret || !code || !redirectUri) {
    return tokenError("invalid_request", 400);
  }

  let client;
  try {
    client = await readCircleOAuthClient(createAnonymousSupabaseClient(), clientId);
  } catch {
    return tokenError("temporarily_unavailable", 503);
  }
  if (!client) {
    return tokenError("invalid_client", 401, {
      "WWW-Authenticate": 'Basic realm="LearningBot Circle SSO"',
    });
  }
  if (redirectUri !== client.redirectUri) return tokenError("invalid_grant", 400);

  const accessToken = createOpaqueToken();
  const redeemed = await createAnonymousSupabaseClient().rpc("circle_oauth_redeem_code", {
    requested_client_id: clientId,
    requested_client_secret_hash: hashOpaque(clientSecret),
    requested_redirect_uri: redirectUri,
    requested_code_hash: hashOpaque(code),
    requested_code_verifier_hash: verifier ? createPkceS256Challenge(verifier) : null,
    requested_access_token_hash: hashOpaque(accessToken),
  });
  if (redeemed.error) return tokenError("temporarily_unavailable", 503);
  const result = firstRpcRow(redeemed.data);
  if (!result || result.ok !== true) {
    const error = result?.code === "invalid_client" ? "invalid_client" : "invalid_grant";
    return tokenError(error, error === "invalid_client" ? 401 : 400);
  }

  const scopes = Array.isArray(result.scopes)
    ? result.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  return jsonNoStore({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: scopes.join(" "),
  });
}
