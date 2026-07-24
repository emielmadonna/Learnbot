import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl =
  process.env.INTELLIGENCE_SMOKE_BASE_URL ??
  (process.env.COURSE_AI_CONSOLE_URL
    ? `${process.env.COURSE_AI_CONSOLE_URL}/api/dev/intelligence`
    : undefined) ??
  "http://127.0.0.1:3100/api/dev/intelligence";
const requestTimeoutMs = 60_000;

function timedFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

const initial = await json(
  await timedFetch(baseUrl, {
    headers: { accept: "application/json" },
  }),
);
assert.equal(initial.response.status, 200);
assert.equal(initial.body.snapshot.health.state, "partial");
assert.equal(initial.body.snapshot.metrics.confusion.state, "known");
assert.equal(initial.body.snapshot.metrics.contentGap.state, "partial");
assert.equal(initial.body.snapshot.metrics.stall.state, "unknown");
assert.equal(initial.body.snapshot.metrics.velocity.state, "partial");
assert.equal("score" in initial.body.snapshot.opportunity, false);
assert.equal(initial.body.snapshot.opportunity.reviewMode, "human_only");
assert.equal(initial.body.snapshot.policyBoundary.scoreComputed, false);
assert.equal(initial.body.snapshot.policyBoundary.offerMatched, false);
assert.equal(initial.body.snapshot.policyBoundary.autonomousOutreach, false);
assert.deepEqual(
  initial.body.snapshot.suppressed
    .flatMap((item) => item.reasons)
    .sort(),
  [
    "analytics_consent_revoked",
    "anonymous_identity",
    "insufficient_coverage",
    "stale_evidence",
    "tenant_degraded",
  ],
);
assert.ok(
  initial.body.snapshot.opportunity.evidence.every(
    (item) => item.tenantId === initial.body.snapshot.tenantId,
  ),
);

const idempotencyKey = `intelligence-smoke-${randomUUID()}`;
const feedback = {
  action: "feedback",
  idempotencyKey,
  opportunityId: initial.body.snapshot.opportunity.id,
  kind: "helpful",
  note: "Idempotent development API smoke.",
};
const first = await json(
  await timedFetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(feedback),
  }),
);
assert.equal(first.response.status, 200);
assert.equal(
  first.body.snapshot.feedback.length,
  initial.body.snapshot.feedback.length + 1,
);
assert.equal(
  first.body.snapshot.audit.length,
  initial.body.snapshot.audit.length + 1,
);
assert.equal(first.body.snapshot.audit.at(-1).action, "feedback_recorded");
assert.equal(first.body.snapshot.audit.at(-1).actor.role, "creator");

const replay = await json(
  await timedFetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(feedback),
  }),
);
assert.equal(replay.response.status, 200);
assert.deepEqual(replay.body.snapshot, first.body.snapshot);

const conflict = await json(
  await timedFetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...feedback,
      kind: "dismissed_false_positive",
    }),
  }),
);
assert.equal(conflict.response.status, 409);
assert.equal(conflict.body.code, "intelligence.idempotency_conflict");

const attemptedOutreach = await json(
  await timedFetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "send_message",
      idempotencyKey: `outreach-${randomUUID()}`,
      opportunityId: initial.body.snapshot.opportunity.id,
    }),
  }),
);
assert.equal(attemptedOutreach.response.status, 422);
assert.equal(attemptedOutreach.body.code, "intelligence.invalid_input");

const tenantMismatchUrl = new URL(baseUrl);
tenantMismatchUrl.searchParams.set("tenantId", "tenant_foreign");
const tenantMismatch = await timedFetch(tenantMismatchUrl, {
  headers: {
    "x-course-ai-tenant-id": initial.body.snapshot.tenantId,
  },
});
assert.equal(tenantMismatch.status, 403);

console.log(
  "Intelligence development API smoke passed: tenant guard, metric uncertainty, evidence scope, suppression, human audit, idempotent feedback replay/conflict, and no outreach action.",
);
