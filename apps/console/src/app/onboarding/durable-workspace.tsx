import type {
  OnboardingSnapshot,
  OnboardingStep,
} from "../../lib/supabase/onboarding-rpc";
import { CircleInstallationPanel } from "./circle-installation";
import styles from "../auth/auth.module.css";

const stepLabels: Record<string, string> = {
  tenant_profile: "Company profile",
  identity_mode: "Identity mode",
  provider_funding: "Provider funding",
  source_ingestion: "Learning sources",
  assistant_voice_guide: "Assistant voice guide",
  diagram_review: "Diagram review",
  context_mapping: "Learning context",
  widget_branding: "Widget branding",
  privacy_consent: "Privacy consent",
  recording_policy: "Voice recording policy",
  retention_policy: "Retention policy",
  playground_qa: "Learning playground QA",
  install_verification: "Installation verification",
  client_handoff: "Client handoff",
};

const policySteps = new Set(["recording_policy", "retention_policy"]);

function StepCard({
  step,
  version,
  canManage,
}: {
  step: OnboardingStep;
  version: number;
  canManage: boolean;
}) {
  const policyLocked = policySteps.has(step.key);
  return (
    <details className={styles.stepCard}>
      <summary className={styles.stepHeading}>
        <div>
          <strong>{stepLabels[step.key] ?? step.key}</strong>
          <span>{step.required ? "Required" : "Optional"}</span>
        </div>
        <span className={styles.statusPill} data-status={step.status}>
          {step.status.replaceAll("_", " ")}
        </span>
      </summary>
      {policyLocked ? (
        <p className={styles.policyLock}>
          {step.key === "recording_policy" ? "O-07" : "O-13"} requires an
          approved human policy decision. This control cannot mark it complete.
        </p>
      ) : canManage ? (
        <form className={styles.stepForm} action="/onboarding/step" method="post">
          <input type="hidden" name="stepKey" value={step.key} />
          <input type="hidden" name="expectedVersion" value={version} />
          <label className={styles.field}>
            Status
            <select className={styles.input} name="status" defaultValue={step.status}>
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="complete">Complete</option>
              <option value="blocked">Blocked</option>
              <option value="not_applicable">Not applicable</option>
            </select>
          </label>
          <label className={styles.field}>
            Evidence reference
            <input
              className={styles.input}
              name="evidenceRef"
              defaultValue={step.evidenceRef ?? ""}
              maxLength={512}
              placeholder="Required when marking complete"
            />
          </label>
          <button className={styles.secondaryButton} type="submit">
            Save step
          </button>
        </form>
      ) : (
        <p className={styles.finePrint}>
          This role has read-only onboarding visibility.
        </p>
      )}
    </details>
  );
}

