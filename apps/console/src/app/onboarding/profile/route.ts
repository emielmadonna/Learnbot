import {
  authenticatedOnboardingClient,
  executeOnboardingRpc,
  onboardingRedirect,
  safeOnboardingError,
} from "../../../lib/supabase/onboarding-route";
import { operationFields } from "../../../lib/supabase/onboarding-rpc";

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedOnboardingClient(request);
    const form = await request.formData();
    await executeOnboardingRpc(supabase, "onboarding_update_tenant_profile", {
      requested_display_name: String(form.get("displayName") ?? ""),
      requested_slug: String(form.get("slug") ?? ""),
      requested_plan_id: String(form.get("planId") ?? ""),
      requested_assistant_name: String(form.get("assistantName") ?? ""),
      requested_primary_color: String(form.get("primaryColor") ?? ""),
      requested_accent_color: String(form.get("accentColor") ?? ""),
      requested_circle_plan: String(form.get("circlePlan") ?? ""),
      expected_version: Number(form.get("expectedVersion")),
      ...operationFields("onboarding-profile"),
    });
    return onboardingRedirect(request, "status", "profile_updated");
  } catch (error) {
    return onboardingRedirect(request, "error", safeOnboardingError(error));
  }
}
