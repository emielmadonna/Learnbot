import Link from "next/link";
import { redirect } from "next/navigation";
import { CorsoMark } from "../../../components/corso/corso-mark";
import { readSupabasePublicConfig } from "../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import { safeRelativePath } from "../../../lib/supabase/auth-boundary";
import styles from "../auth.module.css";
import { SignInForm } from "./sign-in-form";

const messages: Record<string, string> = {
  callback_failed:
    "That sign-in attempt is invalid or has expired. Try again.",
  authentication_required: "Sign in to continue to your workspace.",
  signed_out: "You have been signed out securely.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const nextPath = safeRelativePath(
    typeof parameters.next === "string" ? parameters.next : null,
    "/app/entry",
  );
  const status =
    typeof parameters.status === "string" ? parameters.status : "";
  const errorCode =
    typeof parameters.error === "string" ? parameters.error : "";
  let configured = true;
  let authenticated = false;

  try {
    readSupabasePublicConfig();
    const supabase = await createServerSupabaseClient();
    const result = await supabase.auth.getUser();
    const user = result.data.user;
    // This predicate must stay identical to `requireVerifiedUser` in
    // lib/supabase/auth-boundary.ts. It used to be the weaker
    // `Boolean(user && !error)`, and that difference was a redirect loop:
    // /auth/change-password calls `requireVerifiedUser`, which rejects a
    // session whose email (or phone) was never confirmed and bounces to
    // /auth/sign-in?next=/auth/change-password; this page then saw the same
    // session as authenticated and redirected straight back. A user in that
    // state — an invited account that never confirmed — got
    // ERR_TOO_MANY_REDIRECTS instead of a sign-in form. Treating an unverified
    // session as not-signed-in here renders the form, which is the only screen
    // that can actually resolve the state.
    authenticated = Boolean(
      user &&
        !result.error &&
        !user.is_anonymous &&
        (user.email_confirmed_at || user.phone_confirmed_at),
    );
  } catch {
    configured = false;
  }

  if (authenticated) {
    redirect(nextPath);
  }

  return (
    <main className={styles.authShell} data-ground="light">
      <section className={styles.authPanel}>
        <Link className={styles.authMark} href="/" aria-label="Corso home">
          <CorsoMark size={34} />
        </Link>
        <h1 className={styles.authTitle}>Sign in to Corso</h1>
        <p className={styles.authLede}>
          Use the address your workspace was created with.
        </p>
        {!configured ? (
          <p className={styles.error} role="alert">
            Secure sign-in is not configured for this environment.
          </p>
        ) : null}
        {messages[errorCode] ? (
          <p className={styles.error} role="alert">
            {messages[errorCode]}
          </p>
        ) : null}
        {messages[status] ? (
          <p className={styles.notice} role="status">
            {messages[status]}
          </p>
        ) : null}
        <SignInForm configured={configured} nextPath={nextPath} />
        <p className={styles.authFootnote}>
          Invited by a course creator? Open the invitation link — signing in
          won’t find your workspace yet.
        </p>
      </section>
    </main>
  );
}
