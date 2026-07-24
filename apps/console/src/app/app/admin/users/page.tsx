import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import { getLearningWorkspace } from "../../../../lib/supabase/learning-rpc";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";
import { UserAccessManager } from "./user-access-manager";
import styles from "./users.module.css";

export default async function UserAccessPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    redirect(
      "/auth/sign-in?error=authentication_required&next=/app/admin/users",
    );
  }
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
  const workspace = await getLearningWorkspace(supabase);
  const assistantName = workspace.branding?.assistantName ?? "LearningBot";

  return (
    <main className={styles.shell}>
      <nav className={styles.floatingNav} aria-label="Administration">
        <Link className={styles.brand} href="/app">
          <span className={styles.brandMark}>
            {assistantName.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <b>{assistantName}</b>
            <small>{workspace.tenant.displayName}</small>
          </span>
        </Link>
        <div className={styles.navContext}>
          <span className={styles.liveDot} aria-hidden="true" />
          Secure administration
        </div>
        <Link className={styles.backLink} href="/app/admin">
          Admin overview
        </Link>
      </nav>
      <header className={styles.header}>
        <p>People</p>
        <h1>A calm view of your team.</h1>
        <span>
          Create controlled access, understand adoption, and keep every person
          inside the right workspace boundary.
        </span>
      </header>
      <UserAccessManager />
    </main>
  );
}
