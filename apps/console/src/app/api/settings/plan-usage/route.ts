import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import { getTenantPlanUsage } from "../../../../lib/settings/tenant-settings-rpc";

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["tenant_selection_required", 409],
  ["request_failed", 503],
  ["invalid_response", 502],
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
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request);
    return response(await getTenantPlanUsage(supabase));
  } catch (error) {
    if (error instanceof AuthenticationBoundaryError) {
      const failure = classifyAuthBoundaryError(error);
      return response({ ok: false, code: failure.code }, failure.status);
    }
    if (error instanceof LearningRpcError) {
      return response(
        { ok: false, code: error.code },
        statusByCode.get(error.code) ?? 400,
      );
    }
    return response({ ok: false, code: "request_failed" }, 500);
  }
}
