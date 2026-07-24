"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "./users.module.css";

type Account = {
  authUserId: string;
  email: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  createdAt: string;
  passwordChangedAt: string | null;
};

type AccessPayload = {
  accounts: Account[];
  usage: {
    activeLearners: number;
    last30Days: Record<string, number>;
  };
};

function roleLabel(role: string) {
  return role.replaceAll("_", " ").replace(/\b\w/gu, (letter) =>
    letter.toUpperCase(),
  );
}

export function UserAccessManager() {
  const [data, setData] = useState<AccessPayload | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("student");
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(
    null,
  );
  const [createdEmail, setCreatedEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch("/api/admin/users", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok || payload.ok !== true) {
      throw new Error("access_load_failed");
    }
    setData(payload as unknown as AccessPayload);
  }

  useEffect(() => {
    void load().catch(() =>
      setError("People and usage could not be loaded. No sample data was shown."),
    );
  }, []);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setTemporaryPassword(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, displayName, role }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) {
        throw new Error(
          payload.code === "account_exists"
            ? "An account already exists for that email."
            : "The account could not be created.",
        );
      }
      const password =
        typeof payload.temporaryPassword === "string"
          ? payload.temporaryPassword
          : "";
      if (!password) throw new Error("The temporary password was not returned.");
      setCreatedEmail(email);
      setTemporaryPassword(password);
      setEmail("");
      setDisplayName("");
      setRole("student");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The account could not be created.",
      );
    } finally {
      setPending(false);
    }
  }

  const eventTotal = Object.values(data?.usage.last30Days ?? {}).reduce(
    (total, value) => total + Number(value || 0),
    0,
  );

  return (
    <div className={styles.grid}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>Add a person</p>
        <h2>Create a controlled sign-in</h2>
        <p className={styles.help}>
          A strong temporary password is generated once. The person must choose
          a new password before entering the workspace.
        </p>
        <form className={styles.form} onSubmit={createAccount}>
          <label>
            Full name
            <input
              required
              maxLength={160}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={pending}
            />
          </label>
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
            />
          </label>
          <label>
            Access
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={pending}
            >
              <option value="student">Learner</option>
              <option value="teacher">Teacher</option>
              <option value="creator">Creator</option>
              <option value="tenant_admin">Administrator</option>
              <option value="tenant_owner">Owner</option>
            </select>
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>
        {temporaryPassword ? (
          <div className={styles.credential} role="status">
            <b>Copy this now—it will not be shown again.</b>
            <span>{createdEmail}</span>
            <code>{temporaryPassword}</code>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(
                  `${createdEmail}\n${temporaryPassword}`,
                )
              }
            >
              Copy email and password
            </button>
          </div>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className={styles.card}>
        <p className={styles.eyebrow}>Last 30 days</p>
        <h2>Learning activity</h2>
        <div className={styles.metrics}>
          <div>
            <strong>{data?.usage.activeLearners ?? "—"}</strong>
            <span>Active learners</span>
          </div>
          <div>
            <strong>{data ? eventTotal : "—"}</strong>
            <span>Meaningful events</span>
          </div>
          <div>
            <strong>{data?.accounts.length ?? "—"}</strong>
            <span>Managed accounts</span>
          </div>
        </div>
        <p className={styles.help}>
          Counts include learning, conversation, voice, progress, and upload
          events. Raw audio, passwords, emails, and prompt text are excluded.
        </p>
      </section>

      <section className={`${styles.card} ${styles.peopleCard}`}>
        <div className={styles.cardTitle}>
          <div>
            <p className={styles.eyebrow}>Workspace people</p>
            <h2>Accounts</h2>
          </div>
          <span>{data?.accounts.length ?? 0}</span>
        </div>
        <div className={styles.people}>
          {data?.accounts.length ? (
            data.accounts.map((account) => (
              <article key={account.authUserId}>
                <div className={styles.personMark}>
                  {account.email.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <b>{account.email}</b>
                  <span>{roleLabel(account.role)}</span>
                </div>
                <small>
                  {account.mustChangePassword
                    ? "Password change required"
                    : "Active"}
                </small>
              </article>
            ))
          ) : (
            <p className={styles.help}>No managed account is available yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
