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
        const messages: Record<string, string> = {
          account_exists: "An account already exists for that email.",
          account_provisioning_failed: "The account was created but could not be connected to this workspace. Nothing was kept.",
          auth_user_unavailable: "The managed identity could not be linked to this workspace. Nothing was kept.",
          provider_not_configured: "Managed access is not configured on the server yet.",
          access_denied: "Your role cannot create managed access.",
        };
        throw new Error(messages[String(payload.code)] ?? "The account could not be created.");
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
    <div className={styles.canvas}>
      <section className={styles.metrics} aria-label="Learning activity">
        <div>
          <span>Active learners</span>
          <strong>{data?.usage.activeLearners ?? "—"}</strong>
          <small>Last 30 days</small>
        </div>
        <div>
          <span>Meaningful events</span>
          <strong>{data ? eventTotal : "—"}</strong>
          <small>Learning, voice and progress</small>
        </div>
        <div>
          <span>Managed accounts</span>
          <strong>{data?.accounts.length ?? "—"}</strong>
          <small>Inside this workspace</small>
        </div>
      </section>

      <section className={styles.peopleCard}>
        <div className={styles.cardTitle}>
          <div>
            <p className={styles.eyebrow}>Workspace people</p>
            <h2>Everyone with access</h2>
            <p className={styles.help}>
              Passwords, prompt text, email content, and raw audio are never
              included in the activity totals.
            </p>
          </div>
          <span className={styles.count}>{data?.accounts.length ?? 0}</span>
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
                <small data-pending={account.mustChangePassword}>
                  {account.mustChangePassword
                    ? "First sign-in pending"
                    : "Active"}
                </small>
              </article>
            ))
          ) : (
            <div className={styles.emptyState}>
              <span aria-hidden="true">◎</span>
              <p>
                {data
                  ? "No managed accounts yet. Add the first person when you’re ready."
                  : "Loading secure accounts…"}
              </p>
            </div>
          )}
        </div>
      </section>

      <details className={styles.addPerson}>
        <summary>
          <span>
            <b>Add a person</b>
            <small>Generate a one-time, controlled sign-in</small>
          </span>
          <span className={styles.summaryAction}>Open</span>
        </summary>
        <div className={styles.addPersonBody}>
          <div className={styles.formIntro}>
            <p className={styles.eyebrow}>Controlled access</p>
            <h2>Invite someone securely.</h2>
            <p className={styles.help}>
              We generate one strong temporary password. The person must
              replace it before entering the workspace.
            </p>
          </div>
          <form className={styles.form} onSubmit={createAccount}>
            <label>
              Full name
              <input
                required
                maxLength={160}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={pending}
                placeholder="Full name"
              />
            </label>
            <label>
              Work email
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={pending}
                placeholder="name@company.com"
              />
            </label>
            <label>
              Workspace role
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
              {pending ? "Creating secure access…" : "Create secure access"}
            </button>
          </form>
        </div>
        {temporaryPassword ? (
          <div className={styles.credential} role="status">
            <div>
              <b>Copy this now</b>
              <span>This password is shown once and cannot be recovered.</span>
            </div>
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
              Copy sign-in details
            </button>
          </div>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </details>
    </div>
  );
}
