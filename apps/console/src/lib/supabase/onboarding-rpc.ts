import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";

export type OnboardingStep = {
  key: string;
  status:
    | "not_started"
    | "in_progress"
    | "complete"
    | "blocked"
    | "not_applicable";
  required: boolean;
  evidenceRef: string | null;
  updatedAt: string;
};

export type OnboardingInvitation = {
  invitationId: string;
  emailHint: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

export type OnboardingSnapshot = {
  ok: true;
  dataMode: "durable";
  tenant: {
    tenantId: string;
    displayName: string;
    slug: string;
    status: string;
    planId: string;
    region: string | null;
  };
  onboarding: {
    onboardingId: string;
    status: string;
    version: number;
    updatedAt: string;
  };
  branding: {
    version: number;
    status: string;
    assistantName: string;
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
    textColor: string;
    welcomeMessage: string;
  };
  identity: {
    circlePlan: string;
    expectedMode: string;
  };
  steps: OnboardingStep[];
  invitations: OnboardingInvitation[];
  launch: {
    ready: boolean;
    blockers: string[];
  };
  audit: Array<{
    eventId: string;
    action: string;
    outcome: string;
    resourceType: string;
    resourceId: string;
    occurredAt: string;
  }>;
};

export class OnboardingRpcError extends Error {
  constructor(readonly code: string) {
    super(`Onboarding request denied: ${code}`);
    this.name = "OnboardingRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireOnboardingRpcSuccess(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new OnboardingRpcError("invalid_response");
  }
  if (value.ok !== true) {
    throw new OnboardingRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  return value;
}

export function parseOnboardingSnapshot(value: unknown): OnboardingSnapshot {
  const result = requireOnboardingRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    !isRecord(result.tenant) ||
    !isRecord(result.onboarding) ||
    !isRecord(result.branding) ||
    !isRecord(result.identity) ||
    !isRecord(result.launch) ||
    !Array.isArray(result.steps) ||
    !Array.isArray(result.invitations) ||
    !Array.isArray(result.audit)
  ) {
    throw new OnboardingRpcError("invalid_response");
  }
  return result as unknown as OnboardingSnapshot;
}

export async function getOnboardingSnapshot(
  supabase: SupabaseClient,
): Promise<OnboardingSnapshot> {
  const response = await supabase.rpc("onboarding_get_snapshot");
  if (response.error) {
    throw new AuthenticationBoundaryError(
      "onboarding.snapshot_failed",
      "The durable onboarding snapshot could not be loaded.",
    );
  }
  return parseOnboardingSnapshot(response.data);
}

export function operationFields(prefix: string) {
  const operationId = crypto.randomUUID();
  return {
    idempotency_key: `${prefix}:${operationId}`,
    request_id: `${prefix}:${operationId}`,
    trace_id: `web:${operationId}`,
  };
}
