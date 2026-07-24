"use client";

import { useState, type FormEvent } from "react";
import { createBrowserSupabaseClient } from "../../../lib/supabase/client";
import styles from "../auth.module.css";

export function SignInForm({
  configured,
  nextPath,
}: {
  configured: boolean;
  nextPath: string;
}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);

    try {
      const supabase = createBrowserSupabaseClient();
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", nextPath);
      const result = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: callback.toString(),
          shouldCreateUser: true,
        },
      });
      if (result.error) {
        throw result.error;
      }
      setMessage(
        "Check your email for a secure sign-in link. You can close this tab after it arrives.",
      );
    } catch {
      setError(
        "We could not send a sign-in link. Check the address and try again shortly.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        Work email
        <input
          className={styles.input}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          disabled={!configured || pending}
        />
      </label>
      <button
        className={styles.button}
        type="submit"
        disabled={!configured || pending}
      >
        {pending ? "Sending secure link…" : "Continue with email"}
      </button>
      {message ? (
        <p className={styles.notice} role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
