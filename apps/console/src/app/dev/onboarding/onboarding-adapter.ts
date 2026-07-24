export type OnboardingRole = "tenant_admin" | "creator" | "teacher";
export type InvitationStatus = "pending" | "accepted" | "profile_complete";

export type OnboardingInvitation = {
  readonly invitationId: string;
  readonly name: string;
  readonly email: string;
  readonly role: OnboardingRole;
  readonly status: InvitationStatus;
  readonly expiresAt: string;
  readonly acceptedAt?: string;
};

export type OnboardingWorkspace = {
  readonly dataMode: "durable" | "fixture";
  readonly sourceLabel: string;
  readonly warning?: string;
  readonly tenant: {
    readonly tenantId: string;
    readonly name: string;
    readonly slug: string;
    readonly planId: string;
    readonly region: string;
    readonly status: "draft" | "ready";
  };
  readonly owner: {
    readonly displayName: string;
    readonly email: string;
    readonly role: "owner";
  };
  readonly brand: {
    readonly assistantName: string;
    readonly primary: string;
    readonly accent: string;
    readonly welcome: string;
  };
  readonly invitations: readonly OnboardingInvitation[];
  readonly readiness: readonly {
    readonly key: string;
    readonly label: string;
    readonly complete: boolean;
    readonly detail: string;
  }[];
  readonly updatedAt: string;
};

export type OnboardingAction =
  | {
      readonly action: "save_organization";
      readonly input: { readonly name: string; readonly slug: string };
    }
  | {
      readonly action: "save_brand";
      readonly input: {
        readonly assistantName: string;
        readonly primary: string;
        readonly accent: string;
        readonly welcome: string;
      };
    }
  | {
      readonly action: "send_invitation";
      readonly input: {
        readonly name: string;
        readonly email: string;
        readonly role: OnboardingRole;
      };
    }
  | {
      readonly action: "accept_invitation";
      readonly input: {
        readonly invitationId: string;
        readonly acceptedByName: string;
      };
    }
  | {
      readonly action: "complete_client_profile";
      readonly input: {
        readonly invitationId: string;
        readonly displayName: string;
      };
    };

type CoreSnapshot = {
  readonly tenantId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly planId: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly branding: {
    readonly assistantName: string;
    readonly primaryColor: string;
    readonly accentColor: string;
  };
  readonly steps: readonly {
    readonly key: string;
    readonly title: string;
    readonly description: string;
    readonly status: string;
    readonly required: boolean;
    readonly updatedAt: string;
    readonly evidenceNote?: string;
  }[];
  readonly invitations: readonly {
    readonly invitationId: string;
    readonly emailHint: string;
    readonly role: string;
    readonly status: string;
    readonly expiresAt: string;
  }[];
  readonly launch: { readonly ready: boolean; readonly blockers: readonly string[] };
};

type CoreEnvelope = {
  readonly mode?: "explicit_fixture" | "durable";
  readonly durable?: boolean;
  readonly snapshot?: CoreSnapshot;
  readonly message?: string;
};

export type VerifiedFixtureIdentity = {
  readonly displayName: string;
  readonly email: string;
  readonly tenantId: string;
};

const fixtureTimestamp = "2026-07-24T09:00:00.000Z";

export function createFixtureOnboardingWorkspace(): OnboardingWorkspace {
  return {
    dataMode: "fixture",
    sourceLabel: "Local fixture adapter",
    warning:
      "This test workspace is browser-memory only. No tenant, membership, invitation or email has been created.",
    tenant: {
      tenantId: "tenant_northstar_demo",
      name: "Northstar Academy",
      slug: "northstar-academy",
      planId: "enterprise",
      region: "United States",
      status: "draft",
    },
    owner: {
      displayName: "Emiel",
      email: "owner@example.test",
      role: "owner",
    },
    brand: {
      assistantName: "Estie",
      primary: "#245c48",
      accent: "#d8b978",
      welcome: "Hi — what would you like to learn today?",
    },
    invitations: [
      {
        invitationId: "invitation_client_preview",
        name: "Alex Morgan",
        email: "alex@example.test",
        role: "tenant_admin",
        status: "pending",
        expiresAt: "2026-07-31T09:00:00.000Z",
      },
    ],
    readiness: [
      {
        key: "organization",
        label: "Organization identity",
        complete: true,
        detail: "Name and workspace address are present.",
      },
      {
        key: "brand",
        label: "Assistant identity",
        complete: true,
        detail: "Assistant name and accessible colors are present.",
      },
      {
        key: "team",
        label: "First client admin",
        complete: false,
        detail: "The fixture invitation still needs acceptance.",
      },
      {
        key: "learning",
        label: "Learning readiness",
        complete: false,
        detail: "Publish at least one validated lesson before launch.",
      },
      {
        key: "privacy",
        label: "Privacy policy",
        complete: false,
        detail: "Production retention policy O-13 still requires approval.",
      },
    ],
    updatedAt: fixtureTimestamp,
  };
}

