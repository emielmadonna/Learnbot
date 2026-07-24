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
  const [password, setPassword] = useState("");
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
      const result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error) {
        throw result.error;
      }
      setMessage("Signed in. Opening your learning workspace…");
      window.location.assign(nextPath);
    } catch {
      setError(
        "That email or password was not accepted. Ask your administrator for an account or a fresh temporary password.",
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
      <label className={styles.field}>
        Password
        <input
          className={styles.input}
          type="password"
          name="password"
          autoComplete="current-password"
          minLength={10}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Your password"
          disabled={!configured || pending}
        />
      </label>
      <button
        className={styles.button}
        type="submit"
        disabled={!configured || pending}
      >
        {pending ? "Signing in…" : "Sign in"}
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
