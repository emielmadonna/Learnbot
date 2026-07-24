import {
  authenticatedOnboardingClient,
  executeOnboardingRpc,
  onboardingRedirect,
  safeOnboardingError,
} from "../../../../lib/supabase/onboarding-route";
import { operationFields } from "../../../../lib/supabase/onboarding-rpc";

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedOnboardingClient(request);
    const form = await request.formData();
    await executeOnboardingRpc(supabase, "onboarding_create_invitation", {
      invited_email: String(form.get("email") ?? ""),
      invited_role: String(form.get("role") ?? ""),
      expires_in_hours: Number(form.get("expiresInHours")),
      ...operationFields("onboarding-invite-create"),
    });
    return onboardingRedirect(request, "status", "invitation_created");
  } catch (error) {
    return onboardingRedirect(request, "error", safeOnboardingError(error));
  }
}
