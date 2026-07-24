import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyFixtureOnboardingAction,
  createFixtureOnboardingWorkspace,
} from "../src/app/dev/onboarding/onboarding-adapter";

const pageSource = readFileSync(
  new URL("../src/app/dev/onboarding/page.tsx", import.meta.url),
  "utf8",
);

test("fixture onboarding is explicit and cannot be mistaken for durable state", () => {
  const workspace = createFixtureOnboardingWorkspace();
  assert.equal(workspace.dataMode, "fixture");
  assert.equal(workspace.sourceLabel, "Local fixture adapter");
  assert.match(workspace.warning ?? "", /browser-memory only/i);
  assert.match(pageSource, /fixture preview only/);
  assert.match(pageSource, /never sends an email/);
});

test("owner setup validates invitations and bounds duplicate email addresses", () => {
  const workspace = createFixtureOnboardingWorkspace();
  assert.throws(
    () =>
      applyFixtureOnboardingAction(workspace, {
        action: "send_invitation",
        input: { name: "Jamie", email: "not-an-email", role: "teacher" },
      }),
    /valid email address/,
  );
  assert.throws(
    () =>
      applyFixtureOnboardingAction(workspace, {
        action: "send_invitation",
        input: {
          name: "Alex",
          email: "ALEX@example.test",
          role: "tenant_admin",
        },
      }),
    /already has an invitation/,
  );
});

test("client preview acceptance never invents production readiness", () => {
  const accepted = applyFixtureOnboardingAction(
    createFixtureOnboardingWorkspace(),
    {
      action: "accept_invitation",
      input: {
        invitationId: "invitation_client_preview",
        acceptedByName: "Alex Morgan",
      },
    },
  );
  assert.equal(accepted.invitations[0]?.status, "accepted");
  assert.equal(
    accepted.readiness.find((item) => item.key === "team")?.complete,
    true,
  );
  assert.equal(
    accepted.readiness.find((item) => item.key === "privacy")?.complete,
    false,
  );
  assert.equal(accepted.tenant.status, "draft");
});

test("client profile cannot bypass invitation acceptance", () => {
  assert.throws(
    () =>
      applyFixtureOnboardingAction(createFixtureOnboardingWorkspace(), {
        action: "complete_client_profile",
        input: {
          invitationId: "invitation_client_preview",
          displayName: "Alex Morgan",
        },
      }),
    /Accept the invitation/,
  );
});

test("surface exposes both journeys with accessible feedback", () => {
  assert.match(pageSource, /aria-label="Choose onboarding journey"/);
  assert.match(pageSource, /aria-pressed=\{journey === "owner"\}/);
  assert.match(pageSource, /aria-label="Client onboarding progress"/);
  assert.match(pageSource, /role="alert"/);
  assert.match(pageSource, /role="status" aria-live="polite"/);
  assert.match(pageSource, /Production launch stays gated/);
});
