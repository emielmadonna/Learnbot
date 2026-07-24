import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== "string" ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value.trim();
}

function idempotencyKey(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 200 ||
    !/^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const result = await executeLearningRpc(
      supabase,
      "learning_create_course_draft",
      {
        requested_title: boundedString(input.title, 3, 160),
        requested_description: boundedString(input.description, 3, 2_000),
        requested_module_title: boundedString(input.moduleTitle, 3, 160),
        requested_lesson_title: boundedString(input.lessonTitle, 3, 160),
        requested_lesson_content: boundedString(
          input.lessonContent,
          20,
          50_000,
        ),
        idempotency_key: idempotencyKey(input.idempotencyKey),
      },
    );
    return NextResponse.json(result, {
      status: 201,
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
              : "course_request_denied",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
