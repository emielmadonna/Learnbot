import { redirect } from "next/navigation";

import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export default async function AuthenticatedEntryPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/entry");
  }

  const platformAuthorization = await supabase.rpc(
    "platform_admin_is_authorized",
  );
  if (!platformAuthorization.error && platformAuthorization.data === true) {
    redirect("/app/platform");
  }

  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) {
    redirect("/onboarding");
  }
  if (
    context.identityRole === "tenant_owner" ||
    context.identityRole === "tenant_admin"
  ) {
    redirect("/app/admin");
  }
  redirect("/app");
}
