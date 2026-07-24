import { NextResponse } from "next/server";
import { AuthenticationBoundaryError, getCurrentTenantContext } from "../../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../../lib/supabase/learning-route";
import { learningOperationKey } from "../../../../../lib/supabase/learning-rpc";
import { LearningRpcError } from "../../../../../lib/supabase/learning-rpc";

const authorRoles = new Set(["tenant_owner", "tenant_admin", "creator", "teacher"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.trim().length > maximum) {
    throw new LearningRpcError("invalid_request");
  }
  return value.trim();
}

function errorResponse(error: unknown) {
  const status =
    error instanceof AuthenticationBoundaryError
      ? 401
      : error instanceof LearningRpcError && error.code === "insufficient_role"
        ? 403
        : error instanceof LearningRpcError && error.code === "tenant_selection_required"
          ? 409
          : 400;
  return NextResponse.json(
    {
      ok: false,
      code:
        status === 401
          ? "authentication_required"
          : status === 403
            ? "insufficient_role"
            : status === 409
              ? "tenant_selection_required"
              : "knowledge_prepare_denied",
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const context = await getCurrentTenantContext(supabase);
    if (!context.selected || !context.tenantId) {
      throw new LearningRpcError("tenant_selection_required");
    }
    if (!context.identityRole || !authorRoles.has(context.identityRole)) {
      throw new LearningRpcError("insufficient_role");
    }
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");

    const result = await executeLearningRpc(supabase, "learning_create_course_draft", {
      requested_title: boundedString(input.title, 3, 160),
      requested_description: boundedString(input.description, 3, 2_000),
      requested_module_title: boundedString(input.moduleTitle, 3, 160),
      requested_lesson_title: boundedString(input.lessonTitle, 3, 160),
      requested_lesson_content: boundedString(input.lessonContent, 20, 50_000),
      idempotency_key: learningOperationKey("web-knowledge-prepare"),
    });

    return NextResponse.json(
      {
        ...result,
        knowledgeStatus: "course_draft_prepared",
        embeddingStatus: "not_requested",
        retrievalStatus: "not_available",
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
