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
    "Your durable tenant and owner membership were created successfully.",
  workspace_restored:
    "Your existing tenant was restored. No duplicate workspace was created.",
  tenant_selected: "Your active tenant was changed and the session was refreshed.",
  session_refreshed: "Your authenticated tenant claims are now current.",
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
    "The workspace was not created. Verify the values and try again; no fixture fallback was used.",
  selection_failed:
    "That tenant could not be selected. Its membership may no longer be active.",
  refresh_failed:
    "The authenticated session could not be refreshed. Sign in again before continuing.",
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
    "The durable onboarding request failed. No fixture data was substituted.",
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
          <p className={styles.eyebrow}>Durable boundary unavailable</p>
          <h1 className={styles.title}>We could not verify your workspace.</h1>
          <p className={styles.error} role="alert">
            The tenant bridge RPCs are unavailable or denied. Access remains
            closed; no demo data was substituted.
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
        "The durable onboarding snapshot could not be verified. Access remains closed and no fixture was substituted.";
    }
  }

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>E</span>
          Estie learning
        </Link>
        <section className={styles.wideCard}>
          <p className={styles.eyebrow}>Authenticated onboarding</p>
          <h1 className={styles.title}>
            {memberships.length === 0
              ? "Create your company workspace."
              : context.selected
                ? "Prepare the client for launch."
                : "Choose your learning workspace."}
          </h1>
          <p className={styles.lede}>
            Signed in as {user.email ?? "a verified user"}. Tenant membership
            and selection are checked against durable Supabase state.
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

          <section className={styles.acceptancePanel}>
            <div>
              <strong>Joining a client workspace?</strong>
              <span>
                Sign in with the exact invited email, then enter the opaque
                invitation ID. The server never accepts an email override.
              </span>
            </div>
            <form action="/onboarding/invitation/accept" method="post">
              <label className={styles.field}>
                Invitation ID
                <input
                  className={styles.input}
                  name="invitationId"
                  required
                  maxLength={512}
                  placeholder="onboarding-invite:…"
                />
              </label>
              <button className={styles.secondaryButton} type="submit">
                Accept invitation
              </button>
            </form>
          </section>

          {memberships.length === 0 ? (
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
                Create secure workspace
              </button>
            </form>
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
            </>
          )}

          <div className={styles.actions}>
            <form action="/auth/sign-out" method="post">
              <button className={styles.secondaryButton} type="submit">
                Sign out
              </button>
            </form>
            <Link className={styles.secondaryButton} href="/dev/onboarding">
              View labeled fixture preview
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
