import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getCurrentTenantContext,
  listTenantMemberships,
  requireVerifiedUser,
} from "../../lib/supabase/auth-boundary";
import { getOnboardingSnapshot } from "../../lib/supabase/onboarding-rpc";
import { createServerSupabaseClient } from "../../lib/supabase/server";
import styles from "../auth/auth.module.css";
import { DurableWorkspace } from "./durable-workspace";

const statusMessages: Record<string, string> = {
  workspace_created:
    "Your workspace is ready and you are signed in as its owner.",
  workspace_restored:
    "Welcome back. We found your existing workspace and opened it safely.",
  workspace_claimed:
    "Estie’s prepared workspace is now connected to your account.",
  tenant_selected: "Your learning workspace is now active.",
  session_refreshed: "Your secure session is up to date.",
  profile_updated: "Company, identity mode, and brand settings were saved.",
  step_updated: "The durable readiness step was updated.",
  invitation_created:
    "The invitation was created. Share its opaque ID through an approved channel.",
  invitation_revoked: "The pending invitation was revoked.",
  invitation_accepted:
    "Invitation accepted. Your tenant membership and session are now active.",
};

const errorMessages: Record<string, string> = {
  bootstrap_failed:
    "We could not create the workspace. Check the details and try again.",
  owner_claim_failed:
    "That one-time owner claim is invalid, expired, or already used.",
  selection_failed:
    "That tenant could not be selected. Its membership may no longer be active.",
  refresh_failed:
    "Your session could not be refreshed. Sign in again before continuing.",
  access_denied: "Your current role cannot perform that onboarding action.",
  idempotency_conflict:
    "That request conflicts with an earlier operation. Reload and try again.",
  invalid_request: "The onboarding values were invalid or incomplete.",
  invitation_invalid:
    "That invitation is invalid, expired, revoked, already used, or belongs to another verified email.",
  membership_conflict:
    "An existing tenant membership conflicts with this invitation.",
  onboarding_not_found: "The selected tenant has no durable onboarding record.",
  pending_invitation_exists:
    "A pending invitation already exists for that email.",
  policy_decision_required:
    "This policy gate requires an approved human decision and cannot be completed here.",
  request_failed:
    "That onboarding step could not be saved. Nothing was changed.",
  slug_conflict: "That workspace URL is already in use.",
  step_not_found: "That readiness step no longer exists.",
  tenant_selection_required: "Select a tenant before managing onboarding.",
  verified_email_required:
    "Invitation acceptance requires a verified email sign-in.",
  version_conflict:
    "The onboarding record changed. Reloaded values are shown; review them before retrying.",
};

