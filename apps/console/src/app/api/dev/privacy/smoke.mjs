import assert from "node:assert/strict";

const baseUrl =
  process.env.PRIVACY_SMOKE_BASE_URL ??
  process.env.COURSE_AI_CONSOLE_URL ??
  "http://127.0.0.1:3100";

function timedFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
}

const snapshotResponse = await timedFetch(`${baseUrl}/api/dev/privacy`, {
  headers: { accept: "application/json" },
});
assert.equal(snapshotResponse.status, 200);
const snapshot = await snapshotResponse.json();
assert.match(snapshot.fixture.label, /DEVELOPMENT FIXTURE/);
assert.equal(snapshot.fixture.durable, false);
assert.equal(snapshot.policies.fixtureStatus, "demo_fixture_not_approved");
assert.equal(snapshot.policies.rawAudioRetentionDays, null);
assert.equal(snapshot.policies.policyDecisionBoundary.o07VoiceRecording, "blocked_pending_O07");
assert.ok(snapshot.jobs.some((job) => job.kind === "access" && job.status === "completed"));
assert.ok(snapshot.jobs.some((job) => job.kind === "export" && job.status === "completed"));
assert.ok(snapshot.jobs.some((job) => job.kind === "delete" && job.status === "partial"));
assert.ok(snapshot.jobs.some((job) => job.kind === "retention" && job.status === "partial"));
assert.ok(snapshot.manifests.some((manifest) => manifest.verification?.valid === true));
assert.ok(snapshot.tombstones.length > 0);
assert.ok(snapshot.audit.length > 0);

const previewResponse = await timedFetch(`${baseUrl}/api/dev/privacy`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-course-ai-tenant-id": snapshot.tenant.tenantId,
  },
  body: JSON.stringify({
    action: "preview",
    tenantId: snapshot.tenant.tenantId,
    operation: "delete",
    purpose: "tenant_privacy_administration",
    subjectId: "student_held_demo",
  }),
});
assert.equal(previewResponse.status, 200);
const preview = (await previewResponse.json()).preview;
assert.match(preview.requiredConfirmationPhrase, /^DELETE /);
assert.ok(preview.confirmationGrantId);
assert.ok(preview.heldRecordIds.includes("held_message"));

const rejectedResponse = await timedFetch(`${baseUrl}/api/dev/privacy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "create",
    operation: "delete",
    purpose: "tenant_privacy_administration",
    subjectId: "student_held_demo",
    idempotencyKey: "smoke-rejected-without-preview",
  }),
});
assert.equal(rejectedResponse.status, 422);
const rejectedBody = await rejectedResponse.json();
assert.equal(rejectedBody.code, "privacy.demo_invalid_request");
assert.doesNotMatch(JSON.stringify(rejectedBody), /student_held_demo/);

const nonObjectResponse = await timedFetch(`${baseUrl}/api/dev/privacy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify([]),
});
assert.equal(nonObjectResponse.status, 422);
assert.equal(
  (await nonObjectResponse.json()).code,
  "privacy.demo_invalid_request",
);

const oversizedKey = "x".repeat(129);
const oversizedFieldResponse = await timedFetch(`${baseUrl}/api/dev/privacy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "create",
    operation: "access",
    purpose: "tenant_privacy_administration",
    subjectId: "student_maya_demo",
    idempotencyKey: oversizedKey,
  }),
});
assert.equal(oversizedFieldResponse.status, 422);
const oversizedFieldBody = await oversizedFieldResponse.json();
assert.equal(oversizedFieldBody.code, "privacy.demo_invalid_request");
assert.doesNotMatch(JSON.stringify(oversizedFieldBody), new RegExp(oversizedKey));

console.log(
  "Privacy API smoke passed: guarded fixture snapshot, legal-hold preview, manifest verification, tombstone/audit evidence, destructive confirmation rejection, object-only JSON, bounded fields, and safe errors.",
);
