import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../../../lib/supabase/learning-rpc";

function uuid(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ intentId: string }> },
) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const { intentId } = await context.params;
    const input = (await request.json()) as { courseId?: unknown };
    const result = await executeLearningRpc(
      supabase,
      "learning_confirm_quarantine_upload",
      {
        requested_intent_id: uuid(intentId),
        target_course_id: uuid(input.courseId),
      },
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status =
      error instanceof AuthenticationBoundaryError
        ? 401
        : error instanceof LearningRpcError &&
            error.code === "tenant_selection_required"
          ? 409
          : 400;
    return NextResponse.json(
      {
        ok: false,
        code:
          status === 401
            ? "authentication_required"
            : status === 409
              ? "tenant_selection_required"
              : error instanceof LearningRpcError
                ? error.code
                : "upload_confirmation_denied",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
