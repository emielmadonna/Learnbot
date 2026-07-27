import { NextResponse } from "next/server";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { ingestionErrorResponse } from "../shared";

/**
 * Stage 4 (Review) queue, docs/PLAN.md Section 4: every cleaning revision
 * still awaiting the creator's approval, across every course they can see.
 */
export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const result = await executeLearningRpc(supabase, "learning_ingestion_review_queue");
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return ingestionErrorResponse(error, "api/ingestion/review");
  }
}
