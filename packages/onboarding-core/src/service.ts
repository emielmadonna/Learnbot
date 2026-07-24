import { OnboardingError } from "./errors.js";
import type {
  OnboardingAggregate,
  OnboardingRepository,
  OnboardingRepositoryDurability,
  OnboardingUnitOfWork,
} from "./repository.js";
import {
  ONBOARDING_STEP_KEYS,
  type AcceptOnboardingInvitationCommand,
  type AcceptOnboardingInvitationContext,
  type CirclePlan,
  type InviteClientAdminCommand,
  type OnboardingActorRole,
  type OnboardingAuditEvent,
  type OnboardingCommandContext,
  type OnboardingInvitationView,
  type OnboardingLaunchReadiness,
  type OnboardingSnapshot,
  type OnboardingStep,
  type OnboardingStepKey,
  type OnboardingStepStatus,
  type OnboardingWorkspace,
  type ReviewOrActivateCommand,
  type RevokeOnboardingInvitationCommand,
  type SetOnboardingStepCommand,
  type StoredOnboardingInvitation,
  type UpdateTenantProfileCommand,
} from "./types.js";

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const POLICY_GATED_STEPS = new Set<OnboardingStepKey>([
  "recording_policy",
  "retention_policy",
]);

const STEP_DEFINITIONS: Readonly<
  Record<
    OnboardingStepKey,
    { readonly title: string; readonly description: string }
  >
> = {
  tenant_profile: {
    title: "Tenant identity & branding",
    description: "Confirm the workspace name, plan and accessible brand seed.",
  },
  identity_mode: {
    title: "Identity mode",
    description:
      "Record the client plan and the verified or degraded identity capability.",
  },
  provider_funding: {
    title: "Providers & funding",
    description:
      "Verify enabled provider routes, funding source and safe degraded behavior.",
  },
  source_ingestion: {
    title: "Knowledge sources",
    description: "Connect sources and complete resumable ingestion validation.",
  },
  assistant_voice_guide: {
    title: "Assistant guide",
    description: "Review and activate the tenant-authored assistant guide.",
  },
  diagram_review: {
    title: "Diagram review",
    description: "Approve instructional diagrams and accessible alternative text.",
  },
  context_mapping: {
    title: "Learning context",
    description: "Verify course, module and lesson context mappings.",
  },
  widget_branding: {
    title: "Widget branding",
    description: "Review the accessible live preview and installation settings.",
  },
  privacy_consent: {
    title: "Consent & privacy links",
    description: "Record approved consent copy and tenant privacy destinations.",
  },
  recording_policy: {
    title: "Voice recording policy",
    description:
      "Requires the explicit O-07 owner decision; raw audio is not stored by default.",
  },
  retention_policy: {
    title: "Retention policy",
    description: "Requires the explicit O-13 owner retention decision.",
  },
  playground_qa: {
    title: "Owner learning QA",
    description: "Run the scripted course questions and review grounding evidence.",
  },
  install_verification: {
    title: "Install verification",
    description: "Verify the embed and expected host events in the target client.",
  },
  client_handoff: {
    title: "Client handoff",
    description: "Invite an authorized client owner or administrator.",
  },
};

function requiredString(
  value: string,
  field: string,
  maximum = 512,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new OnboardingError(
      "onboarding.invalid_input",
      `${field} is required and exceeds no more than ${maximum} characters.`,
      { field },
    );
  }
  return normalized;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function roleCanManage(role: OnboardingActorRole): boolean {
  return (
    role === "platform_admin" ||
    role === "tenant_owner" ||
    role === "tenant_admin"
  );
}

function assertContext(context: OnboardingCommandContext): void {
  requiredString(context.tenantId, "tenantId");
  requiredString(context.actorId, "actorId");
  requiredString(context.requestId, "requestId");
  requiredString(context.traceId, "traceId");
  if (!roleCanManage(context.actorRole)) {
    throw new OnboardingError(
      "onboarding.access_denied",
      "The verified actor cannot manage onboarding.",
    );
  }
}

