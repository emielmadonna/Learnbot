import { IntelligenceError } from "@course-ai/intelligence-core";
import { NextResponse } from "next/server";

import {
  changeOpportunityStatus,
  IntelligenceDemoIdempotencyError,
  intelligenceSnapshot,
  recordOpportunityFeedback,
} from "../../../../lib/intelligence-demo/runtime";
import type { IntelligenceMutation } from "../../../../lib/intelligence-demo/types";
import {
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
  safeDevelopmentSessionMetadata,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";

class IntelligenceApiInputError extends Error {
  readonly code = "intelligence.invalid_input";
}

const OPPORTUNITY_STATUSES = [
  "new",
  "seen",
  "actioned",
  "dismissed",
  "converted",
  "expired",
] as const;

const FEEDBACK_KINDS = [
  "dismissed_false_positive",
  "wrong_offer",
  "helpful",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 200,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new IntelligenceApiInputError(
      `${field} must be a non-empty string no longer than ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new IntelligenceApiInputError(
      `${field} must be no longer than ${maxLength} characters.`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function status(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !(OPPORTUNITY_STATUSES as readonly string[]).includes(value)
  ) {
    throw new IntelligenceApiInputError(`${field} is not a valid lifecycle status.`);
  }
  return value as (typeof OPPORTUNITY_STATUSES)[number];
}

function mutation(value: unknown): IntelligenceMutation {
  if (!isRecord(value)) {
    throw new IntelligenceApiInputError("Mutation body must be an object.");
  }
  if (value.action === "status") {
    const reason = optionalString(value.reason, "reason", 500);
    return {
      action: "status",
      ...(typeof value.tenantId === "string"
        ? { tenantId: value.tenantId }
        : {}),
      idempotencyKey: requiredString(
        value.idempotencyKey,
        "idempotencyKey",
        128,
      ),
      opportunityId: requiredString(value.opportunityId, "opportunityId"),
      expectedStatus: status(value.expectedStatus, "expectedStatus"),
      nextStatus: status(value.nextStatus, "nextStatus"),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (value.action === "feedback") {
    if (
      typeof value.kind !== "string" ||
      !(FEEDBACK_KINDS as readonly string[]).includes(value.kind)
    ) {
      throw new IntelligenceApiInputError("kind is not a valid review feedback type.");
    }
    const note = optionalString(value.note, "note", 500);
    return {
      action: "feedback",
      ...(typeof value.tenantId === "string"
        ? { tenantId: value.tenantId }
        : {}),
      idempotencyKey: requiredString(
        value.idempotencyKey,
        "idempotencyKey",
        128,
      ),
      opportunityId: requiredString(value.opportunityId, "opportunityId"),
      kind: value.kind as (typeof FEEDBACK_KINDS)[number],
      ...(note === undefined ? {} : { note }),
    };
  }
  throw new IntelligenceApiInputError(
    "Only human status review and feedback actions are supported.",
  );
}

function errorResponse(error: unknown) {
  if (
    error instanceof IntelligenceApiInputError ||
    error instanceof IntelligenceError ||
    error instanceof IntelligenceDemoIdempotencyError
  ) {
    const code =
      error instanceof IntelligenceApiInputError
        ? error.code
        : error.code;
    const statusCode =
      code === "opportunity.not_found"
        ? 404
        : code === "opportunity.version_conflict" ||
            code === "opportunity.already_exists" ||
            code === "intelligence.idempotency_conflict"
          ? 409
          : code === "opportunity.tenant_mismatch"
            ? 403
            : 422;
    return NextResponse.json(
      {
        error: error.name,
        code,
        message: error.message,
      },
      { status: statusCode },
    );
  }
  return NextResponse.json(serializeDevelopmentError(error), {
    status: developmentApiErrorStatus(error),
  });
}

export async function GET(request: Request) {
  try {
    const session = await requireDevSession(request, {
      principal: "creator",
      permission: "job.read",
    });
    return NextResponse.json({
      snapshot: await intelligenceSnapshot(session.context.tenantId),
      session: safeDevelopmentSessionMetadata(session),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = mutation(await request.json());
    const session = await requireDevSession(request, {
      principal: "creator",
      permission: "job.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const actorId = requireDevActorId(session);
    const snapshot =
      input.action === "status"
        ? await changeOpportunityStatus({
            tenantId: session.context.tenantId,
            actorId,
            idempotencyKey: input.idempotencyKey,
            opportunityId: input.opportunityId,
            expectedStatus: input.expectedStatus,
            nextStatus: input.nextStatus,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
        : await recordOpportunityFeedback({
            tenantId: session.context.tenantId,
            actorId,
            idempotencyKey: input.idempotencyKey,
            opportunityId: input.opportunityId,
            kind: input.kind,
            ...(input.note === undefined ? {} : { note: input.note }),
          });
    return NextResponse.json({
      snapshot,
      session: safeDevelopmentSessionMetadata(session),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
