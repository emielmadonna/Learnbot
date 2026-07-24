import { OnboardingError } from "@course-ai/onboarding-core";
import { NextResponse } from "next/server";

import {
  getOnboardingFixtureRuntime,
} from "../../../../../lib/onboarding-demo/runtime";
import {
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
} from "../../../../../lib/dev-session-guard";
import { serializeDevelopmentError } from "../../../../../lib/dev-runtime";

const VERIFIED_FIXTURE_EMAIL = "creator@northstar.example";
const MAX_BODY_BYTES = 4_096;

class InvitationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationRequestError";
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

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new InvitationRequestError("Invitation request body is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvitationRequestError(
      "Invitation request body must be valid JSON.",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvitationRequestError(
      "Invitation request body must be an object.",
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximum = 512,
): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maximum
  ) {
    throw new InvitationRequestError(`${key} is required.`);
  }
  return value.trim();
}

function errorResponse(error: unknown) {
  const onboardingError = recognizedOnboardingError(error);
  if (onboardingError !== undefined) {
    return NextResponse.json(
      {
        error: "OnboardingInvitationError",
        code: onboardingError.code,
        message: onboardingError.message,
      },
      {
        status:
          onboardingError.code === "onboarding.access_denied"
            ? 403
            : onboardingError.code === "onboarding.not_found"
              ? 404
              : onboardingError.code === "onboarding.idempotency_conflict"
                ? 409
                : 422,
      },
    );
  }
  if (error instanceof InvitationRequestError) {
    return NextResponse.json(
      {
        error: "OnboardingInvitationValidationError",
        code: "onboarding.invitation_invalid_request",
        message: error.message,
      },
      { status: 422 },
    );
  }
  const status = developmentApiErrorStatus(error);
  return NextResponse.json(serializeDevelopmentError(error), {
    status: status === 403 || status === 409 ? status : 500,
  });
}

async function verifiedClientSession(request: Request) {
  const session = await requireDevSession(request, {
    principal: "creator",
    permission: "tenant.read",
  });
  if (
    session.identity.principal.email?.trim().toLowerCase() !==
    VERIFIED_FIXTURE_EMAIL
  ) {
    throw new OnboardingError(
      "onboarding.access_denied",
      "The verified fixture identity is not configured for invitation acceptance.",
    );
  }
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await verifiedClientSession(request);
    return NextResponse.json(
      {
        mode: "explicit_verified_fixture",
        durable: false,
        productionIdentityConfigured: false,
        identity: {
          displayName: session.identity.principal.displayName,
          email: VERIFIED_FIXTURE_EMAIL,
          tenantId: session.context.tenantId,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readBody(request);
    const action = requiredString(input, "action", 32);
    if (action !== "accept") {
      throw new InvitationRequestError("Unsupported invitation action.");
    }
    const session = await verifiedClientSession(request);
    const runtime = getOnboardingFixtureRuntime(session.context.tenantId);
    const snapshot = await runtime.acceptInvitation(
      {
        tenantId: session.context.tenantId,
        actorId: requireDevActorId(session),
        authenticatedEmail: VERIFIED_FIXTURE_EMAIL,
        requestId: session.context.requestId,
        traceId: session.context.traceId,
      },
      {
        invitationId: requiredString(input, "invitationId"),
        idempotencyKey:
          typeof input.idempotencyKey === "string" &&
          input.idempotencyKey.trim().length > 0
            ? input.idempotencyKey.trim()
            : crypto.randomUUID(),
      },
    );
    const invitation = snapshot.invitations.find(
      (candidate) => candidate.invitationId === input.invitationId,
    );
    if (invitation === undefined || invitation.status !== "accepted") {
      throw new OnboardingError(
        "onboarding.not_found",
        "The accepted invitation could not be projected.",
      );
    }
    return NextResponse.json({
      mode: "explicit_verified_fixture",
      durable: false,
      acceptance: {
        invitationId: invitation.invitationId,
        role: invitation.role,
        status: invitation.status,
        clientHandoffStatus:
          snapshot.steps.find((step) => step.key === "client_handoff")
            ?.status ?? "not_started",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
