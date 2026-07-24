import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hostedVerificationSuites,
  validateApproval,
  validateDatabaseUrl,
  validatePlanEvidence,
} from "./hosted-release.mjs";

const fingerprint = "a".repeat(64);
const now = new Date("2026-07-23T18:30:00.000Z");

function approval(overrides = {}) {
  return {
    schemaVersion: 1,
    projectRef: "abcdefghijklmnopqrst",
    projectName: "LearningBot Staging",
    environment: "staging",
    expectedRegion: "us-west-1",
    dedicatedForLearningBot: true,
    expectedDatabaseName: "postgres",
    expectedDatabaseRole: "postgres",
    migrationFingerprint: fingerprint,
    allowedActions: ["link", "plan", "apply", "verify"],
    approvedBy: "release-owner",
    approvedAt: "2026-07-23T18:00:00.000Z",
    expiresAt: "2026-07-24T18:00:00.000Z",
    ...overrides,
  };
}

test("accepts an exact, current, dedicated LearningBot approval", () => {
  assert.equal(validateApproval(approval(), fingerprint, "plan", now).environment, "staging");
});

test("rejects forbidden existing project names", () => {
  assert.throws(
    () => validateApproval(approval({ projectName: "HookLab Production" }), fingerprint, "plan", now),
    /outside this release lane/,
  );
  assert.throws(
    () => validateApproval(approval({ projectName: "Midway" }), fingerprint, "plan", now),
    /outside this release lane/,
  );
});

test("rejects stale, overlong, mismatched and under-scoped approvals", () => {
  assert.throws(
    () => validateApproval(approval({ expiresAt: "2026-07-23T18:29:00.000Z" }), fingerprint, "plan", now),
    /expired/,
  );
  assert.throws(
    () => validateApproval(approval({ expiresAt: "2026-07-28T18:00:00.000Z" }), fingerprint, "plan", now),
    /72 hours/,
  );
  assert.throws(
    () => validateApproval(approval({ migrationFingerprint: "b".repeat(64) }), fingerprint, "plan", now),
    /current ordered migrations/,
  );
  assert.throws(
    () => validateApproval(approval({ allowedActions: ["plan"] }), fingerprint, "apply", now),
    /does not allow apply/,
  );
  assert.throws(
    () => validateApproval(approval({ expectedRegion: "somewhere" }), fingerprint, "plan", now),
    /cloud region identifier/,
  );
});

test("binds database URLs to the exact project and database", () => {
  const direct = validateDatabaseUrl(
    "postgresql://postgres:ephemeral@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require",
    approval(),
  );
  assert.equal(direct.databaseName, "postgres");

  const pooler = validateDatabaseUrl(
    "postgresql://postgres.abcdefghijklmnopqrst:ephemeral@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require",
    approval(),
  );
  assert.equal(pooler.username, "postgres.abcdefghijklmnopqrst");

  assert.throws(
    () =>
      validateDatabaseUrl(
        "postgresql://postgres.otherprojectref1234:ephemeral@pooler.supabase.com:6543/postgres",
        approval(),
      ),
    /approved project ref/,
  );
  assert.throws(
    () =>
      validateDatabaseUrl(
        "postgresql://postgres:ephemeral@db.abcdefghijklmnopqrst.supabase.co:5432/wrong",
        approval(),
      ),
    /database URL name/,
  );
  assert.throws(
    () =>
      validateDatabaseUrl(
        "postgresql://postgres:ephemeral@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
        approval(),
      ),
    /strict TLS/,
  );
  assert.throws(
    () =>
      validateDatabaseUrl(
        "postgresql://postgres:ephemeral@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=disable",
        approval(),
      ),
    /strict TLS/,
  );
});

test("requires fresh successful plan evidence for the same release", () => {
  const plan = {
    kind: "supabase-hosted-release-plan",
    createdAt: "2026-07-23T18:20:00.000Z",
    success: true,
    projectRef: approval().projectRef,
    environment: "staging",
    expectedRegion: "us-west-1",
    migrationFingerprint: fingerprint,
  };
  assert.equal(validatePlanEvidence(plan, approval(), fingerprint, now), plan);
  assert.throws(
    () => validatePlanEvidence({ ...plan, projectRef: "zzzzzzzzzzzzzzzzzzzz" }, approval(), fingerprint, now),
    /does not match/,
  );
  assert.throws(
    () => validatePlanEvidence({ ...plan, createdAt: "2026-07-23T17:00:00.000Z" }, approval(), fingerprint, now),
    /older than 30 minutes/,
  );
});

test("runs every tenant, auth and onboarding SQL acceptance suite", () => {
  assert.deepEqual(hostedVerificationSuites, [
    "security_verification.sql",
    "durable_execution_primitives_verification.sql",
    "identity_provisioning_verification.sql",
    "durable_upload_intents_verification.sql",
    "onboarding_verification.sql",
    "auth_tenant_bridge_verification.sql",
    "authenticated_onboarding_rpcs_verification.sql",
  ]);
});
