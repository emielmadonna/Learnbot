import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseAnswerFeedbackSummary,
  requireFeedbackWindowDays,
} from "../src/lib/supabase/answer-feedback-rpc";
import { AnalyticsRpcError } from "../src/lib/supabase/analytics-rpc";

/**
 * "Rated helpful" reported "Not measured / NOT TRACKED / Feedback is not
 * recorded yet" while `public.learning_answer_feedback_summary` sat unread
 * since 20260731061000. These tests pin the reader that closes that gap, and
 * in particular the one rule the migration's header insists on: an unmeasured
 * percentage is null, never a zero that reads as a measurement.
 */

const ok = {
  ok: true,
  dataMode: "durable",
  answerCount: 40,
  ratedCount: 12,
  helpfulCount: 9,
  helpfulPercent: 75,
  ratedPercent: 30,
  windowDays: 30,
};

test("a real summary keeps the score and the response rate together", () => {
  const summary = parseAnswerFeedbackSummary(ok);
  assert.equal(summary.helpfulPercent, 75);
  assert.equal(summary.ratedPercent, 30);
  assert.equal(summary.ratedCount, 12);
  assert.equal(summary.answerCount, 40);
});

test("nothing rated yields a null percentage, never a zero", () => {
  const summary = parseAnswerFeedbackSummary({
    ...ok,
    ratedCount: 0,
    helpfulCount: 0,
    helpfulPercent: null,
    ratedPercent: 0,
  });
  assert.equal(summary.helpfulPercent, null);
  assert.equal(summary.ratedCount, 0);
});

test("a percentage without a denominator is rejected rather than rendered", () => {
  assert.throws(
    () =>
      parseAnswerFeedbackSummary({
        ...ok,
        ratedCount: 0,
        helpfulCount: 0,
        helpfulPercent: 0,
      }),
    AnalyticsRpcError,
  );
});

test("more ratings than answers is a contradiction, not a number to print", () => {
  assert.throws(
    () => parseAnswerFeedbackSummary({ ...ok, ratedCount: 41 }),
    AnalyticsRpcError,
  );
});

test("an RPC refusal surfaces its own code", () => {
  assert.throws(
    () =>
      parseAnswerFeedbackSummary({
        ok: false,
        code: "tenant_selection_required",
      }),
    (error: unknown) =>
      error instanceof AnalyticsRpcError &&
      error.code === "tenant_selection_required",
  );
});

test("the window is bounded by the same 1..366 the RPC enforces", () => {
  assert.equal(requireFeedbackWindowDays("30"), 30);
  assert.equal(requireFeedbackWindowDays(366), 366);
  for (const bad of ["0", "367", "30.5", "", "abc", null]) {
    assert.throws(() => requireFeedbackWindowDays(bad), AnalyticsRpcError);
  }
});

/*
 * The write half. The console's "Did that help?" control posts a message id to
 * /api/learning/feedback, and that route requires a real UUID — the id of a
 * durably recorded assistant message.
 *
 * On the streaming answer path the client never has one. The assistant message
 * is persisted inside `after()`, strictly after the response has been sent
 * (a deliberate contract, pinned by streaming-respond-contract.test.ts), so no
 * SSE event can carry the id it does not yet have. These assertions record
 * that gap so it cannot be closed by accident and left untested.
 */
const respond = readFileSync(
  new URL("../src/app/api/learning/respond/route.ts", import.meta.url),
  "utf8",
);

test("no SSE done event carries a message id, so a streamed answer has none to rate", () => {
  const doneEvents = respond.match(/sseBytes\("done", \{[\s\S]*?\n {8}\}\)/g);
  assert.ok(doneEvents !== null && doneEvents.length >= 2);
  for (const event of doneEvents) {
    assert.doesNotMatch(
      event,
      /messageId/,
      "if a done event starts carrying a message id, the streaming feedback " +
        "gap is closable and this test should be replaced by one that pins " +
        "the client reading it",
    );
  }
});

test("the non-streaming path returns the durable message id, so voice turns are ratable", () => {
  assert.match(respond, /messageId: recorded\.messageId/);
});