function normalizedRole(role: string): OnboardingRole {
  if (role === "creator" || role === "teacher") return role;
  return "tenant_admin";
}

function mapCoreSnapshot(envelope: CoreEnvelope): OnboardingWorkspace {
  const snapshot = envelope.snapshot;
  if (!snapshot) throw new Error(envelope.message ?? "Onboarding snapshot is missing.");
  const durable = envelope.durable === true;
  return {
    dataMode: durable ? "durable" : "fixture",
    sourceLabel: durable ? "Durable tenant service" : "Explicit fixture service",
    ...(durable
      ? {}
      : {
          warning:
            "This API is an explicit development fixture. Invitations are not emailed and production identity is not activated.",
        }),
    tenant: {
      tenantId: snapshot.tenantId,
      name: snapshot.displayName,
      slug: snapshot.slug,
      planId: snapshot.planId,
      region: "Configured tenant region",
      status: snapshot.launch.ready ? "ready" : "draft",
    },
    owner: {
      displayName: "Emiel",
      email: "owner@example.test",
      role: "owner",
    },
    brand: {
      assistantName: snapshot.branding.assistantName,
      primary: snapshot.branding.primaryColor,
      accent: snapshot.branding.accentColor,
      welcome: "Hi — what would you like to learn today?",
    },
    invitations: snapshot.invitations.map((item, index) => ({
      invitationId: item.invitationId,
      name: `Invited teammate ${index + 1}`,
      email: item.emailHint,
      role: normalizedRole(item.role),
      status: item.status === "accepted" ? "accepted" : "pending",
      expiresAt: item.expiresAt,
    })),
    readiness: snapshot.steps.map((step) => ({
      key: step.key,
      label: step.title,
      complete: step.status === "complete" || step.status === "not_applicable",
      detail: step.evidenceNote ?? step.description,
    })),
    updatedAt:
      snapshot.updatedAt ??
      snapshot.steps.map((step) => step.updatedAt).sort().at(-1) ??
      fixtureTimestamp,
  };
}

function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function setReady(
  workspace: OnboardingWorkspace,
  key: string,
  complete: boolean,
  detail?: string,
) {
  return workspace.readiness.map((item) =>
    item.key === key ? { ...item, complete, detail: detail ?? item.detail } : item,
  );
}

