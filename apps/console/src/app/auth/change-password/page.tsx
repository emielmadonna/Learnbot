import { redirect } from "next/navigation";
import {
  getManagedAccessState,
  requireVerifiedUser,
  safeRelativePath,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import styles from "../auth.module.css";
import { ChangePasswordForm } from "./password-form";

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const requestedNextPath = safeRelativePath(
    typeof parameters.next === "string" ? parameters.next : null,
    "/app/entry",
  );
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect(
      `/auth/sign-in?error=authentication_required&next=${encodeURIComponent("/auth/change-password")}`,
    );
  }
  const state = await getManagedAccessState(supabase);
  const platformAuthorization = await supabase.rpc(
    "platform_admin_is_authorized",
  );
  const canManagePlatform =
    !platformAuthorization.error && platformAuthorization.data === true;
  const nextPath =
    requestedNextPath === "/onboarding" &&
    (state.identityRole === "tenant_owner" ||
      state.identityRole === "tenant_admin")
      ? canManagePlatform
        ? "/app/platform"
        : "/app/admin"
      : requestedNextPath;
  if (!state.mustChangePassword) redirect(nextPath);

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <nav className={styles.floatingNav} aria-label="Secure access">
          <span className={styles.brand}>
            <span className={styles.brandMark}>L</span>
            <span>
              <b>LearningBot</b>
              <small>Enterprise learning</small>
            </span>
          </span>
          <span className={styles.secureLabel}>Protected first sign-in</span>
        </nav>
        <div className={styles.authLayout}>
          <section className={styles.authIntro}>
            <p className={styles.eyebrow}>First sign-in protection</p>
            <h1 className={styles.displayTitle}>Protect your LearningBot account.</h1>
            <p>
              Your administrator created your account with a temporary password.
              Replace it now before entering any organization workspace.
            </p>
            <div className={styles.trustLine}>
              <span aria-hidden="true">✓</span>
              After this update, the temporary password can no longer be used.
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.progress} aria-label="First sign-in progress">
              <span data-complete="true">
                <b>✓</b> Sign in
              </span>
              <i data-complete="true" />
              <span data-active="true">
                <b>2</b> Secure
              </span>
              <i />
              <span>
                <b>3</b> Enter
              </span>
            </div>
            <p className={styles.eyebrow}>Protect your account</p>
            <h2 className={styles.title}>Choose your password.</h2>
            <p className={styles.lede}>
              This required one-time step verifies that only you control the
              credentials for this administrator-created account.
            </p>
            <div className={styles.securityNote}>
              <strong>Password requirements</strong>
              <span>
                At least 12 characters, including uppercase, lowercase, a number,
                and a symbol.
              </span>
            </div>
            <ChangePasswordForm nextPath={nextPath} />
            <form action="/auth/sign-out" method="post">
              <button className={styles.textButton} type="submit">
                Sign out instead
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
