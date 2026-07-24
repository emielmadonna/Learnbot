import {
  PrivacyLifecycleError,
  type PrivacyPurpose,
} from "@course-ai/privacy-lifecycle";
import { NextResponse } from "next/server";

import {
  consumeDangerousPreview,
  createPrivacyJob,
  createPrivacyPreview,
  executePrivacyJob,
  getPrivacyDemoRuntime,
  privacyDemoSnapshot,
  requiredPurpose,
  verifyPrivacyManifest,
} from "../../../../lib/privacy-demo/runtime";
import type {
  PrivacyDemoOperation,
} from "../../../../lib/privacy-demo/types";
import {
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";

const MAX_BODY_BYTES = 16_384;

class PrivacyDemoRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyDemoRequestError";
  }
}

function invalidRequest(message: string): never {
  throw new PrivacyDemoRequestError(message);
}

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) invalidRequest(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") invalidRequest(`${field} must be a string.`);
  const normalized = value.trim();
  if (options.required && normalized.length === 0) {
    invalidRequest(`${field} is required.`);
  }
  if (normalized.length > maximum) {
    invalidRequest(`${field} exceeds the allowed length.`);
  }
  return normalized || undefined;
}

async function readBoundedObject(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    invalidRequest("Privacy request body exceeds the allowed size.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    invalidRequest("Privacy request body exceeds the allowed size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalidRequest("Privacy request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalidRequest("Privacy request body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function privacyErrorResponse(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : undefined;
  if (
    error instanceof PrivacyLifecycleError ||
    (typeof code === "string" && code.startsWith("privacy."))
  ) {
    const privacyCode =
      typeof code === "string" ? code : "privacy.invalid_input";
    const status =
      privacyCode === "privacy.cross_tenant" ||
      privacyCode === "privacy.unauthorized"
        ? 403
        : privacyCode === "privacy.job_not_found" ||
            privacyCode === "privacy.manifest_not_found"
          ? 404
          : privacyCode === "privacy.idempotency_conflict" ||
              privacyCode === "privacy.version_conflict"
            ? 409
            : 422;
    return NextResponse.json(
      {
        error: "PrivacyLifecycleError",
        code: privacyCode,
        message:
          error instanceof Error
            ? error.message
            : "Privacy lifecycle operation failed.",
      },
      { status },
    );
  }
  const developmentStatus = developmentApiErrorStatus(error);
  if (developmentStatus === 403 || developmentStatus === 409) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentStatus,
    });
  }
  if (error instanceof PrivacyDemoRequestError) {
    return NextResponse.json(
      {
        error: "PrivacyDemoValidationError",
        code: "privacy.demo_invalid_request",
        message: error.message,
      },
      { status: 422 },
    );
  }
  return NextResponse.json(
    {
      error: "PrivacyDemoError",
      code: "privacy.demo_failure",
      message: "Privacy fixture request could not be processed.",
    },
    { status: 500 },
  );
}

function validOperation(value: unknown): value is PrivacyDemoOperation {
  return (
    value === "access" ||
    value === "export" ||
    value === "delete" ||
    value === "retention"
  );
}

function validPurpose(value: unknown): value is PrivacyPurpose {
  return (
    value === "tenant_privacy_administration" ||
    value === "retention_enforcement"
  );
}

async function runtimeFor(request: Request, permission: "audit.read" | "tenant.write") {
  const session = await requireDevSession(request, {
    principal: "owner",
    permission,
  });
  const runtime = await getPrivacyDemoRuntime(
    session.context.tenantId,
    requireDevActorId(session),
  );
  return { runtime, session };
}

