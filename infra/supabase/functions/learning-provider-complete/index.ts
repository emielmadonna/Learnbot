import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedModels = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
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

function createAuthClient(authorization: string) {
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

function createServiceClient() {
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

function responseText(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  if (!Array.isArray(record.output)) return null;
  const text = record.output.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? [value] : [];
    });
  });
  return text.join("\n").trim() || null;
}

async function safetyIdentifier(authUserId: string, tenantId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${tenantId}:${authUserId}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeMessages(value: unknown): Message[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    return null;
  }
  const messages = value.flatMap((item): Message[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = typeof record.content === "string"
      ? record.content.trim()
      : "";
    if (
      (role !== "system" && role !== "user" && role !== "assistant") ||
      !content ||
      content.length > 32_000
    ) {
      return [];
    }
    return [{ role, content }];
  });
  return messages.length === value.length &&
      messages.reduce((total, message) => total + message.content.length, 0) <=
    96_000
    ? messages
    : null;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }
  const authClient = createAuthClient(authorization);
  const serviceClient = createServiceClient();
  if (!authClient || !serviceClient) {
    return json({ ok: false, code: "credential_boundary_unavailable" }, 503);
  }

  const token = authorization.slice("Bearer ".length).trim();
  const { data: identity, error: identityError } = await authClient.auth.getUser(
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
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const requestId = typeof input.requestId === "string"
    ? input.requestId.trim()
    : "";
  const maxOutputTokens = typeof input.maxOutputTokens === "number" &&
      Number.isInteger(input.maxOutputTokens) &&
      input.maxOutputTokens >= 64 &&
      input.maxOutputTokens <= 4_096
    ? input.maxOutputTokens
    : 800;
  const messages = normalizeMessages(input.messages);
  if (
    !uuidPattern.test(tenantId) ||
    provider !== "openai" ||
    !allowedModels.has(model) ||
    !requestIdPattern.test(requestId) ||
    !messages
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const { data: credentialData, error: credentialError } =
    await serviceClient.rpc("learning_provider_runtime_credential", {
      caller_auth_user_id: identity.user.id,
      target_tenant_id: tenantId,
      requested_provider: provider,
    });
  if (
    credentialError ||
    !credentialData ||
    typeof credentialData !== "object" ||
    Array.isArray(credentialData)
  ) {
    return json({ ok: false, code: "credential_boundary_unavailable" });
  }
  const credentialResult = credentialData as Record<string, unknown>;
  let credential = credentialResult.ok === true &&
      typeof credentialResult.credential === "string"
    ? credentialResult.credential
    : "";
  let credentialSource = "tenant_vault";
  if (
    !credential &&
    credentialResult.code === "tenant_credential_not_configured"
  ) {
    // A tenant-owned key remains the first choice. The platform key is the
    // production fallback for workspaces whose subscription includes managed
    // inference, and it never leaves this server-side function. The runtime
    // credential RPC has already established that this user belongs to the
    // requested tenant before it can return `tenant_credential_not_configured`.
    credential = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
    credentialSource = "platform_managed";
  }
  if (!credential) {
    const code = credentialResult.code === "access_denied"
      ? "access_denied"
      : credentialResult.code === "tenant_credential_not_configured"
        ? "provider_not_configured"
        : "credential_boundary_unavailable";
    return json({ ok: false, code });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const providerResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "x-client-request-id": requestId,
      },
      body: JSON.stringify({
        model,
        input: messages,
        max_output_tokens: maxOutputTokens,
        safety_identifier: await safetyIdentifier(identity.user.id, tenantId),
        store: false,
      }),
      signal: controller.signal,
    });
    if (!providerResponse.ok) {
      return json({
        ok: false,
        code: providerResponse.status === 401 || providerResponse.status === 403
          ? "provider_authentication_failed"
          : providerResponse.status === 429 || providerResponse.status >= 500
            ? "provider_unavailable"
            : "provider_failed",
        retryable: providerResponse.status === 429 || providerResponse.status >= 500,
      });
    }
    const payload = await providerResponse.json();
    const text = responseText(payload);
    if (!text) return json({ ok: false, code: "provider_response_invalid" });
    const usage = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).usage
      : null;
    return json({
      ok: true,
      provider: "openai",
      adapterId: "openai-vault-responses-v1",
      model,
      text,
      credentialSource,
      providerRequestRef:
        payload && typeof payload === "object" && !Array.isArray(payload) &&
          typeof (payload as Record<string, unknown>).id === "string"
          ? (payload as Record<string, unknown>).id
          : requestId,
      usage: usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage
        : [],
    });
  } catch {
    return json({
      ok: false,
      code: controller.signal.aborted ? "provider_unavailable" : "provider_failed",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
});
