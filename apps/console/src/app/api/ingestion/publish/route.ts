import { NextResponse } from "next/server";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { ingestionErrorResponse, isRecord, uuid } from "../shared";

/**
 * Stage 5 (Publish), docs/PLAN.md Section 4. Projects every approved
 * cleaning revision for this course into `knowledge_versions` /
 * `learning_documents` / `learning_chunks` — the same path authored content
 * already uses, reused rather than duplicated
 * (`app_private.knowledge_project_ingested_course`).
 */
export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const courseId = uuid(input.courseId);
    const replaceAuthoredKnowledge = input.replaceAuthoredKnowledge === true;
    const idempotencyKey =
      typeof input.idempotencyKey === "string" && input.idempotencyKey.length >= 8
        ? input.idempotencyKey
        : `ingestion-publish:${courseId}:${Date.now()}`;

    const result = await executeLearningRpc(supabase, "learning_ingestion_publish", {
      target_course_id: courseId,
      requested_idempotency_key: idempotencyKey,
      replace_authored_knowledge: replaceAuthoredKnowledge,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
