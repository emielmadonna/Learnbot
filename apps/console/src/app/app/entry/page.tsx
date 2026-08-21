import { redirect } from "next/navigation";

import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

/** Where a tenant owner or admin belongs once their workspace resolves. */
const ADMIN_DESTINATION = "/app?panel=insights&view=insights";

export default async function AuthenticatedEntryPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/entry");
  }

  // Both reads are issued at once, but they are still *consumed* in the old
  // order: a platform administrator redirects below before the tenant context
  // is ever inspected, so an account with no tenant selection cannot be turned
  // into an error by the mere fact that we now ask for it earlier. Settling the
  // rejection into a value rather than letting Promise.all reject is what
  // preserves that ordering.
  const [platformAuthorization, contextResult] = await Promise.all([
    supabase.rpc("platform_admin_is_authorized"),
    getCurrentTenantContext(supabase).then(
      (value) => ({ ok: true as const, value, error: undefined }),
      (error: unknown) => ({ ok: false as const, value: undefined, error }),
    ),
  ]);

  if (!platformAuthorization.error && platformAuthorization.data === true) {
    redirect("/app/platform");
  }

  if (!contextResult.ok) {
    throw contextResult.error;
  }
  const context = contextResult.value;

  if (!context.selected || !context.tenantId) {
    redirect("/onboarding");
  }
  if (
    context.identityRole === "tenant_owner" ||
    context.identityRole === "tenant_admin"
  ) {
    // Straight to the destination. This used to point at /app/admin, which is
    // nothing but a `redirect()` to the same URL — a whole extra request, and
    // therefore an extra proxy `getUser()` round trip, to learn a constant.
    redirect(ADMIN_DESTINATION);
  }
  redirect("/app");
}
