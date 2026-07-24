import assert from "node:assert/strict";
import test from "node:test";
import {
  ExplicitFixtureOnboardingRepository,
  OnboardingError,
  OnboardingService,
  createOnboardingWorkspaceSeed,
  type OnboardingCommandContext,
} from "../src/index.js";

const NOW = "2026-07-24T12:00:00.000Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function context(
  tenantId = TENANT_A,
  actorRole: OnboardingCommandContext["actorRole"] = "tenant_owner",
): OnboardingCommandContext {
  return {
    tenantId,
    actorId: `actor-${tenantId}`,
    actorRole,
    requestId: `request-${tenantId}`,
    traceId: `trace-${tenantId}`,
  };
}

function service() {
  const repository = new ExplicitFixtureOnboardingRepository([
    {
      workspace: createOnboardingWorkspaceSeed({
        onboardingId: "onboarding-a",
        tenantId: TENANT_A,
        displayName: "Tenant A",
        slug: "tenant-a",
        planId: "enterprise",
        assistantName: "Aster",
        primaryColor: "#315F50",
        accentColor: "#D8A653",
        now: NOW,
      }),
      invitations: [],
      audit: [],
    },
    {
      workspace: createOnboardingWorkspaceSeed({
        onboardingId: "onboarding-b",
        tenantId: TENANT_B,
        displayName: "Tenant B",
        slug: "tenant-b",
        planId: "starter",
        assistantName: "Beacon",
        primaryColor: "#112233",
        accentColor: "#445566",
        now: NOW,
      }),
      invitations: [],
      audit: [],
    },
  ]);
  return {
    repository,
    onboarding: new OnboardingService(repository, {
      requiredDurability: "fixture",
      now: () => new Date(NOW),
    }),
  };
}

test("fixture mode is explicit and durable mode fails closed", () => {
  const { repository } = service();
  assert.equal(repository.durability, "fixture");
  try {
    new OnboardingService(repository, { requiredDurability: "durable" });
    throw new Error("expected durable adapter failure");
  } catch (error) {
    assert.equal(
      error instanceof OnboardingError ? error.code : "",
      "onboarding.durable_adapter_required",
    );
  }
});

test("tenant profile derives identity capability and never trusts another tenant", async () => {
  const { onboarding } = service();
  const updated = await onboarding.updateTenantProfile(context(), {
    displayName: "Tenant A Academy",
    slug: "tenant-a-academy",
    planId: "enterprise",
    assistantName: "Aster",
    primaryColor: "#123456",
    accentColor: "#ABCDEF",
    circlePlan: "professional",
    idempotencyKey: "profile-1",
    expectedVersion: 1,
  });
  assert.equal(updated.identity.expectedMode, "self_reported");
  assert.equal(updated.version, 2);
  const other = await onboarding.getSnapshot(context(TENANT_B));
  assert.equal(other.displayName, "Tenant B");
  assert.equal(other.version, 1);
});

test("commands are replay-safe and reject idempotency key reuse", async () => {
  const { onboarding } = service();
  const command = {
    stepKey: "source_ingestion" as const,
    status: "complete" as const,
    evidenceNote: "Validated ingestion job evidence ref: job_fixture_1.",
    idempotencyKey: "step-1",
    expectedVersion: 1,
  };
  const first = await onboarding.setStep(context(), command);
  const replay = await onboarding.setStep(context(), command);
  assert.deepEqual(replay, first);
  await assert.rejects(
    () =>
      onboarding.setStep(context(), {
        ...command,
        status: "blocked",
      }),
    (error) =>
      error instanceof OnboardingError &&
      error.code === "onboarding.idempotency_conflict",
  );
});

