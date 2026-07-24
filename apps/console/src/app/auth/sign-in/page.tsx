import Link from "next/link";
import { redirect } from "next/navigation";
import { readSupabasePublicConfig } from "../../../lib/supabase/config";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import { safeRelativePath } from "../../../lib/supabase/auth-boundary";
import styles from "../auth.module.css";
import { SignInForm } from "./sign-in-form";

const messages: Record<string, string> = {
  callback_failed:
    "That sign-in link is invalid or has expired. Request a fresh link.",
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
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>E</span>
          Estie learning
        </Link>
        <section className={styles.card}>
          <p className={styles.eyebrow}>Secure access</p>
          <h1 className={styles.title}>Welcome to your learning workspace.</h1>
          <p className={styles.lede}>
            Use your verified work email. New owners can create a tenant after
            sign-in; invited learners enter the tenant they were assigned.
          </p>
          {!configured ? (
            <p className={styles.error} role="alert">
              Production authentication is not configured. Set the Supabase
              project URL and publishable key; fixture identities are never used
              here.
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
            This is the durable production sign-in path. The separate{" "}
            <Link href="/dev/onboarding">fixture preview</Link> is labeled and
            cannot provide production access.
          </p>
        </section>
      </div>
    </main>
  );
}
