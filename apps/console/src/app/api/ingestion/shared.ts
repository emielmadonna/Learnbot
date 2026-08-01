import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../lib/supabase/auth-boundary";
import { LearningRpcError } from "../../../lib/supabase/learning-rpc";
import { reportUnexpectedError } from "../../../lib/observability/error-reporter";

const safeCodes = new Set([
  "access_denied",
  "invalid_request",
  "extraction_not_found",
  "revision_not_pending",
  "security_scan_pending",
  "course_not_found",
  "unsupported_media_type",
  "document_extraction_failed",
  "document_has_no_extractable_text",
  "document_page_limit_exceeded",
  "object_not_found",
  // Phase 17 scan checkpoint. Each of these means "the gate stayed shut", and
  // a creator staring at a stuck upload deserves to know which one it was --
  // "no scanner is configured" and "your file is too big to scan" are very
  // different problems, and collapsing both to request_failed hides an
  // operator misconfiguration behind what looks like a user error.
  "scanner_not_configured",
  "unscannable_size",
  "scan_record_failed",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function uuid(value: unknown): string {
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

export function ingestionErrorResponse(error: unknown, route?: string) {
  // Anything that is not a known code is a bug, not a refusal. Those are the
  // ones worth recording — the safe codes above are the pipeline's gates
  // working as designed, and reporting them would bury the real failures.
  const expected =
    error instanceof AuthenticationBoundaryError ||
    (error instanceof LearningRpcError && safeCodes.has(error.code));
  if (!expected) {
    reportUnexpectedError({
      error,
      source: "api",
      route: route ?? "api/ingestion",
      severity: "error",
    });
  }

  if (error instanceof AuthenticationBoundaryError) {
    return NextResponse.json(
      { ok: false, code: "authentication_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof LearningRpcError) {
    const code = safeCodes.has(error.code) ? error.code : "request_failed";
    const status =
      code === "access_denied"
        ? 403
        : code === "security_scan_pending"
          ? 409
          : code === "extraction_not_found" || code === "course_not_found"
            ? 404
            : // An unconfigured scanner is the operator's problem, not the
              // caller's, and a failed verdict write is an upstream failure.
              // Both are retryable; neither is a malformed request.
              code === "scanner_not_configured"
              ? 503
              : code === "scan_record_failed"
                ? 502
                : 400;
    return NextResponse.json(
      { ok: false, code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_failed" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
