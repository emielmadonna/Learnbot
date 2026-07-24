import {
  ONBOARDING_STEP_KEYS,
  OnboardingError,
  type CirclePlan,
  type OnboardingActorRole,
  type OnboardingInvitationRole,
  type OnboardingStepStatus,
} from "@course-ai/onboarding-core";
import { NextResponse } from "next/server";

import {
  getOnboardingFixtureRuntime,
} from "../../../../lib/onboarding-demo/runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
  tenantClaimFromBody,
  type DevelopmentSession,
} from "../../../../lib/dev-session-guard";
import { serializeDevelopmentError } from "../../../../lib/dev-runtime";

const MAX_BODY_BYTES = 16_384;

class OnboardingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingRequestError";
  }
}

const onboardingErrorCodes = new Set<OnboardingError["code"]>([
  "onboarding.access_denied",
  "onboarding.invalid_input",
  "onboarding.not_found",
  "onboarding.conflict",
  "onboarding.idempotency_conflict",
  "onboarding.policy_decision_required",
  "onboarding.launch_blocked",
  "onboarding.durable_adapter_required",
]);

function recognizedOnboardingError(error: unknown): OnboardingError | undefined {
  if (error instanceof OnboardingError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    onboardingErrorCodes.has(error.code as OnboardingError["code"])
  ) {
    return new OnboardingError(
      error.code as OnboardingError["code"],
      error.message,
    );
  }
  return undefined;
}

function invalidRequest(message: string): never {
  throw new OnboardingRequestError(message);
}

async function readBoundedObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    invalidRequest("Onboarding request body exceeds the allowed size.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    invalidRequest("Onboarding request body exceeds the allowed size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalidRequest("Onboarding request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalidRequest("Onboarding request body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function stringValue(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  required = true,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) invalidRequest(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") invalidRequest(`${key} must be a string.`);
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    invalidRequest(`${key} is required.`);
  }
  if (normalized.length > maximum) {
    invalidRequest(`${key} exceeds the allowed length.`);
  }
  return normalized || undefined;
}

function numberValue(
  input: Readonly<Record<string, unknown>>,
  key: string,
  required = true,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) invalidRequest(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRequest(`${key} must be a finite number.`);
  }
  return value;
}

function commandContext(session: DevelopmentSession) {
  const role = session.identity.role;
  if (
    role !== "platform_admin" &&
    role !== "tenant_owner" &&
    role !== "tenant_admin"
  ) {
    invalidRequest("The verified actor cannot manage onboarding.");
  }
  return {
    tenantId: session.context.tenantId,
    actorId: requireDevActorId(session),
    actorRole: role as OnboardingActorRole,
    requestId: session.context.requestId,
    traceId: session.context.traceId,
  };
}

async function runtimeFor(
  request: Request,
  permission: "tenant.read" | "tenant.write",
) {
  const session = await requireDevSession(request, {
    principal: "owner",
    permission,
  });
  return {
    session,
    runtime: getOnboardingFixtureRuntime(session.context.tenantId),
  };
}

function validCirclePlan(value: unknown): value is CirclePlan {
  return (
    value === "unconfirmed" ||
    value === "professional" ||
    value === "business_plus" ||
    value === "not_circle"
  );
}

function validStepStatus(value: unknown): value is OnboardingStepStatus {
  return (
    value === "not_started" ||
    value === "in_progress" ||
    value === "complete" ||
    value === "blocked" ||
    value === "not_applicable"
  );
}

function validInvitationRole(
  value: unknown,
): value is OnboardingInvitationRole {
  return (
    value === "tenant_owner" ||
    value === "tenant_admin" ||
    value === "creator" ||
    value === "teacher"
  );
}

