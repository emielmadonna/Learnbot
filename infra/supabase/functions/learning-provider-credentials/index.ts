import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestIdPattern = /^[A-Za-z0-9:_-]{8,200}$/u;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
    },
  });
}

function publishableKey() {
  try {
    const values = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}",
    ) as Record<string, unknown>;
    return typeof values.default === "string" ? values.default : "";
  } catch {
    return "";
  }
}

function authClient(authorization: string) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = publishableKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: authorization } },
  });
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== "PUT" && request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }
  const client = authClient(authorization);
  const service = serviceClient();
  if (!client || !service) {
    return json({ ok: false, code: "credential_boundary_unavailable" }, 503);
  }

  const token = authorization.slice("Bearer ".length).trim();
  const { data: identity, error: identityError } = await client.auth.getUser(
    token,
  );
  if (identityError || !identity.user || identity.user.is_anonymous) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  let input: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, code: "invalid_request" }, 400);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const tenantId = typeof input.tenantId === "string" ? input.tenantId : "";
  const provider = typeof input.provider === "string"
    ? input.provider.trim().toLowerCase()
    : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const clearApiKey = input.clearApiKey === true;
  const requestId = typeof input.requestId === "string"
    ? input.requestId.trim()
    : crypto.randomUUID();

  if (
    !uuidPattern.test(tenantId) ||
    provider !== "openai" ||
    !requestIdPattern.test(requestId) ||
    (clearApiKey && apiKey) ||
    (!clearApiKey && !/^[\x20-\x7e]{20,500}$/u.test(apiKey))
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const { data, error } = await service.rpc(
    "learning_provider_set_credential",
    {
      caller_auth_user_id: identity.user.id,
      target_tenant_id: tenantId,
      target_provider: provider,
      raw_credential: apiKey,
      clear_credential: clearApiKey,
      request_id: requestId,
    },
  );
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    return json({ ok: false, code: "credential_boundary_unavailable" }, 503);
  }
  const result = data as Record<string, unknown>;
  if (result.ok !== true) {
    const code = result.code === "access_denied"
      ? "access_denied"
      : result.code === "invalid_request"
        ? "invalid_request"
        : "credential_boundary_unavailable";
    return json({ ok: false, code }, code === "access_denied" ? 403 : 400);
  }

  return json({
    ok: true,
    configured: result.configured === true,
    provider: provider,
    keyLast4: typeof result.keyLast4 === "string" ? result.keyLast4 : null,
    vaultReference:
      typeof result.vaultReference === "string" ? result.vaultReference : null,
  });
});