export async function GET(request: Request) {
  try {
    const { runtime, session } = await runtimeFor(request, "audit.read");
    return NextResponse.json(
      await privacyDemoSnapshot(runtime, {
        tenantSlug: session.identity.tenant.slug,
        ...(session.identity.principal.displayName
          ? { actorDisplayName: session.identity.principal.displayName }
          : {}),
        membershipRole: session.identity.role,
      }),
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return privacyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const inputObject = await readBoundedObject(request);
    const action = boundedString(inputObject.action, "action", 32, {
      required: true,
    });
    const { runtime, session } = await runtimeFor(request, "tenant.write");
    assertDevTenantMatch(session, tenantClaimFromBody(inputObject));

    if (action === "preview") {
      const operation = inputObject.operation;
      const purpose = inputObject.purpose;
      if (!validOperation(operation) || !validPurpose(purpose)) {
        invalidRequest("A supported operation and exact purpose are required.");
      }
      if (purpose !== requiredPurpose(operation)) {
        invalidRequest(
          `Purpose must be ${requiredPurpose(operation)} for ${operation}.`,
        );
      }
      const subjectId = boundedString(inputObject.subjectId, "subjectId", 128);
      const dataThrough = boundedString(
        inputObject.dataThrough,
        "dataThrough",
        64,
      );
      if (dataThrough && !Number.isFinite(Date.parse(dataThrough))) {
        invalidRequest("dataThrough must be a valid timestamp.");
      }
      return NextResponse.json({
        preview: await createPrivacyPreview(runtime, {
          operation,
          purpose,
          ...(subjectId ? { subjectId } : {}),
          ...(dataThrough ? { dataThrough } : {}),
        }),
      });
    }

    if (action === "create") {
      const operation = inputObject.operation;
      const purpose = inputObject.purpose;
      if (!validOperation(operation) || !validPurpose(purpose)) {
        invalidRequest("A supported operation and exact purpose are required.");
      }
      if (purpose !== requiredPurpose(operation)) {
        invalidRequest(
          `Purpose must be ${requiredPurpose(operation)} for ${operation}.`,
        );
      }
      const idempotencyKey = boundedString(
        inputObject.idempotencyKey,
        "idempotencyKey",
        128,
        { required: true },
      )!;
      const subjectId = boundedString(inputObject.subjectId, "subjectId", 128);
      const dataThrough = boundedString(
        inputObject.dataThrough,
        "dataThrough",
        64,
      );
      if (dataThrough && !Number.isFinite(Date.parse(dataThrough))) {
        invalidRequest("dataThrough must be a valid timestamp.");
      }
      let confirmationGrantId: string | undefined;
      if (operation === "delete" || operation === "retention") {
        const previewToken = boundedString(
          inputObject.previewToken,
          "previewToken",
          128,
          { required: true },
        )!;
        const confirmationPhrase = boundedString(
          inputObject.confirmationPhrase,
          "confirmationPhrase",
          256,
          { required: true },
        )!;
        const preview = consumeDangerousPreview(runtime, {
          previewToken,
          confirmationPhrase,
          operation,
          purpose,
          ...(subjectId ? { subjectId } : {}),
          ...(dataThrough ? { dataThrough } : {}),
        });
        confirmationGrantId = preview.confirmationGrantId;
      }
      const job = await createPrivacyJob(runtime, {
        operation,
        purpose,
        ...(subjectId ? { subjectId } : {}),
        ...(dataThrough ? { dataThrough } : {}),
        idempotencyKey,
        ...(confirmationGrantId ? { confirmationGrantId } : {}),
      });
      return NextResponse.json({ job }, { status: 201 });
    }

    if (action === "execute") {
      const jobId = boundedString(inputObject.jobId, "jobId", 128, {
        required: true,
      })!;
      return NextResponse.json({
        job: await executePrivacyJob(runtime, jobId),
      });
    }

    if (action === "verify_manifest") {
      const manifestId = boundedString(
        inputObject.manifestId,
        "manifestId",
        128,
        { required: true },
      )!;
      return NextResponse.json({
        verification: await verifyPrivacyManifest(runtime, manifestId),
      });
    }

    invalidRequest("Unsupported privacy fixture action.");
  } catch (error) {
    return privacyErrorResponse(error);
  }
}
