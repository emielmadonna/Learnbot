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
      <nav className={styles.floatingNav} aria-label="Administration">
        <Link className={styles.brand} href="/app">
          <span className={styles.brandMark}>E</span>
          <span>
            <b>Estie</b>
            <small>Learning workspace</small>
          </span>
        </Link>
        <div className={styles.navContext}>
          <span className={styles.liveDot} aria-hidden="true" />
          Secure administration
        </div>
        <Link className={styles.backLink} href="/app">
          Learning home
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