test("O-07 and O-13 cannot be completed without approved policy decisions", async () => {
  const { onboarding } = service();
  for (const stepKey of ["recording_policy", "retention_policy"] as const) {
    await assert.rejects(
      () =>
        onboarding.setStep(context(), {
          stepKey,
          status: "complete",
          idempotencyKey: `policy-${stepKey}`,
        }),
      (error) =>
        error instanceof OnboardingError &&
        error.code === "onboarding.policy_decision_required",
    );
  }
  const snapshot = await onboarding.requestLaunchReview(context(), {
    idempotencyKey: "review-1",
  });
  assert.equal(snapshot.status, "blocked");
  assert.equal(
    snapshot.launch.blockers.includes(
      "O-07:voice_recording_policy_decision_required",
    ),
    true,
  );
  assert.equal(
    snapshot.launch.blockers.includes(
      "O-13:retention_policy_decision_required",
    ),
    true,
  );
});

test("invitation views mask email and acceptance requires an exact verified match", async () => {
  const { onboarding } = service();
  const invited = await onboarding.inviteClientAdmin(context(), {
    email: "Client.Owner@Example.com",
    role: "tenant_admin",
    expiresInHours: 24,
    idempotencyKey: "invite-1",
  });
  const invitation = invited.invitations[0];
  assert.equal(invitation?.emailHint, "c***@example.com");
  assert.equal(JSON.stringify(invited).includes("client.owner@example.com"), false);
  await assert.rejects(
    () =>
      onboarding.acceptInvitation(
        {
          tenantId: TENANT_A,
          actorId: "client-principal",
          authenticatedEmail: "attacker@example.com",
          requestId: "accept-request-denied",
          traceId: "accept-trace-denied",
        },
        {
          invitationId: invitation?.invitationId ?? "",
          idempotencyKey: "accept-denied",
        },
      ),
    (error) =>
      error instanceof OnboardingError &&
      error.code === "onboarding.access_denied",
  );
  const accepted = await onboarding.acceptInvitation(
    {
      tenantId: TENANT_A,
      actorId: "client-principal",
      authenticatedEmail: "client.owner@example.com",
      requestId: "accept-request",
      traceId: "accept-trace",
    },
    {
      invitationId: invitation?.invitationId ?? "",
      idempotencyKey: "accept-1",
    },
  );
  assert.equal(accepted.invitations[0]?.status, "accepted");
  assert.equal(
    accepted.steps.find((step) => step.key === "client_handoff")?.status,
    "complete",
  );
});

test("tenant admins cannot grant owner or activate a tenant", async () => {
  const { onboarding } = service();
  await assert.rejects(
    () =>
      onboarding.inviteClientAdmin(context(TENANT_A, "tenant_admin"), {
        email: "owner@example.com",
        role: "tenant_owner",
        expiresInHours: 24,
        idempotencyKey: "forbidden-owner",
      }),
    (error) =>
      error instanceof OnboardingError &&
      error.code === "onboarding.access_denied",
  );
  await assert.rejects(
    () =>
      onboarding.activate(context(TENANT_A, "tenant_admin"), {
        idempotencyKey: "forbidden-launch",
      }),
    (error) =>
      error instanceof OnboardingError &&
      error.code === "onboarding.access_denied",
  );
});

test("tenant owners can invite client administrators, creators and teachers", async () => {
  const { onboarding } = service();
  let index = 0;
  for (const role of ["tenant_admin", "creator", "teacher"] as const) {
    index += 1;
    const result = await onboarding.inviteClientAdmin(context(), {
      email: `${role}@example.com`,
      role,
      expiresInHours: 24,
      idempotencyKey: `invite-role-${index}`,
    });
    assert.equal(
      result.invitations.some((invitation) => invitation.role === role),
      true,
    );
  }
});

test("allowed mutations append privacy-safe audit events", async () => {
  const { onboarding } = service();
  const result = await onboarding.inviteClientAdmin(context(), {
    email: "private.person@example.com",
    role: "tenant_admin",
    expiresInHours: 12,
    idempotencyKey: "audit-invite",
  });
  assert.equal(result.audit[0]?.action, "onboarding.invitation.create");
  assert.equal(
    JSON.stringify(result.audit).includes("private.person@example.com"),
    false,
  );
});
