import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertSameOrigin,
  requireVerifiedUser,
} from "./auth-boundary";
import { createServerSupabaseClient } from "./server";
import {
  OnboardingRpcError,
  requireOnboardingRpcSuccess,
} from "./onboarding-rpc";

const safeCodes = new Set([
  "access_denied",
  "idempotency_conflict",
  "invalid_request",
  "invitation_invalid",
  "membership_conflict",
  "onboarding_not_found",
  "pending_invitation_exists",
  "policy_decision_required",
  "slug_conflict",
  "step_not_found",
  "tenant_selection_required",
  "verified_email_required",
  "version_conflict",
]);

export async function authenticatedOnboardingClient(request: Request) {
  assertSameOrigin(request);
  const supabase = await createServerSupabaseClient();
  await requireVerifiedUser(supabase);
  return supabase;
}

export function onboardingRedirect(
  request: Request,
  kind: "error" | "status",
  value: string,
) {
  const url = new URL("/onboarding", request.url);
  url.searchParams.set(kind, value);
  return NextResponse.redirect(url, 303);
}

export function safeOnboardingError(error: unknown) {
  if (error instanceof OnboardingRpcError && safeCodes.has(error.code)) {
    return error.code;
  }
  return "request_failed";
}

export async function executeOnboardingRpc(
  supabase: SupabaseClient,
  name: string,
  input: Record<string, unknown>,
) {
  const response = await supabase.rpc(name, input);
  if (response.error) {
    throw new OnboardingRpcError("request_failed");
  }
  return requireOnboardingRpcSuccess(response.data);
}
