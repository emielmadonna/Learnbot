import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "../../../lib/supabase/config";

export const CIRCLE_OAUTH_SCOPES = ["openid", "email", "profile"] as const;
export const CIRCLE_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;

export type CircleOAuthClient = {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
};

export type CircleOAuthResult = Record<string, unknown>;

export function jsonNoStore(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export function hashOpaque(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function createPkceS256Challenge(verifier: string) {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function isSafeCircleRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function parseOAuthScopes(value: string | null) {
  const scopes = (value ?? "").split(/\s+/u).filter(Boolean);
  const unique = [...new Set(scopes)];
  if (
    unique.length === 0 ||
    unique.some((scope) => !CIRCLE_OAUTH_SCOPES.includes(scope as (typeof CIRCLE_OAUTH_SCOPES)[number])) ||
    !unique.includes("openid") ||
    !unique.includes("email")
  ) {
    return null;
  }
  return unique;
}

export function firstRpcRow(data: unknown): CircleOAuthResult | null {
  if (Array.isArray(data)) {
    const row = data[0];
    return row && typeof row === "object" ? (row as CircleOAuthResult) : null;
  }
  return data && typeof data === "object" ? (data as CircleOAuthResult) : null;
}

export function parseCircleOAuthClient(row: CircleOAuthResult | null) {
  if (
    !row ||
    typeof row.tenant_id !== "string" ||
    typeof row.client_id !== "string" ||
    typeof row.redirect_uri !== "string" ||
    !Array.isArray(row.scopes)
  ) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scopes: row.scopes.filter((scope): scope is string => typeof scope === "string"),
  } satisfies CircleOAuthClient;
}

export function createAnonymousSupabaseClient() {
  const config = readSupabasePublicConfig();
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

export async function readCircleOAuthClient(
  supabase: SupabaseClient,
  clientId: string,
) {
  const result = await supabase.rpc("circle_oauth_client_details", {
    requested_client_id: clientId,
  });
  if (result.error) throw result.error;
  return parseCircleOAuthClient(firstRpcRow(result.data));
}

export function authorizationResumePath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function oauthEndpoints(request: Request) {
  const origin = new URL(request.url).origin;
  return {
    authorizationUrl: `${origin}/api/circle/authorize`,
    tokenUrl: `${origin}/api/circle/token`,
    userInfoUrl: `${origin}/api/circle/userinfo`,
  };
}

export function buildRegisteredRedirect(
  client: CircleOAuthClient,
  parameters: Record<string, string>,
) {
  const redirect = new URL(client.redirectUri);
  for (const [key, value] of Object.entries(parameters)) {
    redirect.searchParams.set(key, value);
  }
  return redirect;
}

export function parseBasicAuthorization(value: string | null) {
  if (!value?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function bearerToken(value: string | null) {
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return token && token.length <= 512 ? token : null;
}