function assertVersion(
  workspace: OnboardingWorkspace,
  expectedVersion: number | undefined,
): void {
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion !== workspace.version)
  ) {
    throw new OnboardingError(
      "onboarding.conflict",
      "The onboarding workspace changed; refresh before retrying.",
      { currentVersion: workspace.version },
    );
  }
}

function identityMode(circlePlan: CirclePlan) {
  if (circlePlan === "business_plus") return "verified" as const;
  if (circlePlan === "professional") return "self_reported" as const;
  if (circlePlan === "not_circle") return "verified" as const;
  return "unconfirmed" as const;
}

function replaceStep(
  workspace: OnboardingWorkspace,
  stepKey: OnboardingStepKey,
  patch: Pick<OnboardingStep, "status" | "updatedAt"> & {
    readonly evidenceNote?: string;
  },
): readonly OnboardingStep[] {
  return workspace.steps.map((step) => {
    if (step.key !== stepKey) return step;
    const evidenceNote =
      patch.evidenceNote === undefined
        ? step.evidenceNote
        : requiredString(patch.evidenceNote, "evidenceNote", 500);
    return {
      ...step,
      status: patch.status,
      updatedAt: patch.updatedAt,
      ...(evidenceNote === undefined ? {} : { evidenceNote }),
    };
  });
}

function effectiveInvitationStatus(
  invitation: StoredOnboardingInvitation,
  now: Date,
) {
  if (
    invitation.status === "pending" &&
    Date.parse(invitation.expiresAt) <= now.getTime()
  ) {
    return "expired" as const;
  }
  return invitation.status;
}

function emailHint(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, 1);
  return `${visible}${local.length > 1 ? "***" : ""}@${domain}`;
}

