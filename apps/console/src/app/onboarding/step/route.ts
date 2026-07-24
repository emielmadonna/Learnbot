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
    await executeOnboardingRpc(supabase, "onboarding_update_step", {
      requested_step_key: String(form.get("stepKey") ?? ""),
      requested_status: String(form.get("status") ?? ""),
      requested_evidence_ref: String(form.get("evidenceRef") ?? "") || null,
      expected_version: Number(form.get("expectedVersion")),
      ...operationFields("onboarding-step"),
    });
    return onboardingRedirect(request, "status", "step_updated");
  } catch (error) {
    return onboardingRedirect(request, "error", safeOnboardingError(error));
  }
}
