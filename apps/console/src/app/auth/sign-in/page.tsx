import Link from "next/link";
import { redirect } from "next/navigation";
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
    authenticated = Boolean(result.data.user && !result.error);
  } catch {
    configured = false;
  }

  if (authenticated) {
    redirect(nextPath);
  }

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <nav className={styles.floatingNav} aria-label="Secure access">
          <Link className={styles.brand} href="/">
            <span className={styles.brandMark}>L</span>
            <span>
              <b>LearningBot</b>
              <small>Enterprise learning</small>
            </span>
          </Link>
          <span className={styles.secureLabel}>Administrator-managed access</span>
        </nav>
        <div className={styles.authLayout}>
          <section className={styles.authIntro}>
            <p className={styles.eyebrow}>One place to learn</p>
            <h1 className={styles.displayTitle}>
              Knowledge that moves with your work.
            </h1>
            <p>
              Ask, listen, practice, and keep making progress in one private
              learning workspace grounded in your organization’s knowledge.
            </p>
            <div className={styles.trustLine}>
              <span aria-hidden="true">✓</span>
              Your workspace and learning sources appear after secure sign-in.
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.progress} aria-label="First sign-in progress">
              <span data-active="true">
                <b>1</b> Sign in
              </span>
              <i />
              <span>
                <b>2</b> Secure
              </span>
              <i />
              <span>
                <b>3</b> Enter
              </span>
            </div>
            <p className={styles.eyebrow}>Secure access</p>
            <h2 className={styles.title}>Welcome back.</h2>
            <p className={styles.lede}>
              Sign in with the work email and password provided by your
              administrator. LearningBot does not offer public account creation.
            </p>
            {!configured ? (
              <p className={styles.error} role="alert">
                Production authentication is not configured. Set the Supabase
                project URL and publishable key; fixture identities are never
                used here.
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
            <p className={styles.finePrint}>
              Need access, forgot your password, or received an expired temporary
              password? Your organization’s LearningBot administrator can help.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
