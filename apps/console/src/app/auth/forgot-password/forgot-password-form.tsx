"use client";

import { useState, type FormEvent } from "react";
import { createBrowserSupabaseClient } from "../../../lib/supabase/client";
import styles from "../auth.module.css";

export function ForgotPasswordForm({ configured }: { configured: boolean }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const next = encodeURIComponent("/auth/reset-password");
      const redirectTo = `${window.location.origin}/auth/callback?next=${next}`;
      const result = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo,
      });
      if (result.error) throw result.error;
      setSent(true);
    } catch {
      setError(
        "We couldn’t send the reset email. Check the address and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className={styles.authSuccess}>
        <span aria-hidden="true">✓</span>
        <h2>Check your email</h2>
        <p>
          If an account exists for <strong>{email}</strong>, a reset link is on
          the way. Use the expiry time shown in that email.
        </p>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => setSent(false)}
        >
          Send it again
        </button>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        Email
        <input
          className={styles.input}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={!configured || pending}
        />
      </label>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <button
        className={styles.button}
        type="submit"
        disabled={!configured || pending}
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