export function applyFixtureOnboardingAction(
  workspace: OnboardingWorkspace,
  command: OnboardingAction,
  now = new Date(fixtureTimestamp),
): OnboardingWorkspace {
  if (workspace.dataMode !== "fixture") {
    throw new Error("Fixture actions cannot mutate a durable onboarding snapshot.");
  }
  const updatedAt = now.toISOString();
  if (command.action === "save_organization") {
    const name = command.input.name.trim();
    const slug = normalizeSlug(command.input.slug);
    if (name.length < 2 || slug.length < 2) {
      throw new Error("Enter an organization name and a valid workspace address.");
    }
    return {
      ...workspace,
      tenant: { ...workspace.tenant, name, slug },
      readiness: setReady(workspace, "organization", true),
      updatedAt,
    };
  }
  if (command.action === "save_brand") {
    const assistantName = command.input.assistantName.trim();
    const welcome = command.input.welcome.trim();
    if (!assistantName || !welcome) {
      throw new Error("Assistant name and welcome message are required.");
    }
    return {
      ...workspace,
      brand: { ...command.input, assistantName, welcome },
      readiness: setReady(workspace, "brand", true),
      updatedAt,
    };
  }
  if (command.action === "send_invitation") {
    const email = command.input.email.trim().toLowerCase();
    const name = command.input.name.trim();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a client name and a valid email address.");
    }
    if (workspace.invitations.some((item) => item.email.toLowerCase() === email)) {
      throw new Error("That person already has an invitation in this workspace.");
    }
    return {
      ...workspace,
      invitations: [
        ...workspace.invitations,
        {
          invitationId: `fixture_invitation_${workspace.invitations.length + 1}`,
          name,
          email,
          role: command.input.role,
          status: "pending",
          expiresAt: new Date(
            now.getTime() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      ],
      updatedAt,
    };
  }
  const invitation = workspace.invitations.find(
    (item) => item.invitationId === command.input.invitationId,
  );
  if (!invitation) throw new Error("The selected invitation is no longer available.");
  if (command.action === "accept_invitation") {
    if (!command.input.acceptedByName.trim()) {
      throw new Error("Enter your name before accepting the invitation.");
    }
    return {
      ...workspace,
      invitations: workspace.invitations.map((item) =>
        item.invitationId === invitation.invitationId
          ? {
              ...item,
              name: command.input.acceptedByName.trim(),
              status: "accepted",
              acceptedAt: updatedAt,
            }
          : item,
      ),
      readiness: setReady(
        workspace,
        "team",
        true,
        "The first client administrator accepted their preview invitation.",
      ),
      updatedAt,
    };
  }
  if (invitation.status === "pending") {
    throw new Error("Accept the invitation before completing the client profile.");
  }
  const displayName = command.input.displayName.trim();
  if (!displayName) throw new Error("Enter the name your team should see.");
  return {
    ...workspace,
    invitations: workspace.invitations.map((item) =>
      item.invitationId === invitation.invitationId
        ? { ...item, name: displayName, status: "profile_complete" }
        : item,
    ),
    updatedAt,
  };
}

async function readEnvelope(response: Response) {
  const envelope = (await response.json()) as CoreEnvelope;
  if (!response.ok) throw new Error(envelope.message ?? "Onboarding is unavailable.");
  return mapCoreSnapshot(envelope);
}

export async function loadOnboardingWorkspace(
  signal?: AbortSignal,
): Promise<OnboardingWorkspace> {
  return readEnvelope(
    await fetch("/api/dev/onboarding", {
      cache: "no-store",
      ...(signal ? { signal } : {}),
    }),
  );
}

export async function loadVerifiedFixtureIdentity(): Promise<VerifiedFixtureIdentity> {
  const response = await fetch("/api/dev/onboarding/invitation", {
    cache: "no-store",
  });
  const envelope = (await response.json()) as {
    readonly identity?: VerifiedFixtureIdentity;
    readonly message?: string;
  };
  if (!response.ok || !envelope.identity) {
    throw new Error(
      envelope.message ?? "The verified client preview identity is unavailable.",
    );
  }
  return envelope.identity;
}

function toCoreCommand(workspace: OnboardingWorkspace, command: OnboardingAction) {
  const idempotencyKey = `onboarding-${command.action}-${crypto.randomUUID()}`;
  if (command.action === "save_organization") {
    return {
      action: "update_tenant_profile",
      displayName: command.input.name,
      slug: command.input.slug,
      planId: workspace.tenant.planId,
      assistantName: workspace.brand.assistantName,
      primaryColor: workspace.brand.primary,
      accentColor: workspace.brand.accent,
      circlePlan: "unconfirmed",
      idempotencyKey,
    };
  }
  if (command.action === "save_brand") {
    return {
      action: "update_tenant_profile",
      displayName: workspace.tenant.name,
      slug: workspace.tenant.slug,
      planId: workspace.tenant.planId,
      assistantName: command.input.assistantName,
      primaryColor: command.input.primary,
      accentColor: command.input.accent,
      circlePlan: "unconfirmed",
      idempotencyKey,
    };
  }
  if (command.action === "send_invitation") {
    return {
      action: "invite_client_admin",
      email: command.input.email,
      role: command.input.role,
      expiresInHours: 168,
      idempotencyKey,
    };
  }
  return null;
}

export async function runOnboardingAction(
  workspace: OnboardingWorkspace,
  command: OnboardingAction,
): Promise<OnboardingWorkspace> {
  if (workspace.dataMode === "fixture") {
    if (command.action === "complete_client_profile") {
      return applyFixtureOnboardingAction(workspace, command, new Date());
    }
    if (command.action === "accept_invitation") {
      const response = await fetch("/api/dev/onboarding/invitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "accept",
          invitationId: command.input.invitationId,
          idempotencyKey: `onboarding-accept-${crypto.randomUUID()}`,
        }),
      });
      const envelope = (await response.json()) as { readonly message?: string };
      if (!response.ok) {
        throw new Error(
          envelope.message ?? "The invitation acceptance was not recorded.",
        );
      }
      return loadOnboardingWorkspace();
    }
  }
  const body = toCoreCommand(workspace, command);
  if (!body) {
    throw new Error(
      "Client acceptance is preview-only until the token-bound identity route is connected.",
    );
  }
  return readEnvelope(
    await fetch("/api/dev/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