export function DurableWorkspace({
  snapshot,
  identityRole,
}: {
  snapshot: OnboardingSnapshot;
  identityRole: string;
}) {
  const canManage = ["tenant_owner", "tenant_admin"].includes(identityRole);
  const canInvite = canManage;

  return (
    <div className={styles.workspaceSections}>
      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Launch readiness</p>
            <h2>{snapshot.launch.ready ? "Ready for review" : "Gates remain"}</h2>
          </div>
          <span
            className={snapshot.launch.ready ? styles.readyBadge : styles.blockedBadge}
          >
            {snapshot.launch.ready
              ? "All durable gates clear"
              : `${snapshot.launch.blockers.length} blockers`}
          </span>
        </div>
        {snapshot.launch.blockers.length ? (
          <ul className={styles.blockerList}>
            {snapshot.launch.blockers.map((blocker) => (
              <li key={blocker}>{blocker.replaceAll("_", " ")}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.section} id="brand">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Company and brand</p>
            <h2>Shape the client workspace</h2>
          </div>
          <span className={styles.version}>Version {snapshot.onboarding.version}</span>
        </div>
        {canManage ? (
          <form className={styles.form} action="/onboarding/profile" method="post">
            <input
              type="hidden"
              name="expectedVersion"
              value={snapshot.onboarding.version}
            />
            <div className={styles.grid}>
              <label className={styles.field}>
                Company name
                <input
                  className={styles.input}
                  name="displayName"
                  defaultValue={snapshot.tenant.displayName}
                  required
                  maxLength={160}
                />
              </label>
              <label className={styles.field}>
                Workspace URL
                <input
                  className={styles.input}
                  name="slug"
                  defaultValue={snapshot.tenant.slug}
                  required
                  pattern="[a-z0-9][a-z0-9-]{1,62}"
                  maxLength={63}
                />
              </label>
            </div>
            <div className={styles.grid}>
              <label className={styles.field}>
                Plan reference
                <input
                  className={styles.input}
                  name="planId"
                  defaultValue={snapshot.tenant.planId}
                  required
                  maxLength={80}
                />
              </label>
              <label className={styles.field}>
                Circle plan
                <select
                  className={styles.input}
                  name="circlePlan"
                  defaultValue={snapshot.identity.circlePlan}
                >
                  <option value="unconfirmed">Unconfirmed</option>
                  <option value="professional">Professional</option>
                  <option value="business_plus">Business Plus</option>
                  <option value="not_circle">Not using Circle</option>
                </select>
              </label>
            </div>
            <div className={styles.grid}>
              <label className={styles.field}>
                Assistant name
                <input
                  className={styles.input}
                  name="assistantName"
                  defaultValue={snapshot.branding.assistantName}
                  required
                  maxLength={80}
                />
              </label>
              <div className={styles.colorGrid}>
                <label className={styles.field}>
                  Primary
                  <input
                    className={styles.input}
                    name="primaryColor"
                    type="color"
                    defaultValue={snapshot.branding.primaryColor}
                  />
                </label>
                <label className={styles.field}>
                  Accent
                  <input
                    className={styles.input}
                    name="accentColor"
                    type="color"
                    defaultValue={snapshot.branding.accentColor}
                  />
                </label>
              </div>
            </div>
            <button className={styles.button} type="submit">
              Save company and brand
            </button>
          </form>
        ) : (
          <div className={styles.context}>
            <div>
              <span>Assistant</span>
              <strong>{snapshot.branding.assistantName}</strong>
            </div>
            <div>
              <span>Plan</span>
              <strong>{snapshot.tenant.planId}</strong>
            </div>
            <div>
              <span>Identity</span>
              <strong>{snapshot.identity.expectedMode}</strong>
            </div>
          </div>
        )}
      </section>

      <CircleInstallationPanel
        config={{
          tenantId: snapshot.tenant.tenantId,
          tenantSlug: snapshot.tenant.slug,
          assistantName: snapshot.branding.assistantName,
          primaryColor: snapshot.branding.primaryColor,
          accentColor: snapshot.branding.accentColor,
          welcomeMessage: snapshot.branding.welcomeMessage,
        }}
      />

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Implementation evidence</p>
            <h2>Complete the launch gates</h2>
          </div>
          <span className={styles.version}>Concurrency-safe</span>
        </div>
        <div className={styles.stepGrid}>
          {snapshot.steps.map((step) => (
            <StepCard
              key={step.key}
              step={step}
              version={snapshot.onboarding.version}
              canManage={canManage}
            />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Client access</p>
            <h2>Invite the client team</h2>
          </div>
          <span className={styles.version}>
            {snapshot.invitations.length} invitations
          </span>
        </div>
        {canInvite ? (
          <form
            className={styles.inviteForm}
            action="/onboarding/invitation/create"
            method="post"
          >
            <label className={styles.field}>
              Verified client email
              <input
                className={styles.input}
                type="email"
                name="email"
                required
                maxLength={320}
                placeholder="client@company.com"
              />
            </label>
            <label className={styles.field}>
              Role
              <select className={styles.input} name="role" defaultValue="teacher">
                {identityRole === "tenant_owner" ? (
                  <option value="tenant_admin">Tenant admin</option>
                ) : null}
                <option value="creator">Creator</option>
                <option value="teacher">Teacher</option>
              </select>
            </label>
            <label className={styles.field}>
              Expires
              <select
                className={styles.input}
                name="expiresInHours"
                defaultValue="72"
              >
                <option value="24">24 hours</option>
                <option value="72">3 days</option>
                <option value="168">7 days</option>
              </select>
            </label>
            <button className={styles.button} type="submit">
              Create invitation
            </button>
          </form>
        ) : null}
        <p className={styles.finePrint}>
          Invitation records are durable. Email delivery remains a separate
          production connector; use the opaque invitation ID below for current
          acceptance testing.
        </p>
        <div className={styles.invitationList}>
          {snapshot.invitations.length === 0 ? (
            <p className={styles.finePrint}>No invitations have been created.</p>
          ) : (
            snapshot.invitations.map((invitation) => (
              <article className={styles.invitation} key={invitation.invitationId}>
                <div>
                  <strong>{invitation.emailHint}</strong>
                  <span>
                    {invitation.role} · {invitation.status}
                  </span>
                  <code>{invitation.invitationId}</code>
                </div>
                {canManage && invitation.status === "pending" ? (
                  <form
                    action="/onboarding/invitation/revoke"
                    method="post"
                  >
                    <input
                      type="hidden"
                      name="invitationId"
                      value={invitation.invitationId}
                    />
                    <button className={styles.secondaryButton} type="submit">
                      Revoke
                    </button>
                  </form>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>

      <details className={`${styles.section} ${styles.auditDisclosure}`}>
        <summary className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Safe audit evidence</p>
            <h2>Recent onboarding activity</h2>
          </div>
          <span className={styles.version}>View activity</span>
        </summary>
        <div className={styles.auditList}>
          {snapshot.audit.slice(0, 8).map((event) => (
            <div key={event.eventId}>
              <strong>{event.action}</strong>
              <span>
                {event.outcome} · {new Date(event.occurredAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
