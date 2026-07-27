/**
 * The malware scanner seam (Phase 17, docs/PLAN.md Section 11).
 *
 * Section 4's rule is that no file is promoted or parsed before a scanner
 * clears it, and migration 20260727090000 enforces that in SQL: extraction
 * refuses with `security_scan_pending` until the `security` / `malware_scan`
 * checkpoint succeeds. This module is the thing that produces that verdict.
 *
 * It is a contract plus one adapter, not a scanner. Scanning is a job for
 * software that maintains signature databases, and nothing in this repository
 * should pretend to do that.
 *
 * FAIL CLOSED. If no scanner is configured, `resolveScanProvider()` returns
 * null and the route refuses the request. It never falls back to "assume
 * clean" -- an unconfigured scanner is the same as a failed scan, and the
 * whole point of the gate is that files do not get through unchecked.
 */

export type ScanVerdict = "clean" | "infected" | "unscannable";

export type ScanOutcome = {
  readonly verdict: ScanVerdict;
  readonly scannerName: string;
  readonly scannerVersion?: string;
  /** Bounded, structured detail. Never raw scanner stdout. */
  readonly findings?: Record<string, unknown>;
};

export type ScanInput = {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
};

export interface ScanProvider {
  readonly name: string;
  scan(input: ScanInput): Promise<ScanOutcome>;
}

/** Anything larger is refused rather than streamed into a scanner. */
export const MAX_SCANNABLE_BYTES = 64 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Adapter for an HTTP-fronted ClamAV (`clamav-rest`, `clamd` behind a shim, or
 * any endpoint with the same shape): POST the bytes as multipart form-data,
 * get a verdict back.
 *
 * Deliberately tolerant about the response shape, because these shims disagree
 * with each other -- some return JSON, some a bare string, some encode the
 * verdict only in the status code. What it is NOT tolerant about is ambiguity:
 * anything it cannot confidently read as "clean" or "infected" becomes
 * `unscannable`, which leaves the gate shut. A scanner that returns something
 * unexpected must never be mistaken for a scanner that returned "fine".
 */
function clamavHttpProvider(endpoint: string): ScanProvider {
  return {
    name: "clamav-http",
    async scan({ bytes, filename, mediaType }) {
      const body = new FormData();
      body.append(
        "file",
        new Blob([bytes as BlobPart], { type: mediaType || "application/octet-stream" }),
        filename || "upload",
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          body,
          signal: controller.signal,
        });
      } catch (error) {
        return {
          verdict: "unscannable",
          scannerName: "clamav-http",
          findings: {
            reason: "scanner_unreachable",
            detail:
              error instanceof Error ? error.message.slice(0, 200) : "fetch_failed",
          },
        };
      } finally {
        clearTimeout(timer);
      }

      const text = (await response.text()).slice(0, 2_000);
      const lowered = text.toLowerCase();

      // Explicit detection markers win over status codes: clamav-rest returns
      // 406 for an infected file, which is not an error condition here.
      if (lowered.includes("found") || lowered.includes("infected")) {
        return {
          verdict: "infected",
          scannerName: "clamav-http",
          findings: { signature: text.trim().slice(0, 300) },
        };
      }
      if (
        response.ok &&
        (lowered.includes("ok") || lowered.includes("clean") || lowered.includes("no virus"))
      ) {
        return { verdict: "clean", scannerName: "clamav-http" };
      }
      return {
        verdict: "unscannable",
        scannerName: "clamav-http",
        findings: {
          reason: "unrecognised_response",
          status: response.status,
          body: text.trim().slice(0, 300),
        },
      };
    },
  };
}

/**
 * Returns null when no scanner is configured. Callers must treat null as
 * "refuse", never as "allow".
 */
export function resolveScanProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ScanProvider | null {
  const endpoint = env.LEARNINGBOT_MALWARE_SCANNER_URL?.trim();
  if (endpoint && /^https?:\/\//i.test(endpoint)) {
    return clamavHttpProvider(endpoint);
  }
  return null;
}

/** Exported for tests; the shape checks above are the security-relevant part. */
export const __testing = { clamavHttpProvider };
