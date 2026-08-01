import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
  getCurrentTenantContext,
} from "../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import type { SupabaseClient } from "@supabase/supabase-js";

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const classified = classifyAuthBoundaryError(error);
    return response({ ok: false, code: classified.code }, classified.status);
  }
  return response({ ok: false, code: "request_failed" }, 500);
}

async function providerManagementEnabled(supabase: SupabaseClient) {
  const result = await supabase.rpc("tenant_get_capabilities");
  if (result.error || !isRecord(result.data) || result.data.ok !== true) {
    return false;
  }
  const capabilities = Array.isArray(result.data.capabilities)
    ? result.data.capabilities
    : [];
  return capabilities.some(
    (entry) =>
      isRecord(entry) &&
      entry.capabilityKey === "provider_api_key" &&
      entry.enabled === true,
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const managementEnabled = await providerManagementEnabled(supabase);
    const result = await supabase.rpc("learning_provider_credential_state");
    if (result.error || !isRecord(result.data)) {
      return response({ ok: false, code: "request_failed" }, 503);
    }
    const body = result.data;
    if (body.ok !== true) {
      const code = typeof body.code === "string" ? body.code : "request_failed";
      return response(
        { ok: false, code },
        code === "access_denied"
          ? 403
          : code === "tenant_selection_required"
            ? 409
            : 400,
      );
    }
    return response({ ...body, managementEnabled });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    if (!(await providerManagementEnabled(supabase))) {
      return response(
        { ok: false, code: "provider_key_management_disabled" },
        403,
      );
    }
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) return response({ ok: false, code: "invalid_request" }, 400);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const clearApiKey = input.clearApiKey === true;
    if (
      (clearApiKey && apiKey.length > 0) ||
      (!clearApiKey && !/^[\x20-\x7e]{20,500}$/u.test(apiKey))
    ) {
      return response({ ok: false, code: "invalid_request" }, 400);
    }

    const context = await getCurrentTenantContext(supabase);
    const tenantId = context.selected ? context.tenantId ?? "" : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        tenantId,
      )
    ) {
      return response({ ok: false, code: "tenant_selection_required" }, 409);
    }

    const invoked = await supabase.functions.invoke(
      "learning-provider-credentials",
      {
        method: "PUT",
        body: {
          tenantId,
          provider: "openai",
          apiKey,
          clearApiKey,
          requestId: `provider:${crypto.randomUUID()}`,
        },
      },
    );
    const body = isRecord(invoked.data) ? invoked.data : null;
    if (invoked.error || !body || body.ok !== true) {
      const code = typeof body?.code === "string" ? body.code : "request_failed";
      return response(
        { ok: false, code },
        code === "access_denied"
          ? 403
          : code === "invalid_request"
            ? 400
            : 503,
      );
    }
    return response(body);
  } catch (error) {
    return failure(error);
  }
}
