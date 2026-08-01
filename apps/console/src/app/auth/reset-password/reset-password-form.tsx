"use client";

import { useState, type FormEvent } from "react";
import { createBrowserSupabaseClient } from "../../../lib/supabase/client";
import styles from "../auth.module.css";

export function ResetPasswordForm({ nextPath = "/app/entry" }: { nextPath?: string }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordIsStrong =
    password.length >= 12 &&
    /[a-z]/u.test(password) &&
    /[A-Z]/u.test(password) &&
    /\d/u.test(password) &&
    /[^A-Za-z0-9]/u.test(password);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (
      password !== confirmation ||
      password.length < 12 ||
      !/[a-z]/u.test(password) ||
      !/[A-Z]/u.test(password) ||
      !/\d/u.test(password) ||
      !/[^A-Za-z0-9]/u.test(password)
    ) {
      setError(
        password !== confirmation
          ? "The two passwords do not match."
          : "Use 12 characters with uppercase, lowercase, a number and a symbol.",
      );
      return;
    }
    setPending(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const result = await supabase.auth.updateUser({ password });
      if (result.error) throw result.error;
      window.location.assign(nextPath);
    } catch {
      setError(
        "Your password could not be changed. Keep this page open and try again.",
      );
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        New password
        <input
          className={styles.input}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
        />
        <span
          className={styles.passwordStrength}
          data-valid={passwordIsStrong}
        >
          <i />
          <i />
          <i />
          <i />
        </span>
        <small className={styles.passwordHint}>
          {passwordIsStrong
            ? "Strong — 12 characters, mixed case"
            : "12 characters, mixed case, number and symbol"}
        </small>
      </label>
      <label className={styles.field}>
        Confirm
        <input
          className={styles.input}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={pending}
        />
      </label>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <button className={styles.button} type="submit" disabled={pending}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
