import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalUuid(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
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

function operationKey(value: unknown, prefix: string) {
  if (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    return value;
  }
  return `${prefix}:${crypto.randomUUID()}`;
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    return NextResponse.json(
      { ok: false, code: "authentication_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    error instanceof LearningRpcError &&
    error.code === "tenant_selection_required"
  ) {
    return NextResponse.json(
      { ok: false, code: error.code },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_denied" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const conversationId = optionalUuid(
      url.searchParams.get("conversationId"),
    );
    const courseId = optionalUuid(url.searchParams.get("courseId"));
    const lessonId = optionalUuid(url.searchParams.get("lessonId"));
    const supabase = await authenticatedLearningClient(request);
    const result = await executeLearningRpc(
      supabase,
      "learning_get_conversations",
      { target_conversation_id: conversationId },
    );

    if (
      conversationId === null &&
      (courseId !== null || lessonId !== null) &&
      Array.isArray(result.conversations)
    ) {
      result.conversations = result.conversations.filter(
        (candidate) =>
          isRecord(candidate) &&
          (courseId === null || candidate.courseId === courseId) &&
          (lessonId === null || candidate.lessonId === lessonId),
      );
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
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
      "learning_start_conversation",
      {
        target_course_id: optionalUuid(input.courseId),
        target_lesson_id: optionalUuid(input.lessonId),
        idempotency_key: operationKey(
          input.idempotencyKey,
          "learning-conversation",
        ),
      },
    );
    return NextResponse.json(result, {
      status: result.replayed === true ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
