import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

const cacheHeaders = { "Cache-Control": "private, no-store" } as const;

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["invalid_request", 400],
  ["tenant_not_found", 404],
  ["tenant_selection_required", 409],
  ["invalid_response", 502],
  ["request_failed", 503],
]);

/**
 * A single `catch` that reported every failure as 401 sent operators to the
 * sign-in page for faults a sign-in cannot fix — an unapplied migration, a
 * revoked grant, an unselected tenant. Each cause now carries its own status.
 */
function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: cacheHeaders },
    );
  }
  if (error instanceof LearningRpcError) {
    return NextResponse.json(
      { ok: false, code: error.code },
      {
        status: statusByCode.get(error.code) ?? 400,
        headers: cacheHeaders,
      },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_failed" },
    { status: 500, headers: cacheHeaders },
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const workspace = await executeLearningRpc(
      supabase,
      "learning_get_workspace",
    );
    return NextResponse.json(workspace, { headers: cacheHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