function ConfigurationFailure() {
  return (
    <main className={styles.shell}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>Configuration required</p>
        <h1 className={styles.title}>Authentication is unavailable.</h1>
        <p className={styles.error} role="alert">
          This production path requires a Supabase project URL and publishable
          key. It will not fall back to a fixture identity.
        </p>
        <Link className={styles.secondaryButton} href="/">
          Return home
        </Link>
      </section>
    </main>
  );
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return <ConfigurationFailure />;
  }

  let user;
  try {
    user = await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/onboarding");
  }

  let memberships;
  let context;
  try {
    [memberships, context] = await Promise.all([
      listTenantMemberships(supabase),
      getCurrentTenantContext(supabase),
    ]);
  } catch {
    return (
      <main className={styles.shell}>
        <section className={styles.card}>
          <p className={styles.eyebrow}>Workspace unavailable</p>
          <h1 className={styles.title}>We could not verify your workspace.</h1>
          <p className={styles.error} role="alert">
            Secure workspace access is temporarily unavailable. Your data
            remains closed and unchanged.
          </p>
          <form action="/auth/sign-out" method="post">
            <button className={styles.secondaryButton} type="submit">
              Sign out safely
            </button>
          </form>
        </section>
      </main>
    );
  }

  const status =
    typeof parameters.status === "string" ? parameters.status : "";
  const errorCode =
    typeof parameters.error === "string" ? parameters.error : "";
  let snapshot = null;
  let snapshotError = "";
  if (context.selected) {
    try {
      snapshot = await getOnboardingSnapshot(supabase);
    } catch {
      snapshotError =
        "We could not load the latest workspace setup. Your data remains closed and unchanged.";
    }
  }

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <nav className={styles.floatingNav} aria-label="Workspace setup">
          <Link className={styles.brand} href="/">
            <span className={styles.brandMark} aria-hidden="true" />
            <span>
              <b>LearningBot</b>
              <small>Learning, connected</small>
            </span>
          </Link>
          <span className={styles.secureLabel}>Tenant-scoped setup</span>
        </nav>
        <section className={styles.wideCard}>
          <div className={styles.progress} aria-label="First sign-in progress">
            <span data-complete="true">
              <b>✓</b> Sign in
            </span>
            <i data-complete="true" />
            <span data-complete="true">
              <b>✓</b> Secure
            </span>
            <i data-complete="true" />
            <span data-active="true">
              <b>3</b> Set up
            </span>
          </div>
          <p className={styles.eyebrow}>Your learning workspace</p>
          <h1 className={styles.title}>
            {memberships.length === 0
              ? "Start with the place your team learns."
              : context.selected
                ? "Make your workspace feel like yours."
                : "Choose a workspace to continue."}
          </h1>
          <p className={styles.lede}>
            Signed in as {user.email ?? "a verified user"}. Connect an existing
            workspace, accept an invitation, or start a new one.
          </p>
          {statusMessages[status] ? (
            <p className={styles.notice} role="status">
              {statusMessages[status]}
            </p>
          ) : null}
          {errorMessages[errorCode] ? (
            <p className={styles.error} role="alert">
              {errorMessages[errorCode]}
            </p>
          ) : null}
          {snapshotError ? (
            <p className={styles.error} role="alert">
              {snapshotError}
            </p>
          ) : null}

          {memberships.length === 0 ? (
            <>
            <section className={styles.primaryAcceptancePanel}>
              <div>
                <p className={styles.optionLabel}>Workspace owner</p>
                <strong>Estie’s learning library is already prepared.</strong>
                <span>
                  Enter the one-time owner code from your private handoff to
                  connect the courses and learning assistant to this account.
                </span>
              </div>
              <form action="/auth/claim-tenant" method="post">
                <label className={styles.field}>
                  Workspace
                  <input
                    className={styles.input}
                    name="slug"
                    required
                    minLength={2}
                    maxLength={63}
                    defaultValue="estie-starr"
                  />
                </label>
                <label className={styles.field}>
                  One-time owner code
                  <input
                    className={styles.input}
                    name="claimToken"
                    required
                    minLength={32}
                    maxLength={256}
                    type="password"
                    autoComplete="one-time-code"
                    placeholder="Paste your private code"
                  />
                </label>
                <button className={styles.button} type="submit">
                  Open Estie’s workspace
                </button>
              </form>
            </section>
            <section className={styles.acceptancePanel}>
              <div>
                <p className={styles.optionLabel}>Invited teammate</p>
                <strong>Joining a client workspace?</strong>
                <span>
                  Sign in with the email that received the invitation, then
                  paste the private invitation code.
                </span>
              </div>
              <form action="/onboarding/invitation/accept" method="post">
                <label className={styles.field}>
                  Invitation code
                  <input
                    className={styles.input}
                    name="invitationId"
                    required
                    maxLength={512}
                    placeholder="Paste invitation code"
                  />
                </label>
                <button className={styles.secondaryButton} type="submit">
                  Join workspace
                </button>
              </form>
            </section>
            <div className={styles.divider}>
              <span>or start a new company workspace</span>
            </div>
            <form className={styles.form} action="/auth/bootstrap" method="post">
              <div className={styles.grid}>
                <label className={styles.field}>
                  Company name
                  <input
                    className={styles.input}
                    name="displayName"
                    required
                    maxLength={160}
                    placeholder="Northstar Labs"
                  />
                </label>
                <label className={styles.field}>
                  Workspace URL
                  <input
                    className={styles.input}
                    name="slug"
                    required
                    minLength={2}
                    maxLength={63}
                    pattern="[a-z0-9][a-z0-9-]{1,62}"
                    placeholder="northstar-labs"
                  />
                </label>
              </div>
              <div className={styles.grid}>
                <label className={styles.field}>
                  Assistant name
                  <input
                    className={styles.input}
                    name="assistantName"
                    defaultValue="Estie"
                    required
                    maxLength={80}
                  />
                </label>
                <label className={styles.field}>
                  Data region (optional)
                  <input
                    className={styles.input}
                    name="region"
                    maxLength={80}
                    placeholder="Approved region"
                  />
                </label>
              </div>
              <div className={styles.grid}>
                <label className={styles.field}>
                  Primary color
                  <input
                    className={styles.input}
                    name="primaryColor"
                    type="color"
                    defaultValue="#635bff"
                    required
                  />
                </label>
                <label className={styles.field}>
                  Accent color
                  <input
                    className={styles.input}
                    name="accentColor"
                    type="color"
                    defaultValue="#00a88f"
                    required
                  />
                </label>
              </div>
              <button className={styles.button} type="submit">
                Create new workspace
              </button>
            </form>
            </>
          ) : (
            <>
              <div className={styles.membershipList}>
                {memberships.map((membership) => (
                  <article className={styles.membership} key={membership.membershipId}>
                    <div>
                      <strong>{membership.tenantDisplayName}</strong>
                      <span>
                        {membership.tenantSlug} · {membership.identityRole}
                        {membership.selected ? " · selected" : ""}
                      </span>
                    </div>
                    {membership.selected ? (
                      <Link className={styles.button} href="/app">
                        Continue
                      </Link>
                    ) : (
                      <form action="/auth/select-tenant" method="post">
                        <input
                          type="hidden"
                          name="tenantId"
                          value={membership.tenantId}
                        />
                        <button className={styles.secondaryButton} type="submit">
                          Select tenant
                        </button>
                      </form>
                    )}
                  </article>
                ))}
              </div>
              {context.claimsRefreshRequired ? (
                <form action="/auth/refresh" method="post">
                  <p className={styles.notice}>
                    The durable tenant is selected, but this browser session has
                    stale display claims.
                  </p>
                  <button className={styles.button} type="submit">
                    Refresh secure session
                  </button>
                </form>
              ) : null}
              {snapshot && context.identityRole ? (
                <DurableWorkspace
                  snapshot={snapshot}
                  identityRole={context.identityRole}
                />
              ) : null}
              <section className={styles.acceptancePanel}>
                <div>
                  <p className={styles.optionLabel}>Another workspace</p>
                  <strong>Have a team invitation?</strong>
                  <span>
                    Paste its private code to add that workspace to this
                    account.
                  </span>
                </div>
                <form action="/onboarding/invitation/accept" method="post">
                  <label className={styles.field}>
                    Invitation code
                    <input
                      className={styles.input}
                      name="invitationId"
                      required
                      maxLength={512}
                      placeholder="Paste invitation code"
                    />
                  </label>
                  <button className={styles.secondaryButton} type="submit">
                    Join workspace
                  </button>
                </form>
              </section>
            </>
          )}

          <div className={styles.actions}>
            <form action="/auth/sign-out" method="post">
              <button className={styles.secondaryButton} type="submit">
                Sign out
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
