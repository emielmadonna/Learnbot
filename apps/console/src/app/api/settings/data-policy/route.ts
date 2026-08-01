import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  getTenantDataPolicy,
  setTenantDataPolicy,
  type ExportFormat,
} from "../../../../lib/settings/tenant-settings-rpc";

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["invalid_request", 400],
  ["tenant_selection_required", 409],
  ["version_conflict", 409],
  ["request_failed", 503],
  ["invalid_response", 502],
]);

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return response({ ok: false, code: failure.code }, failure.status);
  }
  if (error instanceof LearningRpcError) {
    return response(
      { ok: false, code: error.code },
      statusByCode.get(error.code) ?? 400,
    );
  }
  return response({ ok: false, code: "request_failed" }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "json" || value === "csv";
}

export async function GET(request: Request) {
  try {
    if (request.headers.get("origin") !== null) assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request);
    return response(await getTenantDataPolicy(supabase));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const input = (await request.json()) as unknown;
    if (
      !isRecord(input) ||
      !Number.isInteger(input.retentionDays) ||
      Number(input.retentionDays) < 30 ||
      Number(input.retentionDays) > 3650 ||
      typeof input.exportsEnabled !== "boolean" ||
      !isExportFormat(input.defaultExportFormat) ||
      !Number.isInteger(input.expectedVersion) ||
      Number(input.expectedVersion) < 0
    ) {
      throw new LearningRpcError("invalid_request");
    }
    return response(
      await setTenantDataPolicy(supabase, {
        retentionDays: Number(input.retentionDays),
        exportsEnabled: input.exportsEnabled,
        defaultExportFormat: input.defaultExportFormat,
        expectedVersion: Number(input.expectedVersion),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
