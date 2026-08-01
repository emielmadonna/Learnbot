import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

const widgetKeyPattern = /^wk_[0-9a-f]{40}$/u;
const allowedModels = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const requestIdPattern = /^[A-Za-z0-9:_-]{8,200}$/u;
const actorRefPattern = /^[A-Za-z0-9_-]{32,128}$/u;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
    },
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

async function safetyIdentifier(tenantId: string, actorRef: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${tenantId}:${actorRef}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const service = serviceClient();
  if (!service) {
    return json({ ok: false, code: "provider_unavailable", retryable: true });
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

  const widgetKey = typeof input.widgetKey === "string"
    ? input.widgetKey.trim()
    : "";
  const origin = typeof input.origin === "string" ? input.origin.trim() : "";
  const operationToken = typeof input.operationToken === "string"
    ? input.operationToken.trim()
    : "";
  const actorRef = typeof input.actorRef === "string"
    ? input.actorRef.trim()
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
    !widgetKeyPattern.test(widgetKey) ||
    !origin ||
    origin.length > 255 ||
    operationToken.length < 32 ||
    operationToken.length > 512 ||
    !actorRefPattern.test(actorRef) ||
    !allowedModels.has(model) ||
    !requestIdPattern.test(requestId) ||
    !messages
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const runtime = await service.rpc(
    "learning_widget_provider_runtime_credential",
    {
      widget_key: widgetKey,
      origin,
      operation_token: operationToken,
      requested_provider: "openai",
    },
  );
  const context =
    runtime.data && typeof runtime.data === "object" &&
      !Array.isArray(runtime.data)
      ? (runtime.data as Record<string, unknown>)
      : null;
  if (
    runtime.error ||
    context?.ok !== true ||
    typeof context.tenantId !== "string"
  ) {
    return json({ ok: false, code: "provider_unavailable" });
  }

  let credential =
    typeof context.credential === "string" ? context.credential.trim() : "";
  let credentialSource = "tenant_vault";
  if (!credential) {
    credential = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
    credentialSource = "platform_managed";
  }
  if (!credential) {
    return json({ ok: false, code: "provider_not_configured" });
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
        safety_identifier: await safetyIdentifier(
          context.tenantId,
          actorRef,
        ),
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
        retryable:
          providerResponse.status === 429 || providerResponse.status >= 500,
      });
    }
    const payload = await providerResponse.json();
    const text = responseText(payload);
    if (!text) return json({ ok: false, code: "provider_response_invalid" });
    const usage = payload && typeof payload === "object" &&
        !Array.isArray(payload)
      ? (payload as Record<string, unknown>).usage
      : null;
    return json({
      ok: true,
      provider: "openai",
      adapterId: "openai-managed-widget-responses-v1",
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
        : {},
    });
  } catch {
    return json({
      ok: false,
      code: "provider_unavailable",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
});