/**
 * The write path: a streamed answer starts life with a client-minted
 * `assistant-<uuid>` placeholder, which /api/learning/feedback rejects. The
 * control used to render anyway and 400 on every click. These pin the two
 * halves of the fix.
 */
const conversationClient = readFileSync(
  new URL("../src/app/app/conversation/conversation-client.tsx", import.meta.url),
  "utf8",
);

test("the rating control is withheld until the message has a persisted id", () => {
  assert.match(
    conversationClient,
    /PERSISTED_MESSAGE_ID\.test\(message\.messageId\) \? \(\s*<AnswerFeedback/,
  );
  // The placeholder must stay non-UUID: it is what the gate keys on.
  assert.match(conversationClient, /`assistant-\$\{crypto\.randomUUID\(\)\}`/);
});

test("the persisted id is adopted by CONTENT, never by recency", () => {
  // `after()` may not have run, in which case the newest assistant row is the
  // PREVIOUS turn. Adopting it would attach this rating to an older answer —
  // a wrong write, worse than no write.
  assert.match(
    conversationClient,
    /message\.content\.trim\(\) === target/,
  );
  assert.match(conversationClient, /reconcilePersistedMessageId/);
});

/**
 * SMIL is not reachable from CSS, so the stylesheet's reduced-motion block
 * cannot stop the orb's vapour. These pin the JS gate that can.
 */
test("the orb's SVG animation is gated on prefers-reduced-motion", () => {
  assert.match(conversationClient, /function usePrefersReducedMotion/);
  assert.match(conversationClient, /\(prefers-reduced-motion: reduce\)/);
  // Every <animate> must sit behind the gate; an ungated one keeps running.
  // Comments are stripped first: the doc comment on the hook mentions
  // "<animate>" in prose, and counting that made this assertion report a gap
  // that did not exist.
  const code = conversationClient.replace(/\/\*[\s\S]*?\*\//g, "");
  const animates = code.match(/<animate\b/g) ?? [];
  const gated = code.match(/\{reducedMotion \? null : \(\s*<animate\b/g) ?? [];
  assert.equal(
    animates.length,
    gated.length,
    "every <animate> must be gated on reducedMotion",
  );
  // Defaulting to reduced is the safe direction: no burst of motion at anyone
  // who asked for none.
  assert.match(conversationClient, /useState\(true\);\s*\n\s*useEffect/);
});

/**
 * The streaming path is the default for every text turn, and it used to
 * hardcode both the refusal and the model — so a creator could configure them,
 * watch them work in Preview (non-streaming), and never have either reach a
 * learner.
 */
const respondRoute = readFileSync(
  new URL("../src/app/api/learning/respond/route.ts", import.meta.url),
  "utf8",
);

test("the streamed answer honours the tenant's directive, not platform defaults", () => {
  // The directive must reach the streaming function at all.
  assert.match(respondRoute, /agentDirective: unknown;/);
  assert.match(respondRoute, /agentDirective: directive,/);
  assert.match(
    respondRoute,
    /const streamDirective = resolveAgentDirective\(params\.agentDirective\)/,
  );

  // Refusal copy comes from the tenant, and the same text is streamed and
  // recorded — a `done` carrying different words than the `delta` would make
  // the transcript disagree with what was read.
  assert.match(respondRoute, /const refusal = streamDirective\.noResultsMessage/);
  assert.match(respondRoute, /sseBytes\("delta", \{ text: refusal \}\)/);
  assert.match(respondRoute, /text: refusal,/);

  // Model comes from the directive, which has already fallen back for anything
  // absent or unpriced — never straight from the env var here.
  assert.match(respondRoute, /const model = streamDirective\.model;/);
  assert.doesNotMatch(
    respondRoute,
    /const model =\s*\n?\s*process\.env\.LEARNINGBOT_LLM_MODEL/,
  );

  // The hardcoded refusal is gone, not merely bypassed.
  assert.doesNotMatch(respondRoute, /NO_SOURCES_ANSWER/);
});
