import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  prepareTenantDataExport,
  type ExportFormat,
  type TenantDataExport,
} from "../../../../lib/settings/tenant-settings-rpc";

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["exports_disabled", 409],
  ["invalid_request", 400],
  ["tenant_selection_required", 409],
  ["request_failed", 503],
  ["invalid_response", 502],
]);

function jsonResponse(body: unknown, status = 200) {
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
    return jsonResponse({ ok: false, code: failure.code }, failure.status);
  }
  if (error instanceof LearningRpcError) {
    return jsonResponse(
      { ok: false, code: error.code },
      statusByCode.get(error.code) ?? 400,
    );
  }
  return jsonResponse({ ok: false, code: "request_failed" }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "json" || value === "csv";
}

function csvCell(value: string) {
  const protectedValue = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

function toCsv(snapshot: TenantDataExport) {
  const lines = [
    ["category", "record_id", "data"].map(csvCell).join(","),
    ...snapshot.records.map((record) =>
      [
        record.category,
        record.recordId,
        JSON.stringify(record.data),
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const input = (await request.json()) as unknown;
    if (!isRecord(input) || !isExportFormat(input.format)) {
      throw new LearningRpcError("invalid_request");
    }

    const snapshot = await prepareTenantDataExport(supabase, input.format);
    const filename = `${snapshot.tenantSlug}-data-export-${snapshot.generatedAt.slice(0, 10)}.${input.format}`;
    const body =
      input.format === "csv"
        ? toCsv(snapshot)
        : JSON.stringify(
            {
              version: 1,
              generatedAt: snapshot.generatedAt,
              workspace: {
                tenantId: snapshot.tenantId,
                slug: snapshot.tenantSlug,
                retentionDays: snapshot.retentionDays,
              },
              recordCount: snapshot.recordCount,
              truncated: snapshot.truncated,
              records: snapshot.records,
            },
            null,
            2,
          );

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type":
          input.format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Record-Count": String(snapshot.recordCount),
        "X-Export-Truncated": String(snapshot.truncated),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
