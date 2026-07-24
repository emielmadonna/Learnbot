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
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      return response({ ok: false, code: "authentication_required" }, 401);
    }
    const invoked = await supabase.functions.invoke("learning-admin-users", {
      body: {
        email,
        displayName,
        role,
        idempotencyKey: `managed-account:${crypto.randomUUID()}`,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const result = invoked.data as Record<string, unknown> | null;
    if (invoked.error || !result || result.ok !== true) {
      const code =
        typeof result?.code === "string"
          ? result.code
          : "account_creation_failed";
      const status =
        code === "access_denied" ? 403 : code === "account_exists" ? 409 : 400;
      return response({ ok: false, code }, status);
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
