"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
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

type PendingInvitation = {
  email: string;
  displayName: string;
  role: string;
  status: "pending";
  sentAt: string | null;
  expiresAt: string;
  createdAt: string;
};

type AccessPayload = {
  accounts: Account[];
  pendingInvitations: PendingInvitation[];
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
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("student");
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const response = await fetch("/api/admin/users", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) {
        throw new Error("access_load_failed");
      }
      const parsed = payload as unknown as AccessPayload;
      setData({
        ...parsed,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        pendingInvitations: Array.isArray(parsed.pendingInvitations)
          ? parsed.pendingInvitations
          : [],
      });
      setLoadError(null);
      return true;
    } catch {
      setLoadError(
        "People and usage could not be loaded. No sample data was shown.",
      );
      return false;
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setActionError(null);
    setInvitedEmail(null);
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
        const providerMessage =
          typeof payload.providerMessage === "string"
            ? payload.providerMessage
            : null;
        throw new Error(
          payload.code === "account_exists"
            ? "An account already exists for that email."
            : payload.code === "owner_identity_conflict"
              ? "The workspace owner must use a different identity from the platform administrator."
              : providerMessage ??
                "The invitation could not be sent. The provider did not confirm delivery.",
        );
      }
      const invitation =
        payload.invitation &&
        typeof payload.invitation === "object" &&
        !Array.isArray(payload.invitation)
          ? (payload.invitation as Record<string, unknown>)
          : null;
      if (invitation?.status !== "sent") {
        throw new Error(
          "The invitation provider did not confirm that the email was sent.",
        );
      }
      setInvitedEmail(email);
      setEmail("");
      setDisplayName("");
      setRole("student");
      await load();
    } catch (caught) {
      setActionError(
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
  const pendingMetric = loadingAccounts ? "…" : "Not known";
  const activeCount = data?.accounts.length ?? 0;
  const invitationCount = data?.pendingInvitations.length ?? 0;
  const peopleCount = activeCount + invitationCount;

  return (
    <div className={styles.canvas}>
      <section className={styles.metrics} aria-label="Learning activity">
        <div>
          <span>Active learners</span>
          <strong>{data?.usage.activeLearners ?? pendingMetric}</strong>
          <small>Last 30 days</small>
        </div>
        <div>
          <span>Meaningful events</span>
          <strong>{data ? eventTotal : pendingMetric}</strong>
          <small>Learning, voice and progress</small>
        </div>
        <div>
          <span>People with access</span>
          <strong>{data ? activeCount : pendingMetric}</strong>
          <small>
            {data
              ? `${invitationCount} invitation${invitationCount === 1 ? "" : "s"} pending`
              : "Inside this workspace"}
          </small>
        </div>
      </section>

      <section className={styles.peopleCard}>
        <div className={styles.cardTitle}>
          <div>
            <p className={styles.eyebrow}>Workspace people</p>
            <h2>Everyone active or invited</h2>
            <p className={styles.help}>
              Passwords, prompt text, email content, and raw audio are never
              included in the activity totals.
            </p>
          </div>
          <span className={styles.count}>
            {data ? peopleCount : loadingAccounts ? "…" : "—"}
          </span>
        </div>
        {loadError !== null && data !== null ? (
          <p className={styles.reloadWarning} role="status">
            {loadError} The last verified list remains visible.
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : null}
        <div className={styles.people}>
          {loadError !== null && data === null ? (
            <div className={styles.errorState} role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <b>People could not be loaded</b>
                <p>{loadError}</p>
              </div>
              <button type="button" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : data && peopleCount > 0 ? (
            <>
              {data.accounts.map((account) => (
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
                      ? "Password setup required"
                      : "Active"}
                  </small>
                </article>
              ))}
              {data.pendingInvitations.map((invitation) => (
                <article key={`pending:${invitation.email}`}>
                  <div className={styles.pendingMark}>
                    {(invitation.displayName || invitation.email)
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  <div>
                    <b>{invitation.email}</b>
                    <span>
                      {invitation.displayName} · {roleLabel(invitation.role)}
                    </span>
                  </div>
                  <small data-pending="true">Invitation pending</small>
                </article>
              ))}
            </>
          ) : (
            <div className={styles.emptyState}>
              <span aria-hidden="true">◎</span>
              <p>
                {data
                  ? "No active people or pending invitations yet. Add the first person when you’re ready."
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
            <small>Send a secure invitation email</small>
          </span>
          <span className={styles.summaryAction}>Open</span>
        </summary>
        <div className={styles.addPersonBody}>
          <div className={styles.formIntro}>
            <p className={styles.eyebrow}>Controlled access</p>
            <h2>Invite someone securely.</h2>
            <p className={styles.help}>
              Supabase sends a time-limited invitation. The person chooses
              their own password before entering the workspace.
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
              {pending ? "Sending invitation…" : "Send invitation"}
            </button>
          </form>
        </div>
        {invitedEmail ? (
          <div className={styles.credential} role="status">
            <div>
              <b>Invitation sent</b>
              <span>
                Supabase accepted the delivery request. The invitation remains
                pending until the person chooses a password.
              </span>
            </div>
            <span>{invitedEmail}</span>
          </div>
        ) : null}
        {actionError ? (
          <p className={styles.error} role="alert">
            {actionError}
          </p>
        ) : null}
      </details>
    </div>
  );
}
