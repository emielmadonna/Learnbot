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
  const nextPath = safeRelativePath(
    typeof parameters.next === "string" ? parameters.next : null,
    "/app",
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
  if (!state.mustChangePassword) redirect(nextPath);

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <nav className={styles.floatingNav} aria-label="Secure access">
          <span className={styles.brand}>
            <span className={styles.brandMark}>E</span>
            <span>
              <b>Estie</b>
              <small>Native learning</small>
            </span>
          </span>
          <span className={styles.secureLabel}>Protected first sign-in</span>
        </nav>
        <div className={styles.authLayout}>
          <section className={styles.authIntro}>
            <p className={styles.eyebrow}>Make it yours</p>
            <h1 className={styles.displayTitle}>A secure start, in one step.</h1>
            <p>
              Your temporary password did its job. Replace it now so only you
              can return to this learning workspace.
            </p>
            <div className={styles.trustLine}>
              <span aria-hidden="true">✓</span>
              Your temporary password cannot unlock the workspace again.
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
              Use at least 12 characters with uppercase, lowercase, a number,
              and a symbol.
            </p>
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
