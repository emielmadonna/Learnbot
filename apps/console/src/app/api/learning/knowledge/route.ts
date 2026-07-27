import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

/**
 * Projection state for the signed-in tenant's courses.
 *
 * This is the surface that makes the previously silent failure visible: whether
 * a published course is actually answerable, how much of it has been embedded,
 * and whether it has drifted since it was last projected. GET is read-only and
 * gated by the same authoring context every editing RPC enforces.
 *
 * POST re-projects one course. It exists for the two cases GET can report and
 * publishing alone cannot fix: a projection that failed and left the course on
 * its previous knowledge version, and a course whose active knowledge version
 * was built by an import rather than by authoring, which the projector refuses
 * to replace unless a human says so.
 */

function optionalUuid(value: string | null) {
  if (value === null || value === "") return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function requiredUuid(value: unknown) {
  if (typeof value !== "string") throw new LearningRpcError("invalid_request");
  const resolved = optionalUuid(value);
  if (resolved === null) throw new LearningRpcError("invalid_request");
  return resolved;
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

function errorResponse(error: unknown) {
  const status =
    error instanceof AuthenticationBoundaryError
      ? 401
      : error instanceof LearningRpcError &&
          error.code === "tenant_selection_required"
        ? 409
        : error instanceof LearningRpcError && error.code === "access_denied"
          ? 403
          : 400;
  return NextResponse.json(
    {
      ok: false,
      code:
        status === 401
          ? "authentication_required"
          : status === 409
            ? "tenant_selection_required"
            : status === 403
              ? "access_denied"
              : "knowledge_request_denied",
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const courseId = optionalUuid(
      new URL(request.url).searchParams.get("courseId"),
    );
    const result = await executeLearningRpc(
      supabase,
      "learning_course_knowledge_state",
      { target_course_id: courseId },
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
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
    const input = (await request.json()) as {
      courseId?: unknown;
      idempotencyKey?: unknown;
      replaceImportedKnowledge?: unknown;
    };
    const result = await executeLearningRpc(
      supabase,
      "learning_project_course_knowledge",
      {
        target_course_id: requiredUuid(input.courseId),
        idempotency_key: idempotencyKey(input.idempotencyKey),
        replace_imported_knowledge: input.replaceImportedKnowledge === true,
      },
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
