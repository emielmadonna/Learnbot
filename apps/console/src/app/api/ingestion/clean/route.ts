import { NextResponse } from "next/server";
import { runCleaningPipeline } from "../../../../lib/ingestion/clean/pipeline";
import type { BoilerplateShingleCounts } from "../../../../lib/ingestion/types";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { ingestionErrorResponse, isRecord, uuid } from "../shared";

/**
 * Stage 3 (Clean), docs/PLAN.md Section 4. Runs the ordered cleaning
 * pipeline (disfluencies, false starts, transcription furniture,
 * boilerplate, sentence repair, structure recovery) over the stored raw
 * text and persists the result as a NEW revision — cleaning never rewrites
 * `ingestion_extractions.raw_text`.
 *
 * Boilerplate detection needs this creator's own prior-occurrence counts,
 * which depend on which paragraphs THIS document even proposes as
 * candidates. Disfluency/false-start/furniture removal is independent of
 * those counts, so the candidate set is identical either way — the
 * pipeline runs twice: once with no prior counts purely to discover
 * candidate hashes, then again with the real counts once they're fetched.
 */
export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const jobId = uuid(input.jobId);

    const revisionState = await executeLearningRpc(supabase, "learning_ingestion_get_revision", {
      target_job_id: jobId,
    });
    const rawText = revisionState.rawText;
    if (typeof rawText !== "string" || rawText.length === 0) {
      throw new LearningRpcError("extraction_not_found");
    }

    const discovery = runCleaningPipeline(rawText, {});
    const candidateHashes = Array.from(
      new Set(discovery.shingleUpdates.map((update) => update.shingleHash)),
    );

    let priorCounts: BoilerplateShingleCounts = {};
    if (candidateHashes.length > 0) {
      const shingleResponse = await executeLearningRpc(
        supabase,
        "learning_ingestion_boilerplate_shingles",
        { candidate_hashes: candidateHashes },
      );
      const counts = shingleResponse.counts;
      if (isRecord(counts)) {
        priorCounts = Object.fromEntries(
          Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
        );
      }
    }

    const cleaned = runCleaningPipeline(rawText, priorCounts);

    const result = await executeLearningRpc(supabase, "learning_ingestion_record_cleaning", {
      target_job_id: jobId,
      requested_cleaner_version: cleaned.cleanerVersion,
      requested_cleaned_text: cleaned.cleanedText,
      requested_steps: cleaned.steps,
      requested_diff: cleaned.diff,
      requested_offset_map: cleaned.offsetMap,
      requested_content_hash: cleaned.contentHash,
      requested_shingle_updates: cleaned.shingleUpdates,
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return ingestionErrorResponse(error, "api/ingestion/clean");
  }
}

