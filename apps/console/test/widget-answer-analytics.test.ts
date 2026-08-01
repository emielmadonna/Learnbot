import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseWidgetAnswerRecord,
  WidgetRpcError,
} from "../src/lib/supabase/widget-rpc";

/**
 * The two widget-side analytics paths, as a contract.
 *
 * Both were built at one end only. Question intelligence had a classifier, a
 * label table and a readout, and the widget route never called any of them —
 * which is why one tenant's numbers split 4-asked/4-labelled on the
 * authenticated path and 12-asked/0-labelled on the widget path, with no
 * failure code anywhere to explain the zero. Answer ratings had a table, an
 * anonymous RPC and a route, and nothing in `packages/widget-runtime` ever
 * called them, because nothing told the page which message id to name.
 *
 * Each assertion below pins one joint, and several pin the honesty rules the
 * two features are worth nothing without: a fault writes no label rather than
 * an approximate one, and a rating control is not rendered unless the id it
 * would post is one the server accepts.
 */

const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731080000_widget_question_labels_and_ratable_answers.sql",
    import.meta.url,
  ),
  "utf8",
);
const askRoute = readFileSync(
  new URL("../src/app/api/widget/ask/route.ts", import.meta.url),
  "utf8",
);
const feedbackRoute = readFileSync(
  new URL("../src/app/api/widget/feedback/route.ts", import.meta.url),
  "utf8",
);
const prelude = readFileSync(
  new URL("../src/app/widget.js/embed-prelude.ts", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../../../packages/widget-runtime/src/index.ts", import.meta.url),
  "utf8",
);

// ------------------------------------------------------------------ labelling

test("the widget label RPC is authorised by a server token, not by a session", () => {
  const start = migration.indexOf(
    "create or replace function public.widget_record_question_label(",
  );
  assert.ok(start > 0, "the widget labelling RPC is missing");
  const body = migration.slice(start, migration.indexOf("$$;", start));
  // The reason a call could not simply be added to the existing route: the
  // authenticated function opens with learning_rpc_context(), which needs a
  // Supabase session the anonymous widget client does not have.
  assert.doesNotMatch(body, /learning_rpc_context/);
  assert.match(
    body,
    /learning_operation_token_is_valid\(\s*'conversation\.answer\.record'/,
  );
  assert.match(body, /app_private\.widget_resolve\(widget_key, origin\)/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = pg_catalog/);
});

test("the labelled question is re-derived, so no message UUID crosses the widget boundary", () => {
  assert.match(
    migration,
    /'widget-user:' \|\| conversation_hash \|\| ':' \|\| question_idempotency_key/,
  );
  // widget_ask wrote the question under exactly that key (20260726093000).
  assert.match(askRoute, /questionIdempotencyKey: `widget-turn:\$\{turnId\}`/);
  assert.match(askRoute, /idempotencyKey: `widget-turn:\$\{turnId\}`/);
});

test("grounding is read from the recorded answer, never asserted by the caller", () => {
  // The caller supplies topic, intent and importance and nothing else; the
  // database resolves grounding itself, exactly as on the authenticated side.
  assert.match(migration, /when not answer_found then 'no_answer'/);
  assert.match(migration, /jsonb_array_length\(answer_sources\) = 0 then 'ungrounded'/);
  assert.doesNotMatch(
    askRoute,
    /grounding_outcome|groundingOutcome:/,
    "the route must not tell the database whether an answer was grounded",
  );
});

test("the label RPC is granted to anon only, never to a signed-in session", () => {
  assert.match(
    migration,
    /revoke execute on function public\.widget_record_question_label\([\s\S]*?\) from public, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.widget_record_question_label\([\s\S]*?\) to anon;/,
  );
});

test("classification is scheduled after the answer, so it can never delay the turn", () => {
  const scheduled = askRoute.indexOf("after(async () => {");
  const recorded = askRoute.indexOf("widgetRecordAnswer(supabase");
  assert.ok(recorded > 0 && scheduled > recorded);
  assert.match(askRoute, /labelWidgetQuestion\(supabase, \{/);
});

test("every classification fault names a reason and writes no label", () => {
  // Two logs, one for a declined classification and one for a database
  // refusal. Neither writes anything, and neither guesses a topic.
  assert.match(
    askRoute,
    /\[widget-question-classifier\] no label recorded: reason=\$\{outcome\.reason\}/,
  );
  assert.match(
    askRoute,
    /\[widget-question-classifier\] label rejected by the database: /,
  );
  assert.doesNotMatch(
    askRoute,
    /topicKey: "|intent: "other"|importance: "routine"/,
    "a fallback label would defeat the whole point of the reason codes",
  );
});

/*
 * The classifier's own failure behaviour is asserted against its source rather
 * than by calling it: `question-classification.ts` imports the provider
 * runtime, which imports the ESM-only `@course-ai/provider-router`, and this
 * suite runs under tsx's CJS loader. Every other console test in this
 * directory is a source contract for the same reason.
 */
const classifier = readFileSync(
  new URL("../src/lib/question-classification.ts", import.meta.url),
  "utf8",
);

test("the completion seam does not weaken any refusal the classifier already made", () => {
  // The seam is an alternative provider, not an alternative to validation:
  // every `declined(...)` below it still stands, and each one writes no label.
  for (const reason of [
    "provider_threw",
    "provider_refused",
    "non_text_content",
    "unparseable_output",
    "off_taxonomy",
  ]) {
    assert.ok(
      classifier.includes(`declined(\n      "${reason}"`) ||
        classifier.includes(`declined("${reason}"`),
      `${reason} is no longer reachable`,
    );
  }
  assert.match(
    classifier,
    /outcome = input\.completion\s*\n?\s*\? await input\.completion\(context, request\)/,
  );
  // A caller with no adapter, no client and no seam is still told so.
  assert.match(
    classifier,
    /if \(adapter === null && !input\.supabase && !input\.completion\) \{\s*\n\s*return declined\("no_provider_configured"\);/,
  );
});

test("the widget classifier goes through the widget provider boundary, not the metered path", () => {
  // `runMeteredCompletion` reserves budget through session-scoped RPCs, which
  // an anonymous client cannot call. The Edge Function is the only provider
  // route this surface has.
  assert.match(askRoute, /completion: \(context, providerRequest\) =>\s*\n\s*completeWithManagedWidgetProvider\(\{/);
  assert.doesNotMatch(askRoute, /runMeteredCompletion\(/);
});

// -------------------------------------------------------------------- ratings

test("the recorded answer now returns the id the feedback RPC accepts", () => {
  assert.match(migration, /'messageId', recorded\.message_id/);
  // Which is exactly the argument /api/widget/feedback validates as a UUID.
  assert.match(feedbackRoute, /target_message_id: messageId/);
  assert.match(feedbackRoute, /UUID\.test\(messageId\)/);
});

test("a non-UUID message id becomes null rather than reaching the page", () => {
  const base = {
    ok: true,
    dataMode: "durable",
    conversationRef: "c".repeat(40),
    sequence: 1,
  };
  const real = "3f1c2b7e-9a4d-4c1b-8f2e-77aa2c9b1d40";
  assert.equal(
    parseWidgetAnswerRecord({ ...base, messageId: real }).messageId,
    real,
  );
  // A pre-migration database returns no messageId at all. That is a widget
  // with no rating control, not a widget with a broken one.
  assert.equal(parseWidgetAnswerRecord(base).messageId, null);
  assert.equal(
    parseWidgetAnswerRecord({ ...base, messageId: "w7kq2z" }).messageId,
    null,
  );
  assert.throws(
    () => parseWidgetAnswerRecord({ ok: false, code: "access_denied" }),
    WidgetRpcError,
  );
});

test("the ask response omits the id entirely when the server has none", () => {
  assert.match(
    askRoute,
    /\.\.\.\(answerRecord\.messageId === null\s*\?\s*\{\}\s*:\s*\{ id: answerRecord\.messageId \}\)/,
  );
});

test("the widget rates the server's id, never the adapter's own item id", () => {
  // The console's equivalent bug: a control keyed on a client-minted
  // placeholder the API rejected, so every click 400'd.
  assert.match(prelude, /var feedbackRef =\s*\n\s*typeof message\.id === "string" && uuidPattern\.test\(message\.id\)/);
  assert.match(prelude, /if \(feedbackRef\) item\.feedbackRef = feedbackRef;/);
  assert.match(prelude, /messageId: input\.feedbackRef,/);
  // The local id stays a local id.
  assert.match(prelude, /return "w" \+ Math\.random\(\)/);
  assert.doesNotMatch(prelude, /messageId: id,|feedbackRef: id\b/);
});

test("a rejected rating rejects, so the visitor is never told it saved", () => {
  assert.match(prelude, /if \(!response\.ok\) throw new Error\("feedback_rejected"\)/);
  assert.match(prelude, /payload\.ok !== true\) \{\s*\n\s*throw new Error\("feedback_rejected"\)/);
});

test("the runtime withholds the control until the server offers an id", () => {
  assert.match(
    runtime,
    /if \(!item\.feedbackRef \|\| !this\.#config\?\.adapter\.rateAnswer\) return null;/,
  );
  assert.match(runtime, /if \(item\.role !== "assistant"\) return null;/);
});