function invitationView(
  invitation: StoredOnboardingInvitation,
  now: Date,
): OnboardingInvitationView {
  return {
    invitationId: invitation.invitationId,
    emailHint: emailHint(invitation.emailNormalized),
    role: invitation.role,
    status: effectiveInvitationStatus(invitation, now),
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}

function launchReadiness(
  workspace: OnboardingWorkspace,
): OnboardingLaunchReadiness {
  const blockers: string[] = [];
  for (const step of workspace.steps) {
    if (
      step.required &&
      step.status !== "complete" &&
      step.status !== "not_applicable"
    ) {
      blockers.push(`${step.key}:${step.status}`);
    }
  }
  if (
    workspace.steps.find((step) => step.key === "recording_policy")?.status !==
    "complete"
  ) {
    blockers.push("O-07:voice_recording_policy_decision_required");
  }
  if (
    workspace.steps.find((step) => step.key === "retention_policy")?.status !==
    "complete"
  ) {
    blockers.push("O-13:retention_policy_decision_required");
  }
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function snapshot(
  aggregate: OnboardingAggregate,
  now: Date,
): OnboardingSnapshot {
  return {
    ...aggregate.workspace,
    invitations: aggregate.invitations
      .map((invitation) => invitationView(invitation, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    launch: launchReadiness(aggregate.workspace),
    audit: [...aggregate.audit]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 50),
  };
}

function aggregateFromTransaction(
  transaction: OnboardingUnitOfWork,
): OnboardingAggregate {
  return {
    workspace: transaction.getWorkspace(),
    invitations: transaction.listInvitations(),
    audit: transaction.listAudit(),
  };
}

function appendAudit(
  transaction: OnboardingUnitOfWork,
  context: OnboardingCommandContext,
  now: string,
  action: string,
  outcome: "allowed" | "denied",
  safeMetadata: Readonly<Record<string, string | number | boolean>>,
): void {
  const event: OnboardingAuditEvent = {
    eventId: `onboarding_event_${stableHash(
      `${context.tenantId}\u0000${context.requestId}\u0000${action}`,
    )}`,
    tenantId: context.tenantId,
    action,
    outcome,
    occurredAt: now,
    actorId: context.actorId,
    requestId: context.requestId,
    traceId: context.traceId,
    safeMetadata,
  };
  transaction.appendAudit(event);
}

export function createOnboardingWorkspaceSeed(input: {
  readonly onboardingId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly planId: string;
  readonly assistantName: string;
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly now: string;
}): OnboardingWorkspace {
  return {
    onboardingId: input.onboardingId,
    tenantId: input.tenantId,
    displayName: input.displayName,
    slug: input.slug,
    planId: input.planId,
    status: "draft",
    version: 1,
    branding: {
      assistantName: input.assistantName,
      primaryColor: input.primaryColor,
      accentColor: input.accentColor,
    },
    identity: {
      circlePlan: "unconfirmed",
      expectedMode: "unconfirmed",
    },
    steps: ONBOARDING_STEP_KEYS.map((key) => ({
      key,
      title: STEP_DEFINITIONS[key].title,
      description: STEP_DEFINITIONS[key].description,
      status:
        key === "recording_policy" || key === "retention_policy"
          ? "blocked"
          : key === "tenant_profile"
            ? "complete"
            : "not_started",
      required: true,
      updatedAt: input.now,
      ...(key === "recording_policy"
        ? { evidenceNote: "Blocked pending explicit O-07 owner decision." }
        : {}),
      ...(key === "retention_policy"
        ? { evidenceNote: "Blocked pending explicit O-13 owner decision." }
        : {}),
    })),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface OnboardingServiceOptions {
  readonly requiredDurability: OnboardingRepositoryDurability;
  readonly now?: () => Date;
}

export class OnboardingService {
  readonly #now: () => Date;

  constructor(
    private readonly repository: OnboardingRepository,
    options: OnboardingServiceOptions,
  ) {
    if (repository.durability !== options.requiredDurability) {
      throw new OnboardingError(
        "onboarding.durable_adapter_required",
        "Onboarding persistence does not match the required deployment mode.",
        {
          requiredDurability: options.requiredDurability,
          actualDurability: repository.durability,
        },
      );
    }
    this.#now = options.now ?? (() => new Date());
  }

  async getSnapshot(
    context: OnboardingCommandContext,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    const aggregate = await this.repository.read(context.tenantId);
    if (aggregate === undefined) {
      throw new OnboardingError(
        "onboarding.not_found",
        "No onboarding workspace exists for the active tenant.",
      );
    }
    return snapshot(aggregate, this.#now());
  }

  async updateTenantProfile(
    context: OnboardingCommandContext,
    command: UpdateTenantProfileCommand,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    const displayName = requiredString(command.displayName, "displayName", 120);
    const slug = requiredString(command.slug, "slug", 63).toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new OnboardingError(
        "onboarding.invalid_input",
        "The tenant slug has an invalid format.",
        { field: "slug" },
      );
    }
    const planId = requiredString(command.planId, "planId", 80);
    const assistantName = requiredString(
      command.assistantName,
      "assistantName",
      80,
    );
    if (
      !COLOR_PATTERN.test(command.primaryColor) ||
      !COLOR_PATTERN.test(command.accentColor)
    ) {
      throw new OnboardingError(
        "onboarding.invalid_input",
        "Brand colors must be six-digit hexadecimal colors.",
        { field: "branding" },
      );
    }
    return this.#mutate(
      context,
      "profile.update",
      command.idempotencyKey,
      command,
      (transaction, now) => {
        const current = transaction.getWorkspace();
        assertVersion(current, command.expectedVersion);
        const identity = {
          circlePlan: command.circlePlan,
          expectedMode: identityMode(command.circlePlan),
        };
        let steps = replaceStep(current, "tenant_profile", {
          status: "complete",
          updatedAt: now,
        });
        steps = replaceStep(
          { ...current, steps },
          "identity_mode",
          {
            status:
              command.circlePlan === "unconfirmed" ? "in_progress" : "complete",
            updatedAt: now,
            evidenceNote:
              command.circlePlan === "professional"
                ? "Professional plan recorded: self-reported identity and no verified progress webhooks."
                : command.circlePlan === "business_plus"
                  ? "Business+ plan recorded: verified identity capability expected after integration testing."
                  : command.circlePlan === "not_circle"
                    ? "Non-Circle host: identity remains gated on a separately verified host integration."
                    : "Client plan still requires confirmation.",
          },
        );
        const workspace: OnboardingWorkspace = {
          ...current,
          displayName,
          slug,
          planId,
          status: "in_progress",
          version: current.version + 1,
          branding: {
            assistantName,
            primaryColor: command.primaryColor.toUpperCase(),
            accentColor: command.accentColor.toUpperCase(),
          },
          identity,
          steps,
          updatedAt: now,
        };
        transaction.saveWorkspace(workspace);
        appendAudit(
          transaction,
          context,
          now,
          "onboarding.profile.update",
          "allowed",
          {
            onboardingId: workspace.onboardingId,
            version: workspace.version,
            circlePlan: command.circlePlan,
          },
        );
      },
    );
  }

  async setStep(
    context: OnboardingCommandContext,
    command: SetOnboardingStepCommand,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    if (!ONBOARDING_STEP_KEYS.includes(command.stepKey)) {
      throw new OnboardingError(
        "onboarding.invalid_input",
        "The onboarding step is unknown.",
        { field: "stepKey" },
      );
    }
    if (POLICY_GATED_STEPS.has(command.stepKey)) {
      throw new OnboardingError(
        "onboarding.policy_decision_required",
        "This step requires an explicit approved owner policy decision.",
        { stepKey: command.stepKey },
      );
    }
    const allowedStatuses = new Set<OnboardingStepStatus>([
      "not_started",
      "in_progress",
      "complete",
      "blocked",
      "not_applicable",
    ]);
    if (!allowedStatuses.has(command.status)) {
      throw new OnboardingError(
        "onboarding.invalid_input",
        "The onboarding step status is invalid.",
        { field: "status" },
      );
    }
    return this.#mutate(
      context,
      "step.set",
      command.idempotencyKey,
      command,
      (transaction, now) => {
        const current = transaction.getWorkspace();
        assertVersion(current, command.expectedVersion);
        const steps = replaceStep(current, command.stepKey, {
          status: command.status,
          updatedAt: now,
          ...(command.evidenceNote === undefined
            ? {}
            : { evidenceNote: command.evidenceNote }),
        });
        const workspace: OnboardingWorkspace = {
          ...current,
          status: "in_progress",
          version: current.version + 1,
          steps,
          updatedAt: now,
        };
        transaction.saveWorkspace(workspace);
        appendAudit(
          transaction,
          context,
          now,
          "onboarding.step.set",
          "allowed",
          {
            onboardingId: workspace.onboardingId,
            stepKey: command.stepKey,
            status: command.status,
            version: workspace.version,
          },
        );
      },
    );
  }

  async inviteClientAdmin(
    context: OnboardingCommandContext,
    command: InviteClientAdminCommand,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    const roleAllowed =
      context.actorRole === "platform_admin" ||
      (context.actorRole === "tenant_owner" &&
        command.role !== "tenant_owner") ||
      (context.actorRole === "tenant_admin" &&
        (command.role === "creator" || command.role === "teacher"));
    if (!roleAllowed) {
      throw new OnboardingError(
        "onboarding.access_denied",
        "The verified actor cannot assign the requested tenant role.",
      );
    }
    const email = requiredString(command.email, "email", 320).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new OnboardingError(
        "onboarding.invalid_input",
        "A valid invitation email is required.",
        { field: "email" },
      );
    }
    if (
      !Number.isSafeInteger(command.expiresInHours) ||
      command.expiresInHours < 1 ||
      command.expiresInHours > 168
    ) {
      throw new OnboardingError(
        "onboarding.invalid_input",
        "Invitation expiry must be between 1 and 168 hours.",
        { field: "expiresInHours" },
      );
    }
    return this.#mutate(
      context,
      "invitation.create",
      command.idempotencyKey,
      { ...command, email },
      (transaction, now) => {
        const current = transaction.getWorkspace();
        const duplicate = transaction.listInvitations().find(
          (candidate) =>
            candidate.emailNormalized === email &&
            effectiveInvitationStatus(candidate, new Date(now)) === "pending",
        );
        if (duplicate !== undefined) {
          throw new OnboardingError(
            "onboarding.conflict",
            "A pending invitation already exists for this client.",
          );
        }
        const invitation: StoredOnboardingInvitation = {
          invitationId: `invitation_${stableHash(
            `${context.tenantId}\u0000${command.idempotencyKey}`,
          )}`,
          tenantId: context.tenantId,
          emailNormalized: email,
          role: command.role,
          status: "pending",
          expiresAt: new Date(
            Date.parse(now) + command.expiresInHours * 3_600_000,
          ).toISOString(),
          createdAt: now,
        };
        transaction.saveInvitation(invitation);
        const workspace: OnboardingWorkspace = {
          ...current,
          status: "in_progress",
          version: current.version + 1,
          steps: replaceStep(current, "client_handoff", {
            status: "in_progress",
            updatedAt: now,
            evidenceNote:
              "Invitation issued; handoff completes only after verified acceptance.",
          }),
          updatedAt: now,
        };
        transaction.saveWorkspace(workspace);
        appendAudit(
          transaction,
          context,
          now,
          "onboarding.invitation.create",
          "allowed",
          {
            invitationId: invitation.invitationId,
            role: invitation.role,
            expiresInHours: command.expiresInHours,
          },
        );
      },
    );
  }

  async revokeInvitation(
    context: OnboardingCommandContext,
    command: RevokeOnboardingInvitationCommand,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    const invitationId = requiredString(
      command.invitationId,
      "invitationId",
    );
    return this.#mutate(
      context,
      "invitation.revoke",
      command.idempotencyKey,
      command,
      (transaction, now) => {
        const invitation = transaction
          .listInvitations()
          .find((candidate) => candidate.invitationId === invitationId);
        if (
          invitation === undefined ||
          effectiveInvitationStatus(invitation, new Date(now)) !== "pending"
        ) {
          throw new OnboardingError(
            "onboarding.not_found",
            "No pending invitation exists in the active tenant.",
          );
        }
        transaction.saveInvitation({
          ...invitation,
          status: "revoked",
          revokedAt: now,
        });
        const current = transaction.getWorkspace();
        transaction.saveWorkspace({
          ...current,
          version: current.version + 1,
          updatedAt: now,
        });
        appendAudit(
          transaction,
          context,
          now,
          "onboarding.invitation.revoke",
          "allowed",
          { invitationId },
        );
      },
    );
  }

  async acceptInvitation(
    context: AcceptOnboardingInvitationContext,
    command: AcceptOnboardingInvitationCommand,
  ): Promise<OnboardingSnapshot> {
    const tenantId = requiredString(context.tenantId, "tenantId");
    const actorId = requiredString(context.actorId, "actorId");
    const authenticatedEmail = requiredString(
      context.authenticatedEmail,
      "authenticatedEmail",
      320,
    ).toLowerCase();
    const commandContext: OnboardingCommandContext = {
      tenantId,
      actorId,
      actorRole: "tenant_admin",
      requestId: requiredString(context.requestId, "requestId"),
      traceId: requiredString(context.traceId, "traceId"),
    };
    return this.#mutate(
      commandContext,
      "invitation.accept",
      command.idempotencyKey,
      { invitationId: command.invitationId, actorId },
      (transaction, now) => {
        const invitation = transaction.listInvitations().find(
          (candidate) =>
            candidate.invitationId === command.invitationId &&
            candidate.tenantId === tenantId,
        );
        if (
          invitation === undefined ||
          effectiveInvitationStatus(invitation, new Date(now)) !== "pending" ||
          invitation.emailNormalized !== authenticatedEmail
        ) {
          throw new OnboardingError(
            "onboarding.access_denied",
            "The verified identity does not match an active invitation.",
          );
        }
        transaction.saveInvitation({
          ...invitation,
          status: "accepted",
          acceptedByActorId: actorId,
          acceptedAt: now,
        });
        const current = transaction.getWorkspace();
        transaction.saveWorkspace({
          ...current,
          status: "in_progress",
          version: current.version + 1,
          steps: replaceStep(current, "client_handoff", {
            status: "complete",
            updatedAt: now,
            evidenceNote: "Invitation accepted by a verified matching identity.",
          }),
          updatedAt: now,
        });
        appendAudit(
          transaction,
          commandContext,
          now,
          "onboarding.invitation.accept",
          "allowed",
          { invitationId: invitation.invitationId, role: invitation.role },
        );
      },
    );
  }

  async requestLaunchReview(
    context: OnboardingCommandContext,
    command: ReviewOrActivateCommand,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    return this.#mutate(
      context,
      "launch.review",
      command.idempotencyKey,
      command,
      (transaction, now) => {
        const current = transaction.getWorkspace();
        assertVersion(current, command.expectedVersion);
        const launch = launchReadiness(current);
        const workspace: OnboardingWorkspace = {
          ...current,
          status: launch.ready ? "ready_for_launch" : "blocked",
          version: current.version + 1,
          updatedAt: now,
        };
        transaction.saveWorkspace(workspace);
        appendAudit(
          transaction,
          context,
          now,
          "onboarding.launch.review",
          launch.ready ? "allowed" : "denied",
          {
            onboardingId: workspace.onboardingId,
            blockerCount: launch.blockers.length,
            version: workspace.version,
          },
        );
      },
    );
  }

  async activate(
    context: OnboardingCommandContext,
    command: ReviewOrActivateCommand,
  ): Promise<OnboardingSnapshot> {
    assertContext(context);
    if (context.actorRole === "tenant_admin") {
      throw new OnboardingError(
        "onboarding.access_denied",
        "Only an owner can activate a tenant.",
      );
    }
    return this.#mutate(
      context,
      "launch.activate",
      command.idempotencyKey,
      command,
      (transaction, now) => {
        const current = transaction.getWorkspace();
        assertVersion(current, command.expectedVersion);
        const launch = launchReadiness(current);
        if (!launch.ready) {
          throw new OnboardingError(
            "onboarding.launch_blocked",
            "The tenant cannot go live until every required gate is complete.",
            { blockerCount: launch.blockers.length },
          );
        }
        const workspace: OnboardingWorkspace = {
          ...current,
          status: "live",
          version: current.version + 1,
          updatedAt: now,
          launchedAt: now,
        };
        transaction.saveWorkspace(workspace);
        appendAudit(
          transaction,
          context,
          now,
          "onboarding.launch.activate",
          "allowed",
          {
            onboardingId: workspace.onboardingId,
            version: workspace.version,
          },
        );
      },
    );
  }

  async #mutate(
    context: OnboardingCommandContext,
    scope: string,
    idempotencyKey: string,
    request: unknown,
    operation: (transaction: OnboardingUnitOfWork, now: string) => void,
  ): Promise<OnboardingSnapshot> {
    const normalizedKey = requiredString(
      idempotencyKey,
      "idempotencyKey",
      256,
    );
    const now = this.#now();
    const result = await this.repository.execute<OnboardingSnapshot>({
      tenantId: context.tenantId,
      scope,
      idempotencyKey: normalizedKey,
      requestFingerprint: fingerprint(request),
      operation: (transaction) => {
        operation(transaction, now.toISOString());
        return snapshot(aggregateFromTransaction(transaction), now);
      },
    });
    return result.result;
  }
}