function onboardingErrorResponse(error: unknown) {
  const onboardingError = recognizedOnboardingError(error);
  if (onboardingError !== undefined) {
    const status =
      onboardingError.code === "onboarding.access_denied"
        ? 403
        : onboardingError.code === "onboarding.not_found"
          ? 404
          : onboardingError.code === "onboarding.conflict" ||
              onboardingError.code === "onboarding.idempotency_conflict"
            ? 409
            : onboardingError.code === "onboarding.durable_adapter_required"
              ? 503
              : 422;
    return NextResponse.json(
      {
        error: "OnboardingError",
        code: onboardingError.code,
        message: onboardingError.message,
        safeDetails: onboardingError.safeDetails,
      },
      { status },
    );
  }
  if (error instanceof OnboardingRequestError) {
    return NextResponse.json(
      {
        error: "OnboardingValidationError",
        code: "onboarding.invalid_request",
        message: error.message,
      },
      { status: 422 },
    );
  }
  const status = developmentApiErrorStatus(error);
  if (status === 403 || status === 409) {
    return NextResponse.json(serializeDevelopmentError(error), { status });
  }
  return NextResponse.json(
    {
      error: "OnboardingApiError",
      code: "onboarding.api_failure",
      message: "The onboarding request could not be processed.",
    },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    const { runtime, session } = await runtimeFor(request, "tenant.read");
    const snapshot = await runtime.getSnapshot(commandContext(session));
    return NextResponse.json(
      { mode: "explicit_fixture", durable: false, snapshot },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return onboardingErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readBoundedObject(request);
    const action = stringValue(input, "action", 48);
    const { runtime, session } = await runtimeFor(request, "tenant.write");
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const context = commandContext(session);
    const idempotencyKey =
      stringValue(input, "idempotencyKey", 256, false) ??
      crypto.randomUUID();
    const expectedVersion = numberValue(
      input,
      "expectedVersion",
      false,
    );

    if (action === "update_tenant_profile") {
      const circlePlan = stringValue(input, "circlePlan", 32);
      if (!validCirclePlan(circlePlan)) {
        invalidRequest("circlePlan is invalid.");
      }
      const snapshot = await runtime.updateTenantProfile(context, {
        displayName: stringValue(input, "displayName", 120) ?? "",
        slug: stringValue(input, "slug", 63) ?? "",
        planId: stringValue(input, "planId", 80) ?? "",
        assistantName: stringValue(input, "assistantName", 80) ?? "",
        primaryColor: stringValue(input, "primaryColor", 7) ?? "",
        accentColor: stringValue(input, "accentColor", 7) ?? "",
        circlePlan,
        idempotencyKey,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      return NextResponse.json({ mode: "explicit_fixture", durable: false, snapshot });
    }

    if (action === "set_step") {
      const stepKey = stringValue(input, "stepKey", 48);
      const status = stringValue(input, "status", 32);
      if (
        stepKey === undefined ||
        !ONBOARDING_STEP_KEYS.includes(
          stepKey as (typeof ONBOARDING_STEP_KEYS)[number],
        ) ||
        status === undefined ||
        !validStepStatus(status)
      ) {
        invalidRequest("A known stepKey and status are required.");
      }
      const evidenceNote = stringValue(input, "evidenceNote", 500, false);
      const snapshot = await runtime.setStep(context, {
        stepKey: stepKey as (typeof ONBOARDING_STEP_KEYS)[number],
        status,
        idempotencyKey,
        ...(evidenceNote === undefined ? {} : { evidenceNote }),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      return NextResponse.json({ mode: "explicit_fixture", durable: false, snapshot });
    }

    if (action === "invite_client_admin") {
      const role = stringValue(input, "role", 32);
      if (!validInvitationRole(role)) {
        invalidRequest(
          "role must be tenant_owner, tenant_admin, creator or teacher.",
        );
      }
      const snapshot = await runtime.inviteClientAdmin(context, {
        email: stringValue(input, "email", 320) ?? "",
        role,
        expiresInHours: numberValue(input, "expiresInHours") ?? 0,
        idempotencyKey,
      });
      return NextResponse.json({ mode: "explicit_fixture", durable: false, snapshot });
    }

    if (action === "revoke_invitation") {
      const snapshot = await runtime.revokeInvitation(context, {
        invitationId: stringValue(input, "invitationId", 512) ?? "",
        idempotencyKey,
      });
      return NextResponse.json({ mode: "explicit_fixture", durable: false, snapshot });
    }

    if (action === "request_launch_review") {
      const snapshot = await runtime.requestLaunchReview(context, {
        idempotencyKey,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      return NextResponse.json({ mode: "explicit_fixture", durable: false, snapshot });
    }

    if (action === "activate") {
      const snapshot = await runtime.activate(context, {
        idempotencyKey,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      return NextResponse.json({ mode: "explicit_fixture", durable: false, snapshot });
    }

    invalidRequest("Unsupported onboarding action.");
  } catch (error) {
    return onboardingErrorResponse(error);
  }
}
