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

const localDemoLinks = [
  { label: "Learner", detail: "Ask, listen, and practice", href: "/dev/chat" },
  { label: "Teacher", detail: "See cohort signals", href: "/dev/teacher" },
  { label: "Creator", detail: "Shape a learning path", href: "/dev/learning" },
];

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
            <span className={styles.brandMark} aria-hidden="true" />
            <span>
              <b>LearningBot</b>
              <small>Learning, connected</small>
            </span>
          </Link>
          <span className={styles.secureLabel}>Private workspace access</span>
        </nav>
        <div className={styles.authLayout}>
          <section className={styles.authIntro}>
            <div className={styles.introKicker}>
              <span className={styles.introDot} aria-hidden="true" />
              LearningBot workspace
            </div>
            <h1 className={styles.displayTitle}>
              Pick up where the good work left off.
            </h1>
            <p>
              A quiet place for your team to learn from the knowledge you already
              trust—through courses, conversation, and a little momentum.
            </p>
            <div className={styles.trustLine}>
              <span aria-hidden="true">✦</span>
              Your organization, sources, and role stay together after sign-in.
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
            {process.env.NODE_ENV !== "production" ? (
              <aside className={styles.demoPanel} aria-label="Local demo">
                <div>
                  <span className={styles.demoEyebrow}>Local demo</span>
                  <strong>See the product before connecting Supabase.</strong>
                  <p>
                    Fixture-only previews for local development. No account,
                    session, or production data is created.
                  </p>
                </div>
                <div className={styles.demoLinks}>
                  {localDemoLinks.map((demo) => (
                    <Link href={demo.href} key={demo.href}>
                      <span>
                        <b>{demo.label}</b>
                        <small>{demo.detail}</small>
                      </span>
                      <span aria-hidden="true">↗</span>
                    </Link>
                  ))}
                </div>
              </aside>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}
