import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";
import { UserAccessManager } from "./user-access-manager";
import styles from "./users.module.css";

export default async function UserAccessPage() {
  const supabase = await createServerSupabaseClient();
  try {
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/admin/users");
  }
  const context = await getCurrentTenantContext(supabase);
  if (!context.selected) redirect("/onboarding");
  if (!["tenant_owner", "tenant_admin"].includes(context.identityRole ?? "")) {
    redirect("/app?error=access_denied");
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/app">← Learning home</Link>
        <div>
          <p>Workspace administration</p>
          <h1>People and access</h1>
          <span>
            Create controlled accounts and see how the learning workspace is
            being used.
          </span>
        </div>
      </header>
      <UserAccessManager />
    </main>
  );
}
