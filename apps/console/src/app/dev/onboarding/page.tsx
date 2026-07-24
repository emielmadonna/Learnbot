"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import {
  loadOnboardingWorkspace,
  loadVerifiedFixtureIdentity,
  runOnboardingAction,
} from "./onboarding-adapter";
import type {
  OnboardingAction,
  OnboardingInvitation,
  OnboardingRole,
  OnboardingWorkspace,
  VerifiedFixtureIdentity,
} from "./onboarding-adapter";
import styles from "./page.module.css";

type Journey = "owner" | "client";

const roleLabels: Record<OnboardingRole, string> = {
  tenant_admin: "Client admin",
  creator: "Creator",
  teacher: "Teacher",
};

function readableStatus(value: string) {
  return value.replaceAll("_", " ");
}

export default function OnboardingPage() {
  const [workspace, setWorkspace] = useState<OnboardingWorkspace | null>(null);
  const [journey, setJourney] = useState<Journey>("owner");
  const [busyAction, setBusyAction] =
    useState<OnboardingAction["action"] | null>(null);
  const [notice, setNotice] = useState("Loading onboarding workspace…");
  const [error, setError] = useState("");
  const [selectedInvitationId, setSelectedInvitationId] = useState("");
  const [organization, setOrganization] = useState({ name: "", slug: "" });
  const [brand, setBrand] = useState({
    assistantName: "",
    primary: "#245c48",
    accent: "#d8b978",
    welcome: "",
  });
  const [invite, setInvite] = useState<{
    name: string;
    email: string;
    role: OnboardingRole;
  }>({ name: "", email: "", role: "tenant_admin" });
  const [clientName, setClientName] = useState("");
  const [fixtureIdentity, setFixtureIdentity] =
    useState<VerifiedFixtureIdentity | null>(null);

  function hydrate(snapshot: OnboardingWorkspace) {
    setWorkspace(snapshot);
    setOrganization({ name: snapshot.tenant.name, slug: snapshot.tenant.slug });
    setBrand({ ...snapshot.brand });
    const selected =
      snapshot.invitations.find(
        (item) => item.invitationId === selectedInvitationId,
      ) ?? snapshot.invitations[0];
    setSelectedInvitationId(selected?.invitationId ?? "");
    setClientName(selected?.name ?? "");
  }

  async function refresh() {
    setError("");
    setNotice("Refreshing the onboarding boundary…");
    try {
      const snapshot = await loadOnboardingWorkspace();
      hydrate(snapshot);
      if (snapshot.dataMode === "fixture") {
        void loadVerifiedFixtureIdentity()
          .then(setFixtureIdentity)
          .catch(() => setFixtureIdentity(null));
      }
      setNotice(
        snapshot.dataMode === "durable"
          ? "Durable onboarding workspace loaded"
          : "Safe test fixture loaded — no production account or email was created",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Onboarding could not be loaded.",
      );
    }
  }

  useEffect(() => {
    void refresh();
    // The first load is automatic; all later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedInvitation = useMemo(
    () =>
      workspace?.invitations.find(
        (item) => item.invitationId === selectedInvitationId,
      ),
    [selectedInvitationId, workspace?.invitations],
  );
  const readinessComplete =
    workspace?.readiness.filter((item) => item.complete).length ?? 0;
  const readinessTotal = workspace?.readiness.length ?? 0;
  const readyPercent = readinessTotal
    ? Math.round((readinessComplete / readinessTotal) * 100)
    : 0;
  const clientStep = !selectedInvitation
    ? 0
    : selectedInvitation.status === "pending"
      ? 1
      : selectedInvitation.status === "accepted"
        ? 2
        : 3;

  async function execute(
    command: OnboardingAction,
    successMessage: string,
  ) {
    if (!workspace) return;
    setBusyAction(command.action);
    setError("");
    try {
      const next = await runOnboardingAction(workspace, command);
      hydrate(next);
      setNotice(
        next.dataMode === "fixture"
          ? `${successMessage} · fixture preview only`
          : successMessage,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change was not saved.");
    } finally {
      setBusyAction(null);
    }
  }

  function chooseInvitation(item: OnboardingInvitation) {
    setSelectedInvitationId(item.invitationId);
    setClientName(item.name);
    setError("");
  }

  if (!workspace) {
    return (
      <main className={styles.loading}>
        <span aria-hidden="true">L</span>
        <p role="status">{error || "Preparing your onboarding workspace…"}</p>
        {error ? <button onClick={() => void refresh()}>Try again</button> : null}
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <a className={styles.brandMark} href="/">
          <span aria-hidden="true">L</span><b>Learning OS</b>
        </a>
        <p>Launch workspace</p>
        <nav aria-label="Onboarding navigation">
          <button
            className={journey === "owner" ? styles.navActive : undefined}
            onClick={() => setJourney("owner")}
          >
            Owner setup
          </button>
          <button
            className={journey === "client" ? styles.navActive : undefined}
            onClick={() => setJourney("client")}
          >
            Client preview
          </button>
          <a href="/dev/admin">Platform admin</a>
          <a href="/dev/branding">Branding studio</a>
          <a href="/dev/learning">Learning readiness</a>
        </nav>
        <div className={styles.identity}>
          <span>{workspace.owner.displayName.slice(0, 2).toUpperCase()}</span>
          <div><b>{workspace.owner.displayName}</b><small>Workspace owner</small></div>
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>
              {journey === "owner" ? "Owner onboarding" : "Invitation experience"}
            </p>
            <h1>
              {journey === "owner"
                ? "Make the workspace feel like yours."
                : "Welcome a client with clarity."}
            </h1>
            <p>
              {journey === "owner"
                ? "Set the organization, shape Estie, invite the first team and review every launch dependency."
                : "Preview exactly what an invited client sees before they enter the workspace."}
            </p>
          </div>
          <div className={styles.modeSwitch} aria-label="Choose onboarding journey">
            <button
              aria-pressed={journey === "owner"}
              onClick={() => setJourney("owner")}
            >
              My setup
            </button>
            <button
              aria-pressed={journey === "client"}
              onClick={() => setJourney("client")}
            >
              Client view
            </button>
          </div>
        </header>

        <section
          className={
            workspace.dataMode === "fixture"
              ? styles.fixtureBoundary
              : styles.durableBoundary
          }
          aria-label="Data boundary"
        >
          <div><span aria-hidden="true" /><strong>{workspace.sourceLabel}</strong></div>
          <p>{workspace.warning ?? "Changes are stored in the tenant-scoped service."}</p>
          <button onClick={() => void refresh()}>Refresh</button>
        </section>

        {error ? (
          <div className={styles.error} role="alert">
            <div><strong>That step needs attention</strong><p>{error}</p></div>
            <button onClick={() => setError("")} aria-label="Dismiss error">×</button>
          </div>
        ) : null}
        <p className={styles.srOnly} role="status" aria-live="polite">{notice}</p>

        {journey === "owner" ? (
          <>
            <section className={styles.progressCard} aria-labelledby="setup-progress">
              <div>
                <p className={styles.eyebrow}>Launch progress</p>
                <h2 id="setup-progress">
                  {readinessComplete} of {readinessTotal} foundations ready
                </h2>
                <p>{notice}</p>
              </div>
              <div className={styles.progressVisual}>
                <strong>{readyPercent}%</strong>
                <div aria-hidden="true"><span style={{ width: `${readyPercent}%` }} /></div>
              </div>
            </section>
            <div className={styles.ownerGrid}>
              <div className={styles.formStack}>
                <form
                  className={styles.card}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void execute(
                      { action: "save_organization", input: organization },
                      "Organization setup saved",
                    );
                  }}
                >
                  <CardHeading number="01" eyebrow="Workspace identity" title="Name the organization" state="Ready" />
                  <div className={styles.fieldRow}>
                    <label>
                      <span>Organization name</span>
                      <input
                        value={organization.name}
                        onChange={(event) =>
                          setOrganization((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        minLength={2}
                        autoComplete="organization"
                        required
                      />
                    </label>
                    <label>
                      <span>Workspace address</span>
                      <div className={styles.slugInput}>
                        <small>learn.</small>
                        <input
                          value={organization.slug}
                          onChange={(event) =>
                            setOrganization((current) => ({
                              ...current,
                              slug: event.target.value,
                            }))
                          }
                          pattern="[a-z0-9-]+"
                          aria-describedby="slug-help"
                          required
                        />
                      </div>
                      <small id="slug-help">Lowercase letters, numbers and hyphens.</small>
                    </label>
                  </div>
                  <div className={styles.formFooter}>
                    <span>{workspace.tenant.region}</span>
                    <button disabled={busyAction !== null}>
                      {busyAction === "save_organization" ? "Saving…" : "Save organization"}
                    </button>
                  </div>
                </form>

                <form
                  className={styles.card}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void execute(
                      { action: "save_brand", input: brand },
                      "Assistant identity saved",
                    );
                  }}
                >
                  <CardHeading number="02" eyebrow="Assistant identity" title="Make the welcome unmistakably yours" state="Ready" />
                  <div className={styles.brandEditor}>
                    <div className={styles.brandFields}>
                      <label>
                        <span>Assistant name</span>
                        <input
                          value={brand.assistantName}
                          onChange={(event) =>
                            setBrand((current) => ({
                              ...current,
                              assistantName: event.target.value,
                            }))
                          }
                          required
                        />
                      </label>
                      <label>
                        <span>Welcome message</span>
                        <textarea
                          value={brand.welcome}
                          onChange={(event) =>
                            setBrand((current) => ({
                              ...current,
                              welcome: event.target.value,
                            }))
                          }
                          rows={3}
                          required
                        />
                      </label>
                      <div className={styles.colorFields}>
                        <ColorField label="Primary" value={brand.primary} onChange={(primary) => setBrand((current) => ({ ...current, primary }))} />
                        <ColorField label="Accent" value={brand.accent} onChange={(accent) => setBrand((current) => ({ ...current, accent }))} />
                      </div>
                    </div>
                    <div
                      className={styles.assistantPreview}
                      style={
                        {
                          "--preview-primary": brand.primary,
                          "--preview-accent": brand.accent,
                        } as React.CSSProperties
                      }
                      aria-label="Assistant welcome preview"
                    >
                      <div className={styles.previewTop}>
                        <span>{brand.assistantName.slice(0, 1).toUpperCase()}</span>
                        <div><b>{brand.assistantName || "Assistant"}</b><small>Learning companion</small></div>
                        <i>Online</i>
                      </div>
                      <p>{brand.welcome || "Your welcome message appears here."}</p>
                      <button type="button">Start learning</button>
                    </div>
                  </div>
                  <div className={styles.formFooter}>
                    <a href="/dev/branding">Open full branding studio</a>
                    <button disabled={busyAction !== null}>
                      {busyAction === "save_brand" ? "Saving…" : "Save assistant identity"}
                    </button>
                  </div>
                </form>

                <section className={styles.card}>
                  <CardHeading
                    number="03"
                    eyebrow="Team access"
                    title="Invite the first client team"
                    state={
                      workspace.invitations.some((item) => item.status !== "pending")
                        ? "Accepted"
                        : "Pending"
                    }
                  />
                  <form
                    className={styles.inviteForm}
                    onSubmit={(event: FormEvent) => {
                      event.preventDefault();
                      void execute(
                        { action: "send_invitation", input: invite },
                        "Invitation prepared",
                      ).then(() =>
                        setInvite({ name: "", email: "", role: "tenant_admin" }),
                      );
                    }}
                  >
                    <label>
                      <span>Name</span>
                      <input
                        value={invite.name}
                        onChange={(event) =>
                          setInvite((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="Client teammate"
                        autoComplete="name"
                        required
                      />
                    </label>
                    <label>
                      <span>Work email</span>
                      <input
                        type="email"
                        value={invite.email}
                        onChange={(event) =>
                          setInvite((current) => ({ ...current, email: event.target.value }))
                        }
                        placeholder="name@company.com"
                        autoComplete="email"
                        required
                      />
                    </label>
                    <label>
                      <span>Role</span>
                      <select
                        value={invite.role}
                        onChange={(event) =>
                          setInvite((current) => ({
                            ...current,
                            role: event.target.value as OnboardingRole,
                          }))
                        }
                      >
                        <option value="tenant_admin">Client admin</option>
                        <option value="creator">Creator</option>
                        <option value="teacher">Teacher</option>
                      </select>
                    </label>
                    <button disabled={busyAction !== null}>
                      {busyAction === "send_invitation" ? "Preparing…" : "Prepare invite"}
                    </button>
                    <p>
                      Fixture mode records a safe preview only. It never sends an email.
                    </p>
                  </form>
                  {fixtureIdentity ? (
                    <div className={styles.fixtureHint}>
                      <div>
                        <strong>End-to-end test identity</strong>
                        <p>
                          Invite {fixtureIdentity.email} as a Creator, then open
                          Client preview to exercise verified acceptance.
                        </p>
                      </div>
                      <button
                        onClick={() =>
                          setInvite({
                            name: fixtureIdentity.displayName,
                            email: fixtureIdentity.email,
                            role: "creator",
                          })
                        }
                      >
                        Use test client
                      </button>
                    </div>
                  ) : null}

                  {workspace.invitations.length ? (
                    <div className={styles.invitationList} aria-label="Team invitations">
                      {workspace.invitations.map((item) => (
                        <article key={item.invitationId}>
                          <span>{item.name.slice(0, 2).toUpperCase()}</span>
                          <div><b>{item.name}</b><small>{item.email} · {roleLabels[item.role]}</small></div>
                          <i data-status={item.status}>{readableStatus(item.status)}</i>
                          <button
                            onClick={() => {
                              chooseInvitation(item);
                              setJourney("client");
                            }}
                          >
                            Preview
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.empty}>
                      <strong>No invitations yet</strong>
                      <p>Add an admin, creator or teacher to preview their journey.</p>
                    </div>
                  )}
                </section>
              </div>

              <aside className={styles.readinessCard}>
                <p className={styles.eyebrow}>Before anyone enters</p>
                <h2>Launch readiness</h2>
                <p>Only observed system state appears complete. Policy decisions remain open.</p>
                <div className={styles.readinessList}>
                  {workspace.readiness.map((item) => (
                    <article key={item.key} data-complete={item.complete}>
                      <span aria-hidden="true">{item.complete ? "✓" : "·"}</span>
                      <div><b>{item.label}</b><small>{item.detail}</small></div>
                    </article>
                  ))}
                </div>
                <div className={styles.readinessActions}>
                  <a href="/dev/learning">Review learning quality</a>
                  <a href="/dev/privacy">Review privacy operations</a>
                </div>
                <div className={styles.blockedLaunch}>
                  <span aria-hidden="true">i</span>
                  <p><b>Production launch stays gated.</b> Resolve every policy and durable-service requirement first.</p>
                </div>
              </aside>
            </div>
          </>
        ) : (
          <ClientJourney
            workspace={workspace}
            invitation={selectedInvitation}
            invitationId={selectedInvitationId}
            onSelect={(id) => {
              const item = workspace.invitations.find(
                (candidate) => candidate.invitationId === id,
              );
              if (item) chooseInvitation(item);
            }}
            clientName={clientName}
            setClientName={setClientName}
            clientStep={clientStep}
            busyAction={busyAction}
            onAccept={() => {
              if (!selectedInvitation) return;
              void execute(
                {
                  action: "accept_invitation",
                  input: {
                    invitationId: selectedInvitation.invitationId,
                    acceptedByName: clientName,
                  },
                },
                "Invitation acceptance previewed",
              );
            }}
            onComplete={() => {
              if (!selectedInvitation) return;
              void execute(
                {
                  action: "complete_client_profile",
                  input: {
                    invitationId: selectedInvitation.invitationId,
                    displayName: clientName,
                  },
                },
                "Client profile preview completed",
              );
            }}
            onBack={() => setJourney("owner")}
            notice={notice}
            fixtureIdentity={fixtureIdentity}
          />
        )}
      </section>
    </main>
  );
}

function CardHeading(props: {
  number: string;
  eyebrow: string;
  title: string;
  state: string;
}) {
  return (
    <div className={styles.cardHeading}>
      <span>{props.number}</span>
      <div><p className={styles.eyebrow}>{props.eyebrow}</p><h2>{props.title}</h2></div>
      <i data-state={props.state.toLowerCase()}>{props.state}</i>
    </div>
  );
}

function ColorField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="color"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <small>{props.value}</small>
    </label>
  );
}

function ClientJourney(props: {
  workspace: OnboardingWorkspace;
  invitation: OnboardingInvitation | undefined;
  invitationId: string;
  onSelect: (id: string) => void;
  clientName: string;
  setClientName: (name: string) => void;
  clientStep: number;
  busyAction: OnboardingAction["action"] | null;
  onAccept: () => void;
  onComplete: () => void;
  onBack: () => void;
  notice: string;
  fixtureIdentity: VerifiedFixtureIdentity | null;
}) {
  const {
    workspace,
    invitation,
    invitationId,
    onSelect,
    clientName,
    setClientName,
    clientStep,
    busyAction,
    onAccept,
    onComplete,
    onBack,
    notice,
    fixtureIdentity,
  } = props;

  if (!invitation) {
    return (
      <section className={styles.clientEmpty}>
        <span aria-hidden="true">＋</span>
        <h2>No client invitation to preview</h2>
        <p>Prepare an invitation in owner setup, then return to test acceptance.</p>
        <button onClick={onBack}>Return to owner setup</button>
      </section>
    );
  }

  return (
    <section className={styles.clientStage}>
      <header className={styles.clientStageHeader}>
        <div><p className={styles.eyebrow}>Previewing as invited client</p><h2>{invitation.email}</h2></div>
        {workspace.invitations.length > 1 ? (
          <label>
            <span>Invitation</span>
            <select value={invitationId} onChange={(event) => onSelect(event.target.value)}>
              {workspace.invitations.map((item) => (
                <option value={item.invitationId} key={item.invitationId}>
                  {item.name} · {roleLabels[item.role]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      <ol className={styles.clientProgress} aria-label="Client onboarding progress">
        {["Invitation", "Accept", "Profile", "Workspace"].map((label, index) => (
          <li key={label} data-current={clientStep === index} data-complete={clientStep > index}>
            <span>{clientStep > index ? "✓" : index + 1}</span><b>{label}</b>
          </li>
        ))}
      </ol>

      <div className={styles.clientCanvas}>
        <div
          className={styles.clientWelcome}
          style={
            {
              "--client-primary": workspace.brand.primary,
              "--client-accent": workspace.brand.accent,
            } as React.CSSProperties
          }
        >
          <a href="/" className={styles.clientLogo}>
            <span>{workspace.tenant.name.slice(0, 1)}</span>{workspace.tenant.name}
          </a>
          <div className={styles.invitationCopy}>
            <p className={styles.eyebrow}>You’re invited</p>
            <h2>Welcome to {workspace.tenant.name}.</h2>
            <p>
              {workspace.owner.displayName} invited you as a{" "}
              <strong>{roleLabels[invitation.role].toLowerCase()}</strong>. You
              receive only the access granted to that role.
            </p>
            <dl>
              <div><dt>Workspace</dt><dd>learn.{workspace.tenant.slug}</dd></div>
              <div><dt>Role</dt><dd>{roleLabels[invitation.role]}</dd></div>
              <div><dt>Status</dt><dd>{readableStatus(invitation.status)}</dd></div>
            </dl>
          </div>
          <div className={styles.clientAction}>
            <label>
              <span>Name your team will see</span>
              <input
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                autoComplete="name"
                required
              />
            </label>
            {invitation.status === "pending" ? (
              <button disabled={busyAction !== null || !clientName.trim()} onClick={onAccept}>
                {busyAction === "accept_invitation" ? "Accepting…" : "Preview acceptance"}
              </button>
            ) : invitation.status === "accepted" ? (
              <button disabled={busyAction !== null || !clientName.trim()} onClick={onComplete}>
                {busyAction === "complete_client_profile" ? "Saving…" : "Complete profile"}
              </button>
            ) : (
              <a href="/dev/admin">Enter workspace</a>
            )}
            <small>
              {fixtureIdentity
                ? `Fixture acceptance is bound to ${fixtureIdentity.email}. Production still requires the configured IdP.`
                : "Production acceptance requires a token-bound verified identity."}
            </small>
          </div>
        </div>
        <aside className={styles.clientSummary}>
          <p className={styles.eyebrow}>Preview controls</p>
          <h3>Client journey state</h3>
          <dl>
            <div><dt>Invitation</dt><dd>{readableStatus(invitation.status)}</dd></div>
            <div><dt>Membership</dt><dd>{invitation.status === "pending" ? "Not created" : "Preview only"}</dd></div>
            <div><dt>Storage</dt><dd>{workspace.dataMode === "fixture" ? "Fixture memory" : "Tenant service"}</dd></div>
          </dl>
          <p>{notice}</p>
          <button onClick={onBack}>Back to owner setup</button>
        </aside>
      </div>
    </section>
  );
}
