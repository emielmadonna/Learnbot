import { NextResponse } from "next/server";

import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  getWidgetSettings,
  WidgetRpcError,
} from "../../../../lib/supabase/widget-rpc";

export const dynamic = "force-dynamic";

type Publication = {
  slug: string;
  status: "published" | "unpublished";
  hostedPath: string;
  publishedAt: string | null;
  unpublishedAt: string | null;
  updatedAt: string;
};

type PublicationSnapshot = {
  ok: true;
  dataMode: "durable";
  expectedVersion: number;
  publication: Publication | null;
};

const safeCodes = new Set([
  "access_denied",
  "idempotency_conflict",
  "invalid_request",
  "invalid_slug",
  "origin_not_allowed",
  "publication_not_found",
  "request_failed",
  "slug_change_required",
  "slug_unavailable",
  "tenant_not_found",
  "tenant_selection_required",
  "version_conflict",
  "widget_not_ready",
]);

class HostedPublicationError extends Error {
  constructor(readonly code: string) {
    super(`Hosted publication request denied: ${code}`);
    this.name = "HostedPublicationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isRecord(candidate) ? candidate : null;
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseSnapshot(value: unknown): PublicationSnapshot {
  const record = firstRecord(value);
  if (record === null) throw new HostedPublicationError("request_failed");
  if (record.ok !== true) {
    throw new HostedPublicationError(
      typeof record.code === "string" && safeCodes.has(record.code)
        ? record.code
        : "request_failed",
    );
  }
  if (
    record.dataMode !== "durable" ||
    typeof record.expectedVersion !== "number" ||
    !Number.isSafeInteger(record.expectedVersion) ||
    record.expectedVersion < 0
  ) {
    throw new HostedPublicationError("request_failed");
  }

  if (record.publication === null) {
    return {
      ok: true,
      dataMode: "durable",
      expectedVersion: record.expectedVersion,
      publication: null,
    };
  }
  if (!isRecord(record.publication)) {
    throw new HostedPublicationError("request_failed");
  }
  const publication = record.publication;
  if (
    typeof publication.slug !== "string" ||
    (publication.status !== "published" &&
      publication.status !== "unpublished") ||
    publication.hostedPath !== `/c/${publication.slug}` ||
    !nullableTimestamp(publication.publishedAt) ||
    !nullableTimestamp(publication.unpublishedAt) ||
    typeof publication.updatedAt !== "string"
  ) {
    throw new HostedPublicationError("request_failed");
  }
  return {
    ok: true,
    dataMode: "durable",
    expectedVersion: record.expectedVersion,
    publication: {
      slug: publication.slug,
      status: publication.status,
      hostedPath: publication.hostedPath,
      publishedAt: publication.publishedAt,
      unpublishedAt: publication.unpublishedAt,
      updatedAt: publication.updatedAt,
    },
  };
}

function responseEnvelope(snapshot: PublicationSnapshot, request: Request) {
  const hostedOrigin = new URL(request.url).origin;
  return {
    ...snapshot,
    hostedOrigin,
    hostedUrl:
      snapshot.publication === null
        ? null
        : `${hostedOrigin}${snapshot.publication.hostedPath}`,
    originAllowlistValue: hostedOrigin,
  };
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      {
        status: failure.status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  if (error instanceof WidgetRpcError) {
    return errorResponse(new HostedPublicationError(error.code));
  }
  const code =
    error instanceof HostedPublicationError && safeCodes.has(error.code)
      ? error.code
      : "request_failed";
  const status =
    code === "request_failed"
      ? 503
      : code === "access_denied"
        ? 403
        : code === "publication_not_found"
          ? 404
          : code === "invalid_request" || code === "invalid_slug"
            ? 400
            : 409;
  return NextResponse.json(
    { ok: false, code },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function operationFields(value: unknown) {
  const operationId =
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 120 &&
    /^[A-Za-z0-9:_-]+$/u.test(value)
      ? value
      : crypto.randomUUID();
  return {
    idempotency_key: `hosted-publication:${operationId}`,
    request_id: `hosted-publication:${operationId}`,
    trace_id: `web:${crypto.randomUUID()}`,
  };
}

function expectedVersion(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new HostedPublicationError("invalid_request");
  }
  return value;
}

function requestedAction(value: unknown) {
  if (
    value !== "publish" &&
    value !== "unpublish" &&
    value !== "change_slug"
  ) {
    throw new HostedPublicationError("invalid_request");
  }
  return value;
}

function requestedSlug(value: unknown, action: string) {
  if (action === "unpublish" && (value === undefined || value === null)) {
    return "";
  }
  if (typeof value !== "string") {
    throw new HostedPublicationError("invalid_request");
  }
  return value.trim().toLowerCase();
}

function originAllowed(allowedOrigins: readonly string[], candidate: string) {
  if (allowedOrigins.includes(candidate)) return true;
  const url = new URL(candidate);
  return allowedOrigins.some((entry) => {
    const match = /^https:\/\/\*\.([a-z0-9.-]+)$/u.exec(entry);
    if (
      match?.[1] === undefined ||
      url.protocol !== "https:" ||
      url.port !== ""
    ) {
      return false;
    }
    const suffix = match[1];
    return url.hostname !== suffix && url.hostname.endsWith(`.${suffix}`);
  });
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const response = await supabase.rpc(
      "tenant_get_hosted_assistant_publication",
    );
    if (response.error) throw new HostedPublicationError("request_failed");
    const snapshot = parseSnapshot(response.data);
    return NextResponse.json(responseEnvelope(snapshot, request), {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new HostedPublicationError("invalid_request");
    const action = requestedAction(input.action);
    if (action !== "unpublish") {
      const widget = await getWidgetSettings(supabase);
      const hostedOrigin = new URL(request.url).origin.toLowerCase();
      if (!originAllowed(widget.settings.allowedOrigins, hostedOrigin)) {
        throw new HostedPublicationError("origin_not_allowed");
      }
    }
    const response = await supabase.rpc(
      "tenant_update_hosted_assistant_publication",
      {
        requested_action: action,
        requested_slug: requestedSlug(input.slug, action),
        expected_version: expectedVersion(input.expectedVersion),
        ...operationFields(input.idempotencyKey),
      },
    );
    if (response.error) throw new HostedPublicationError("request_failed");
    const snapshot = parseSnapshot(response.data);
    return NextResponse.json(responseEnvelope(snapshot, request), {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
