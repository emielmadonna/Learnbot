import { redirect } from "next/navigation";
import { CorsoMark } from "../../../components/corso/corso-mark";
import { requireVerifiedUser } from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import styles from "../auth.module.css";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage() {
  try {
    const supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=callback_failed");
  }

  return (
    <main className={styles.authShell}>
      <section className={styles.authPanel}>
        <span className={styles.authMark}>
          <CorsoMark size={34} />
        </span>
        <h1 className={styles.authTitle}>Choose a new password</h1>
        <p className={styles.authLede}>
          You’ll stay signed in on this device only.
        </p>
        <ResetPasswordForm />
      </section>
    </main>
  );
}
