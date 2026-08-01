import Link from "next/link";
import { CorsoMark } from "../../../components/corso/corso-mark";
import { readSupabasePublicConfig } from "../../../lib/supabase/config";
import styles from "../auth.module.css";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  let configured = true;
  try {
    readSupabasePublicConfig();
  } catch {
    configured = false;
  }

  return (
    <main className={styles.authShell}>
      <section className={styles.authPanel}>
        <Link className={styles.authMark} href="/" aria-label="Corso home">
          <CorsoMark size={34} />
        </Link>
        <h1 className={styles.authTitle}>Reset your password</h1>
        <p className={styles.authLede}>
          Enter your workspace email and we’ll send you a secure reset link.
        </p>
        {!configured ? (
          <p className={styles.error} role="alert">
            Password recovery is not configured for this environment.
          </p>
        ) : null}
        <ForgotPasswordForm configured={configured} />
        <Link className={styles.authBackLink} href="/auth/sign-in">
          Back to sign in
        </Link>
      </section>
    </main>
  );
}
