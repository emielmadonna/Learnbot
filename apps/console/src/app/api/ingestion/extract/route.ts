import { NextResponse } from "next/server";
import { extractPlainText, type PlainTextMediaType } from "../../../../lib/ingestion/extract";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { ingestionErrorResponse, isRecord, uuid } from "../shared";

const SUPPORTED_MEDIA_TYPES = new Set(["text/plain", "text/markdown"]);

/**
 * Stage 2 (Extract), docs/PLAN.md Section 4. Downloads the quarantined
 * object with the caller's own authenticated storage session (same RLS the
 * upload itself went through — no service-role bypass), runs the plain-text
 * extractor, and persists the result. The database RPC underneath refuses
 * this unless the malware-scan checkpoint has already succeeded; this
 * repository ships no scanner, so that stays closed until one exists.
 */
export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const jobId = uuid(input.jobId);

    const detail = await executeLearningRpc(supabase, "learning_ingestion_job_detail", {
      target_job_id: jobId,
    });
    const objectKey = detail.objectKey;
    const mediaType = detail.mediaType;
    if (typeof objectKey !== "string" || typeof mediaType !== "string") {
      throw new LearningRpcError("object_not_found");
    }
    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
      throw new LearningRpcError("unsupported_media_type");
    }
    if (detail.malwareScanStatus !== "succeeded") {
      throw new LearningRpcError("security_scan_pending");
    }

    const download = await supabase.storage.from("tenant-private").download(objectKey);
    if (download.error || !download.data) {
      throw new LearningRpcError("object_not_found");
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());

    const extraction = extractPlainText(bytes, mediaType as PlainTextMediaType);

    const result = await executeLearningRpc(supabase, "learning_ingestion_record_extraction", {
      target_job_id: jobId,
      requested_extractor: extraction.extractor,
      requested_extractor_version: extraction.extractorVersion,
      requested_media_type: mediaType,
      requested_raw_text: extraction.rawText,
      requested_source_locations: extraction.sourceLocations,
      requested_content_hash: extraction.contentHash,
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return ingestionErrorResponse(error, "api/ingestion/extract");
  }
}
