import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { readSupabasePublicConfig } from "../../../../lib/supabase/config";
import {
  MAX_SCANNABLE_BYTES,
  resolveScanProvider,
} from "../../../../lib/security/scan-provider";
import { ingestionErrorResponse, isRecord, uuid } from "../shared";

/**
 * The malware scan checkpoint (Phase 17, docs/PLAN.md Section 11) -- the gate
 * standing in front of the finished Phase 10 pipeline.
 *
 * Authority is split on purpose, and the split is the whole design:
 *
 *   * The **creator's own session** downloads the quarantined object. This is
 *     the same call `api/ingestion/extract` already makes, under the same RLS,
 *     with no service-role bypass. It has to be this way: there is no
 *     service-role key in this system, and `test/supabase-auth-boundary.test.ts`
 *     asserts there never is one, so a session-less worker could not read the
 *     bytes at all.
 *
 *   * The **server's operation secret** records the verdict, through
 *     `security_record_scan_result`, which is not granted to `authenticated`.
 *
 * So a creator can ask for their own file to be scanned and cannot influence
 * the answer. The verdict is produced by the scanner and written by the
 * server; nothing in the request body reaches the checkpoint.
 *
 * Fails closed everywhere: unconfigured scanner, oversized file, unreachable
 * scanner and unrecognised scanner output all leave the gate shut. The only
 * path to `succeeded` is a scanner that affirmatively said "clean".
 */

const SCAN_OPERATION_TOKEN_ENV = "LEARNINGBOT_MALWARE_SCAN_OPERATION_TOKEN";

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    const filename = detail.filename;
    if (typeof objectKey !== "string" || typeof mediaType !== "string") {
      throw new LearningRpcError("object_not_found");
    }

    // Already cleared: report it rather than paying to scan the file twice.
    if (detail.malwareScanStatus === "succeeded") {
      return NextResponse.json(
        { ok: true, verdict: "clean", checkpointStatus: "succeeded", cached: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Inert text clears itself. `security_clear_inert_source` re-reads the
    // media type from the upload record and refuses anything not on its own
    // allowlist, so this is a proportionate gate rather than a bypass: the
    // caller cannot talk its way past it, and the clearance is recorded as
    // `scanner: 'none', reason: 'inert_text'` for anyone auditing later.
    //
    // Trying this first is what keeps a plain .txt upload from requiring an
    // operator to run a virus scanner. Anything the database declines here
    // falls through to the real scanner below.
    const inert = await supabase.rpc("security_clear_inert_source", {
      target_job_id: jobId,
    });
    if (!inert.error && isRecord(inert.data) && inert.data.ok === true) {
      return NextResponse.json(
        {
          ok: true,
          verdict: "clean",
          checkpointStatus: "succeeded",
          scanner: "none",
          reason: "inert_text",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (isRecord(inert.data) && inert.data.code === "upload_blocked") {
      throw new LearningRpcError("access_denied");
    }

    // Not inert: a real scanner is required, and an unconfigured one is a
    // closed gate rather than an open one.
    const operationToken = process.env[SCAN_OPERATION_TOKEN_ENV]?.trim() ?? "";
    if (operationToken.length < 32) {
      throw new LearningRpcError("scanner_not_configured");
    }
    const provider = resolveScanProvider();
    if (!provider) {
      throw new LearningRpcError("scanner_not_configured");
    }

    const download = await supabase.storage.from("tenant-private").download(objectKey);
    if (download.error || !download.data) {
      throw new LearningRpcError("object_not_found");
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCANNABLE_BYTES) {
      throw new LearningRpcError("unscannable_size");
    }

    const contentSha256 = await sha256Hex(bytes);
    const outcome = await provider.scan({
      bytes,
      filename: typeof filename === "string" ? filename : "upload",
      mediaType,
    });

    // Second client, deliberately: the verdict is written with the server's
    // operation secret over the anon key, never with the creator's session.
    // `security_record_scan_result` is revoked from `authenticated`, so this
    // is not merely convention -- the session literally cannot make this call.
    const { url, publishableKey } = readSupabasePublicConfig();
    const operations = createClient(url, publishableKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });

    const recorded = await operations.rpc("security_record_scan_result", {
      operation_token: operationToken,
      target_job_id: jobId,
      content_sha256: contentSha256,
      verdict: outcome.verdict,
      scanner_name: outcome.scannerName,
      scanner_version: outcome.scannerVersion ?? null,
      detail: outcome.findings ?? {},
    });
    if (recorded.error || !isRecord(recorded.data) || recorded.data.ok !== true) {
      throw new LearningRpcError("scan_record_failed");
    }

    return NextResponse.json(
      {
        ok: true,
        verdict: outcome.verdict,
        checkpointStatus: recorded.data.checkpointStatus ?? null,
        scanner: outcome.scannerName,
        contentSha256,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
