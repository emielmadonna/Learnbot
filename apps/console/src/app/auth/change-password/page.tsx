import { redirect } from "next/navigation";
import { CorsoMark } from "../../../components/corso/corso-mark";
import {
  getManagedAccessState,
  requireVerifiedUser,
  safeRelativePath,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import styles from "../auth.module.css";
import { ResetPasswordForm } from "../reset-password/reset-password-form";
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
  const manualChange = parameters.mode === "manual";
  const invitationChange = parameters.mode === "invitation";
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
  if (!state.mustChangePassword && !manualChange && !invitationChange) {
    redirect(nextPath);
  }

  return (
    <main className={styles.authShell} data-ground="light">
      <section className={styles.authPanel}>
        <span className={styles.authMark}>
          <CorsoMark size={34} />
        </span>
        <h1 className={styles.authTitle}>Choose a new password</h1>
        <p className={styles.authLede}>
          You’ll stay signed in on this device only.
        </p>
        {state.mustChangePassword || invitationChange ? (
          <ChangePasswordForm nextPath={nextPath} />
        ) : (
          <ResetPasswordForm nextPath={nextPath} />
        )}
        <form action="/auth/sign-out" method="post">
          <button className={styles.textButton} type="submit">
            Sign out instead
          </button>
        </form>
      </section>
    </main>
  );
}
