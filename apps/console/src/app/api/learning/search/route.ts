import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

function optionalUuid(value: string | null) {
  if (!value) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const courseId = optionalUuid(url.searchParams.get("courseId"));
    const rawLimit = Number(url.searchParams.get("limit") ?? "6");
    if (
      query.length < 2 ||
      query.length > 512 ||
      !Number.isSafeInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 12
    ) {
      throw new LearningRpcError("invalid_request");
    }
    const supabase = await authenticatedLearningClient(request);
    const result = await executeLearningRpc(
      supabase,
      "learning_search_chunks",
      {
        search_query: query,
        target_course_id: courseId,
        match_limit: rawLimit,
      },
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
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
              : "invalid_request",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
