import { NextResponse } from "next/server";
import { requireVerifiedUser } from "../../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";
import {
  authorizationResumePath,
  buildRegisteredRedirect,
  createAnonymousSupabaseClient,
  createOpaqueToken,
  firstRpcRow,
  hashOpaque,
  jsonNoStore,
  parseOAuthScopes,
  readCircleOAuthClient,
} from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorRedirect(
  client: Awaited<ReturnType<typeof readCircleOAuthClient>>,
  error: string,
  state: string | null,
  description?: string,
) {
  if (!client) return null;
  return buildRegisteredRedirect(client, {
    error,
    ...(state ? { state } : {}),
    ...(description ? { error_description: description } : {}),
  });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const clientId = requestUrl.searchParams.get("client_id")?.trim() ?? "";
  const redirectUri = requestUrl.searchParams.get("redirect_uri") ?? "";
  const state = requestUrl.searchParams.get("state");
  const responseType = requestUrl.searchParams.get("response_type");
  const scope = parseOAuthScopes(requestUrl.searchParams.get("scope"));
  const codeChallenge = requestUrl.searchParams.get("code_challenge")?.trim() || null;
  const codeChallengeMethod = requestUrl.searchParams.get("code_challenge_method")?.trim() || null;
  const nonce = requestUrl.searchParams.get("nonce")?.trim() || null;

  if (!clientId || !redirectUri) {
    return jsonNoStore({ error: "invalid_request" }, 400);
  }

  let client;
  try {
    client = await readCircleOAuthClient(createAnonymousSupabaseClient(), clientId);
  } catch {
    return jsonNoStore({ error: "temporarily_unavailable" }, 503);
  }
  if (!client) return jsonNoStore({ error: "invalid_client" }, 400);
  if (redirectUri !== client.redirectUri) {
    // Never redirect to an unregistered URI when the URI check fails.
    return jsonNoStore({ error: "invalid_request" }, 400);
  }

  const redirectError = (error: string, description?: string) =>
    NextResponse.redirect(
      errorRedirect(client, error, state, description) ?? client.redirectUri,
    );

  if (responseType !== "code") {
    return redirectError("unsupported_response_type");
  }
  if (!state || state.length > 512) {
    return redirectError("invalid_request", "state is required");
  }
  if (!scope || scope.some((item) => !client.scopes.includes(item))) {
    return redirectError("invalid_scope");
  }
  if (codeChallenge && codeChallengeMethod !== "S256") {
    return redirectError("invalid_request", "Only S256 PKCE is supported");
  }
  if (!codeChallengeMethod && codeChallenge) {
    return redirectError("invalid_request", "A PKCE method is required");
  }

  const supabase = await createServerSupabaseClient();
  const userResult = await supabase.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    const signIn = new URL("/auth/sign-in", requestUrl.origin);
    signIn.searchParams.set("next", authorizationResumePath(request));
    return NextResponse.redirect(signIn);
  }

  try {
    await requireVerifiedUser(supabase);
    const code = createOpaqueToken();
    const issued = await supabase.rpc("circle_oauth_issue_code", {
      requested_client_id: client.clientId,
      requested_redirect_uri: client.redirectUri,
      requested_state_hash: hashOpaque(state),
      requested_code_hash: hashOpaque(code),
      requested_scopes: scope,
      requested_code_challenge: codeChallenge,
      requested_code_challenge_method: codeChallengeMethod,
      requested_nonce: nonce,
    });
    if (issued.error) return jsonNoStore({ error: "temporarily_unavailable" }, 503);
    const result = firstRpcRow(issued.data);
    if (!result || result.ok !== true) {
      const codeValue = typeof result?.code === "string" ? result.code : "access_denied";
      return redirectError(codeValue === "access_denied" ? "access_denied" : "server_error");
    }
    return NextResponse.redirect(
      buildRegisteredRedirect(client, { code, state }),
    );
  } catch {
    return jsonNoStore({ error: "temporarily_unavailable" }, 503);
  }
}
