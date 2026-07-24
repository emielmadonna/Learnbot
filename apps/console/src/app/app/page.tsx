import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getCurrentTenantContext,
  listTenantMemberships,
  requireVerifiedUser,
} from "../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../lib/supabase/server";
import styles from "../auth/auth.module.css";

export default async function AuthenticatedAppPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return (
      <main className={styles.shell}>
        <section className={styles.card}>
          <h1 className={styles.title}>Production access is not configured.</h1>
          <p className={styles.error}>
            Supabase environment values are missing or invalid. Access is closed.
          </p>
        </section>
      </main>
    );
  }

  let user;
  try {
    user = await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app");
  }

  let context;
  let memberships;
  try {
    [context, memberships] = await Promise.all([
      getCurrentTenantContext(supabase),
      listTenantMemberships(supabase),
    ]);
  } catch {
    redirect("/onboarding?error=selection_failed");
  }
  if (!context.selected || !context.tenantId) {
    redirect("/onboarding");
  }
  const membership = memberships.find(
    (candidate) => candidate.tenantId === context.tenantId,
  );
  if (!membership) {
    redirect("/onboarding?error=selection_failed");
  }

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>E</span>
          Estie learning
        </Link>
        <section className={styles.wideCard}>
          <p className={styles.eyebrow}>Durable authenticated session</p>
          <h1 className={styles.title}>{membership.tenantDisplayName}</h1>
          <p className={styles.lede}>
            Signed in as {user.email ?? "a verified user"}. The database-selected
            membership below—not editable profile metadata or stale JWT
            claims—anchors authorization.
          </p>
          <div className={styles.context}>
            <div>
              <span>Tenant</span>
              <strong>{membership.tenantSlug}</strong>
            </div>
            <div>
              <span>Identity role</span>
              <strong>{context.identityRole}</strong>
            </div>
            <div>
              <span>Selection version</span>
              <strong>{context.selectionVersion}</strong>
            </div>
          </div>
          {context.claimsRefreshRequired ? (
            <p className={styles.error} role="alert">
              The browser token is stale. Return to onboarding and refresh the
              authenticated session before opening production tools.
            </p>
          ) : (
            <p className={styles.notice} role="status">
              Tenant context and authenticated claims are synchronized.
            </p>
          )}
          <div className={styles.actions}>
            <Link className={styles.button} href="/onboarding">
              Manage tenant selection
            </Link>
            <form action="/auth/sign-out" method="post">
              <button className={styles.secondaryButton} type="submit">
                Sign out
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
