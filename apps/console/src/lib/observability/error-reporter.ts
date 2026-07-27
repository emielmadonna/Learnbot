/**
 * Error reporting into `public.error_events`.
 *
 * Two rules govern everything here.
 *
 * 1. **Reporting must never break the request it is reporting on.** Every
 *    export swallows its own failures. An observability layer that can throw
 *    turns one broken endpoint into two.
 * 2. **The browser cannot write here.** `observability_record_error` is revoked
 *    from `authenticated`; this module runs server-side and authenticates with
 *    an operation secret, the same posture as the malware-scan verdict writer.
 *    Client errors have to be relayed through a server route.
 */

import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { readSupabasePublicConfig } from "../supabase/config";

const ERROR_INTAKE_TOKEN_ENV = "LEARNINGBOT_ERROR_INTAKE_OPERATION_TOKEN";

export type ErrorSource = "api" | "worker" | "edge" | "client";
export type ErrorSeverity = "warning" | "error" | "fatal";

export type ReportErrorInput = {
  error: unknown;
  source: ErrorSource;
  severity?: ErrorSeverity;
  route?: string;
  tenantId?: string | null;
  traceId?: string | null;
  requestId?: string | null;
  /**
   * Supply this when the caller can be retried. Two attempts at the same unit
   * of work then record one occurrence rather than inflating the count.
   */
  occurrenceKey?: string | null;
  context?: Record<string, unknown>;
};

export type ReportErrorResult =
  | { reported: true; fingerprint: string }
  | { reported: false; reason: string };

/**
 * Frames carry absolute paths, line numbers and build hashes, all of which
 * change between deployments. Grouping on the raw stack would make every
 * release look like a brand new set of errors, which is the failure mode that
 * makes error tracking useless. Normalizing keeps the shape and drops the
 * things that legitimately move.
 */
export function normalizeStack(stack: string | undefined, limit = 12): string {
  if (!stack) return "";
  return stack
    .split("\n")
    .slice(1) // line 0 is the message, which often embeds an id
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, limit)
    .map((line) =>
      line
        // Collapse any absolute path down to the repo-relative part.
        .replace(/\(?(?:file:\/\/)?\/[^\s()]*?((?:apps|packages|node_modules)\/)/g, "($1")
        // Line and column numbers move on every edit.
        .replace(/:\d+:\d+\)?$/, ")")
        // Webpack/Turbopack chunk ids and other hex blobs.
        .replace(/\b[0-9a-f]{8,}\b/gi, "*"),
    )
    .join("\n");
}

export function errorKindOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || "Error";
  }
  if (typeof error === "string") return "StringThrow";
  if (error === null) return "NullThrow";
  return typeof error === "object" ? "ObjectThrow" : `${typeof error}Throw`;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The grouping key. Derived from the error kind and the normalized stack only
 * — the database mixes in environment, source and route itself, so this stays
 * a statement about the code path and nothing else.
 */
export async function stackDigestOf(error: unknown): Promise<string> {
  const stack = error instanceof Error ? error.stack : undefined;
  const normalized = normalizeStack(stack);
  return sha256Hex(`${errorKindOf(error)}\n${normalized}`);
}

function resolveEnvironmentName(): string {
  return (
    process.env.LEARNINGBOT_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "development"
  );
}

function resolveReleaseRef(): string | null {
  const sha =
    process.env.LEARNINGBOT_RELEASE_REF?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    "";
  return sha ? sha.slice(0, 40) : null;
}

export async function reportError(
  input: ReportErrorInput,
): Promise<ReportErrorResult> {
  try {
    const operationToken = process.env[ERROR_INTAKE_TOKEN_ENV]?.trim() ?? "";
    if (operationToken.length < 32) {
      // Not configured is not an error worth crashing on, but it is worth
      // being able to see, so it is named rather than silently ignored.
      return { reported: false, reason: "intake_not_configured" };
    }

    const { url, publishableKey } = readSupabasePublicConfig();
    const operations = createClient(url, publishableKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });

    const thrown = input.error;
    const response = await operations.rpc("observability_record_error", {
      operation_token: operationToken,
      environment: resolveEnvironmentName(),
      source: input.source,
      severity: input.severity ?? "error",
      error_kind: errorKindOf(thrown),
      stack_digest: await stackDigestOf(thrown),
      message: errorMessageOf(thrown).slice(0, 2000),
      stack:
        thrown instanceof Error && thrown.stack
          ? thrown.stack.slice(0, 8000)
          : null,
      route: input.route ?? null,
      target_tenant_id: input.tenantId ?? null,
      release_ref: resolveReleaseRef(),
      trace_id: input.traceId ?? null,
      request_id: input.requestId ?? null,
      context: input.context ?? {},
      occurrence_key: input.occurrenceKey ?? null,
    });

    if (response.error) {
      return { reported: false, reason: "intake_unreachable" };
    }
    const data = response.data;
    if (
      typeof data !== "object" ||
      data === null ||
      (data as { ok?: unknown }).ok !== true
    ) {
      return { reported: false, reason: "intake_rejected" };
    }
    const fingerprint = (data as { fingerprint?: unknown }).fingerprint;
    return {
      reported: true,
      fingerprint: typeof fingerprint === "string" ? fingerprint : "",
    };
  } catch {
    return { reported: false, reason: "intake_threw" };
  }
}

/**
 * Fire-and-forget reporting from a route's catch block.
 *
 * Scheduled with `after()` so the report never delays the response the user is
 * waiting on, and — importantly on serverless — is not cut off when the
 * handler returns. A bare floating promise would frequently be killed by the
 * freeze before it reached the database, which is the failure mode where the
 * errors you most want are the ones you never see.
 *
 * Returns nothing on purpose. There is no outcome a caller should branch on:
 * the request has already failed, and the reporting result is not the caller's
 * problem.
 */
export function reportUnexpectedError(input: ReportErrorInput): void {
  try {
    after(async () => {
      await reportError(input);
    });
  } catch {
    // `after()` throws outside a request scope (unit tests, scripts). Falling
    // back to a floating promise is correct there: nothing is about to freeze.
    void reportError(input).catch(() => undefined);
  }
}
