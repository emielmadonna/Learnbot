import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  getCurrentTenantContext,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";

const allowedRoles = new Set([
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
]);

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

async function functionResult(
  data: unknown,
  error: unknown,
): Promise<Record<string, unknown> | null> {
  if (isRecord(data)) return data;
  const context =
    error && typeof error === "object" && "context" in error
      ? (error as { context?: unknown }).context
      : null;
  if (!(context instanceof Response)) return null;
  try {
    const body: unknown = await context.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const data = await executeLearningRpc(
      supabase,
      "admin_list_access_accounts",
    );
    return response(data);
  } catch (error) {
    return response(
      {
        ok: false,
        code:
          error instanceof AuthenticationBoundaryError
            ? "authentication_required"
            : "access_denied",
      },
      error instanceof AuthenticationBoundaryError ? 401 : 403,
    );
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const context = await getCurrentTenantContext(supabase);
    if (
      !context.selected ||
      !["tenant_owner", "tenant_admin"].includes(context.identityRole ?? "")
    ) {
      return response({ ok: false, code: "access_denied" }, 403);
    }
    const input = (await request.json()) as Record<string, unknown>;
    const email =
      typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const displayName =
      typeof input.displayName === "string" ? input.displayName.trim() : "";
    const role = typeof input.role === "string" ? input.role : "";
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      displayName.length < 1 ||
      displayName.length > 160 ||
      !allowedRoles.has(role)
    ) {
      return response({ ok: false, code: "invalid_request" }, 400);
    }
    const invoked = await supabase.functions.invoke("learning-admin-users", {
      body: {
        tenantId: context.tenantId,
        email,
        displayName,
        role,
        idempotencyKey: `managed-account:${crypto.randomUUID()}`,
      },
    });
    const result = await functionResult(invoked.data, invoked.error);
    if (invoked.error || !result || result.ok !== true) {
      const code =
        typeof result?.code === "string"
          ? result.code
          : "account_creation_failed";
      const status =
        code === "access_denied"
          ? 403
          : code === "account_exists"
            ? 409
            : code === "owner_identity_conflict"
              ? 409
              : code === "provider_not_configured"
                ? 503
                : code === "invitation_provider_failed" ||
                    code === "invitation_provisioning_failed"
                  ? 502
                  : 400;
      return response(
        {
          ok: false,
          code,
          providerCode:
            typeof result?.providerCode === "string"
              ? result.providerCode
              : undefined,
          providerMessage:
            typeof result?.providerMessage === "string"
              ? result.providerMessage
              : undefined,
          deliveryStatus:
            typeof result?.deliveryStatus === "string"
              ? result.deliveryStatus
              : undefined,
        },
        status,
      );
    }
    return response(result, 201);
  } catch (error) {
    return response(
      {
        ok: false,
        code:
          error instanceof AuthenticationBoundaryError
            ? "authentication_required"
            : "account_creation_failed",
      },
      error instanceof AuthenticationBoundaryError ? 401 : 400,
    );
  }
}
