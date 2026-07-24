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
        <span className={styles.brand}>
          <span className={styles.brandMark}>E</span>
          Estie learning
        </span>
        <section className={styles.card}>
          <p className={styles.eyebrow}>Protect your account</p>
          <h1 className={styles.title}>Choose your own password.</h1>
          <p className={styles.lede}>
            Your administrator gave you a one-time temporary password. Replace
            it now before opening the learning workspace.
          </p>
          <ChangePasswordForm nextPath={nextPath} />
          <form action="/auth/sign-out" method="post">
            <button className={styles.textButton} type="submit">
              Sign out instead
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
