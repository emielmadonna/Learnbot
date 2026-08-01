"use client";

import { useState, type FormEvent } from "react";
import { createBrowserSupabaseClient } from "../../../lib/supabase/client";
import styles from "../auth.module.css";

export function ChangePasswordForm({ nextPath }: { nextPath: string }) {
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
    if (password !== confirmation) {
      setError("The two passwords do not match.");
      return;
    }
    if (
      password.length < 12 ||
      !/[a-z]/u.test(password) ||
      !/[A-Z]/u.test(password) ||
      !/\d/u.test(password) ||
      !/[^A-Za-z0-9]/u.test(password)
    ) {
      setError(
        "Use at least 12 characters with uppercase, lowercase, a number, and a symbol.",
      );
      return;
    }
    setPending(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const updated = await supabase.auth.updateUser({ password });
      if (updated.error) throw updated.error;
      const completed = await supabase.rpc("auth_complete_password_change", {
        requested_idempotency_key: `password-change:${crypto.randomUUID()}`,
      });
      if (
        completed.error ||
        !completed.data ||
        typeof completed.data !== "object" ||
        completed.data.ok !== true
      ) {
        throw new Error("credential_state_failed");
      }
      await supabase.auth.refreshSession();
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
        {pending ? "Saving password…" : "Continue"}
      </button>
    </form>
  );
}
