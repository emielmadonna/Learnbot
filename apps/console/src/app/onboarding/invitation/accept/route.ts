import {
  refreshClaimsWhenRequired,
} from "../../../../lib/supabase/auth-boundary";
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
    await executeOnboardingRpc(supabase, "onboarding_accept_invitation", {
      target_invitation_id: String(form.get("invitationId") ?? ""),
      ...operationFields("onboarding-invite-accept"),
    });
    await refreshClaimsWhenRequired(supabase);
    return onboardingRedirect(request, "status", "invitation_accepted");
  } catch (error) {
    return onboardingRedirect(request, "error", safeOnboardingError(error));
  }
}
