import { NextResponse } from "next/server";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../../lib/supabase/learning-rpc";
import { ingestionErrorResponse, isRecord, uuid } from "../../shared";

/**
 * Stage 4 (Review) detail, docs/PLAN.md Section 4: raw text, the latest
 * cleaning revision, its ordered step log and the raw-vs-cleaned diff — the
 * creator sees cleaned beside original with removals highlighted here.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const { jobId } = await context.params;
    const result = await executeLearningRpc(supabase, "learning_ingestion_get_revision", {
      target_job_id: uuid(jobId),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}

/**
 * Approve — or edit and approve — the latest cleaning revision. Nothing
 * reaches students until this succeeds; publishing (stage 5) only ever
 * reads revisions with status `approved` or `edited_approved`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const { jobId } = await context.params;
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const revisionId = uuid(input.revisionId);
    const editedText =
      typeof input.editedText === "string" && input.editedText.trim() !== ""
        ? input.editedText
        : null;

    const result = await executeLearningRpc(supabase, "learning_ingestion_approve_revision", {
      target_job_id: uuid(jobId),
      target_revision_id: revisionId,
      requested_edited_text: editedText,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
