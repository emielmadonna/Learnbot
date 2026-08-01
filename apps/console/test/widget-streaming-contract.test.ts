import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Streaming on the two customer-facing surfaces, as a source contract.
 *
 * The authenticated console conversation has streamed for a while; the widget
 * and the hosted full-page assistant did not, so a visitor watched a blank
 * panel for the whole generation and then received the answer in one lump. On
 * a grounded answer over a large course that reads as broken.
 *
 * Both surfaces share ONE backend -- `/c/[slug]/ask` forwards to
 * `/api/widget/ask` -- so there is one SSE branch and two readers. Each
 * assertion below pins one joint of that, and several pin the honesty rules the
 * feature is worth nothing without: sources before prose, a terminal `done`
 * before anything is called finished, and metering that streaming cannot slip
 * past.
 *
 * These are source assertions rather than live calls for the same reason every
 * other console suite here is: the route imports the ESM-only
 * `@course-ai/provider-router` and this suite runs under tsx's CJS loader.
 */

const askRoute = readFileSync(
  new URL("../src/app/api/widget/ask/route.ts", import.meta.url),
  "utf8",
);
const hostedForward = readFileSync(
  new URL("../src/app/c/[slug]/ask/route.ts", import.meta.url),
  "utf8",
);
const hostedAssistant = readFileSync(
  new URL("../src/app/c/[slug]/hosted-assistant.tsx", import.meta.url),
  "utf8",
);
const prelude = readFileSync(
  new URL("../src/app/widget.js/embed-prelude.ts", import.meta.url),
  "utf8",
);
const providerRuntime = readFileSync(
  new URL("../src/lib/provider-runtime.ts", import.meta.url),
  "utf8",
);
const learningProvider = readFileSync(
  new URL("../src/lib/learning-provider.ts", import.meta.url),
  "utf8",
);
const widgetEdgeFunction = readFileSync(
  new URL(
    "../../../infra/supabase/functions/learning-provider-widget-complete/index.ts",
    import.meta.url,
  ),
  "utf8",
);

/**
 * The body of a named function, found by walking its parameter list to the
 * matching `)` before looking for the body brace.
 *
 * Taking the first `{` after the name is wrong the moment a parameter is itself
 * an object type -- `function buildStreamingWidgetResponse(params: { ... })` --
 * because that brace opens the *type literal*. Copied deliberately from
 * streaming-respond-contract.test.ts, where that exact mistake made every
 * assertion silently search the parameter type instead of the code.
 */
function functionBody(source: string, name: string): string {
  // `function*` counts: `streamWithManagedWidgetProvider` is a generator, and
  // looking only for `function ` found nothing and failed with an unhelpful
  // "expected -1 to be unequal to -1".
  const plain = source.indexOf(`function ${name}(`);
  const generator = source.indexOf(`function* ${name}(`);
  const start = plain === -1 ? generator : plain;
  assert.notEqual(start, -1, `expected to find function ${name}`);
  let index = source.indexOf("(", start);
  let parenDepth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") parenDepth += 1;
    else if (source[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = source.indexOf("{", index);
  assert.notEqual(bodyStart, -1, `expected a body for ${name}`);
  let depth = 0;
  let cursor = bodyStart;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, cursor + 1);
}

// ------------------------------------------------------------------- the gate

test("streaming is opt-in via Accept, and JSON stays the default response", () => {
  const gate = functionBody(askRoute, "wantsEventStream");
  assert.match(gate, /request\.headers\.get\("accept"\)/);
  assert.match(gate, /text\/event-stream/);
  assert.match(
    askRoute,
    /if \(wantsEventStream\(request\)\) \{\s*return buildStreamingWidgetResponse\(/,
  );
  // The buffered branch still ends in the same widgetJson body it always did,
  // so an older embed, a server-to-server caller and /api/widget/config
  // consumers are untouched.
  assert.match(askRoute, /return widgetJson\(\s*\{\s*ok: true,\s*conversationRef,/);
});

test("the hosted assistant's forward passes Accept through", () => {
  // Without this, /c/[slug] would be the one customer-facing surface that
  // could not stream no matter what its own client asked for -- the forward
  // rebuilt the request from scratch and dropped every header but two.
  assert.match(hostedForward, /const accept = request\.headers\.get\("accept"\);/);
  assert.match(
    hostedForward,
    /\.\.\.\(accept === null \|\| accept\.length > 255 \? \{\} : \{ accept \}\)/,
  );
  assert.match(hostedForward, /signal: request\.signal,/);
});

// ------------------------------------------------------------- the SSE branch

test("sources are the first SSE event, before any provider call or delta", () => {
  const body = functionBody(askRoute, "buildStreamingWidgetResponse");
  const sourcesAt = body.indexOf('sseBytes("sources"');
  const providerAt = body.indexOf("streamWithManagedWidgetProvider(");
  const deltaAt = body.indexOf('sseBytes("delta"');
  assert.ok(sourcesAt > 0, "the streaming branch never emits a sources event");
  assert.ok(providerAt > 0, "the streaming branch never calls the provider");
  assert.ok(
    sourcesAt < providerAt,
    "the sources event must be enqueued before the provider is invoked",
  );
  assert.ok(
    sourcesAt < deltaAt,
    "the sources event must be enqueued before any delta event",
  );
});

test("the visual disclosure still precedes any URL reaching the client", () => {
  const body = functionBody(askRoute, "buildStreamingWidgetResponse");
  const disclosureAt = body.indexOf("await widgetRecordVisualDisclosure");
  const partsAt = body.indexOf("parts: visualParts(disclosed)");
  assert.ok(disclosureAt > 0, "the streaming branch records no disclosure");
  assert.ok(partsAt > 0, "the streaming branch emits no parts");
  assert.ok(
    disclosureAt < partsAt,
    "media URLs are streamed before the disclosure that authorises reading them",
  );
  // A failed disclosure degrades to a text answer, never to broken images.
  assert.ok(body.includes("disclosed = []"));
});

test("the no-source refusal streams the tenant's resolved directive", () => {
  const body = functionBody(askRoute, "buildStreamingWidgetResponse");
  // The bug this forecloses: a module constant here would mean a creator can
  // set a refusal message, see it work in Preview, and never have it reach a
  // visitor. The same mistake was already made and fixed on the authenticated
  // path.
  assert.match(body, /const streamDirective = resolveAgentDirective\(params\.directive\)/);
  assert.match(body, /text = streamDirective\.noResultsMessage;/);
  assert.match(body, /model: streamDirective\.model,/);
  const refusalAt = body.indexOf("streamDirective.noResultsMessage");
  const deltaAt = body.indexOf('sseBytes("delta", { text })');
  assert.ok(
    refusalAt > 0 && deltaAt > refusalAt,
    "the refusal must be streamed as a delta, not returned whole",
  );
});

test("a stream that never terminates in done is not recorded and not presented", () => {
  const body = functionBody(askRoute, "buildStreamingWidgetResponse");
  assert.match(body, /terminal !== "done" \|\| trimmed === ""/);
  assert.match(body, /resolveOutcome\(\{ ok: false \}\)/);
  // The reader disconnecting resolves to a non-persisted outcome too.
  assert.match(body, /cancel\(\)\s*\{[\s\S]*?resolveOutcome\(\{ ok: false \}\);/);
  // ...and the failure branch enqueues an error rather than a done.
  const failureAt = body.indexOf('terminal !== "done"');
  const errorAt = body.indexOf('sseBytes(\n              "error"');
  assert.ok(errorAt > failureAt);
});

test("the answer is recorded before done, so a streamed turn stays ratable", () => {
  const body = functionBody(askRoute, "buildStreamingWidgetResponse");
  const recordAt = body.indexOf("widgetRecordAnswer(supabase");
  const doneAt = body.indexOf('sseBytes("done"');
  assert.ok(recordAt > 0 && doneAt > recordAt);
  // The durable id is the only one widget_record_answer_feedback accepts, and
  // it is omitted entirely when the database returned none -- no rating
  // control beats one that is refused on every click.
  assert.match(body, /\.\.\.\(messageId === null \? \{\} : \{ messageId \}\)/);
  // A dropped write still lets the visitor keep the answer they watched
  // arrive; it is logged, not surfaced, and offers no id to rate.
  assert.match(body, /\[widget-stream-persist\] the recorded turn was dropped/);
});

test("classification still runs in after(), and only for a settled stream", () => {
  const body = functionBody(askRoute, "buildStreamingWidgetResponse");
  const afterAt = body.indexOf("after(async () => {");
  const guardAt = body.indexOf("if (!settled.ok) return;");
  const labelAt = body.indexOf("labelWidgetQuestion(supabase");
  assert.ok(afterAt > 0 && guardAt > afterAt && labelAt > guardAt);
  // Never a fallback label: a fault writes nothing, exactly as on the
  // buffered path.
  assert.doesNotMatch(
    body,
    /topicKey: "|intent: "other"|importance: "routine"/,
  );
});

test("streamed and buffered answers are grounded by the same prompt", () => {
  // Two copies of the system prompt would mean the same question on the same
  // tenant is answered differently depending on the visitor's Accept header.
  assert.match(learningProvider, /export function groundedAnswerRequest\(/);
  assert.match(
    functionBody(learningProvider, "answerGroundedLearningQuestion"),
    /const request = groundedAnswerRequest\(\{/,
  );
  assert.match(
    functionBody(askRoute, "buildStreamingWidgetResponse"),
    /request: groundedAnswerRequest\(\{/,
  );
});

// ---------------------------------------------------------------- metering

test("streaming cannot bypass the metered provider boundary", () => {
  // The Edge Function is the only place the widget surface's tenant id exists,
  // so it is the only place the reservation and the ledger write can happen.
  // Streaming from the console directly would have made every streamed widget
  // answer unmetered.
  assert.match(
    functionBody(providerRuntime, "streamWithManagedWidgetProvider"),
    /functions\.invoke\(\s*"learning-provider-widget-complete"/,
  );
  assert.doesNotMatch(
    functionBody(askRoute, "buildStreamingWidgetResponse"),
    /sharedResponsesAdapter\(|streamChatText\(|api\.openai\.com/,
  );
});

test("the edge function reserves before the stream and writes the ledger after it", () => {
  const reserveAt = widgetEdgeFunction.indexOf(
    'service.rpc("learning_reserve_provider_call"',
  );
  const streamBranchAt = widgetEdgeFunction.indexOf("if (wantsStream) {");
  assert.ok(reserveAt > 0 && streamBranchAt > reserveAt, "the reservation must precede the stream");
  // Both branches write the ledger through one helper, so neither can drift
  // into being unmetered.
  assert.equal(
    widgetEdgeFunction.split("await recordWidgetCost(").length - 1,
    2,
    "expected exactly one ledger write per branch, through the shared helper",
  );
  assert.match(
    widgetEdgeFunction,
    /learning_record_provider_cost/,
  );
  // Streamed usage is read off the terminal completed event -- the same
  // `usage` object the buffered branch reads off the JSON body.
  assert.match(widgetEdgeFunction, /usage: completed\.usage \?\? null,/);
  // A stream that failed sends an error, never a done, so the console records
  // nothing for it.
  assert.match(
    widgetEdgeFunction,
    /if \(failed \|\| completed === null \|\| text\.trim\(\)\.length === 0\) \{/,
  );
});

test("the edge function only streams when asked, and refuses in JSON", () => {
  assert.match(widgetEdgeFunction, /const wantsStream = input\.stream === true;/);
  assert.match(
    widgetEdgeFunction,
    /accept: wantsStream \? "text\/event-stream" : "application\/json",/,
  );
  assert.match(widgetEdgeFunction, /\.\.\.\(wantsStream \? \{ stream: true \} : \{\}\)/);
  // A pre-flight refusal still has the named JSON shape the console knows, and
  // it is reached before the stream branch.
  assert.ok(
    widgetEdgeFunction.indexOf("provider_authentication_failed") <
      widgetEdgeFunction.indexOf("if (wantsStream) {"),
  );
});

test("a console talking to an un-streamed edge function still answers", () => {
  // Edge functions on this project are deployed by hand, so the deployed
  // function may predate the change. It ignores the unknown `stream` field and
  // returns JSON; that whole answer is yielded as one delta rather than failing
  // the turn, so the visitor still gets sources first and an answer after.
  const body = functionBody(providerRuntime, "streamWithManagedWidgetProvider");
  assert.match(body, /invoked\.data instanceof Response/);
  assert.match(body, /text\/event-stream/);
  assert.match(body, /if \(streamed === null\) \{/);
  assert.match(body, /yield \{ type: "delta", text: payload\.text\.trim\(\) \};/);
});

// ----------------------------------------------------------------- the readers

test("the embed adapter reads the stream and only done means complete", () => {
  assert.match(prelude, /accept: "text\/event-stream, application\/json",/);
  assert.match(prelude, /function readEventStream\(response, handlers\)/);
  // Frames are separated by a blank line; a partial frame waits rather than
  // being parsed as truncated JSON.
  assert.match(prelude, /var boundary = buffer\.indexOf\("\\n\\n"\);/);
  assert.match(prelude, /finished = true;\s*\n\s*handlers\.onDone\(payload\);/);
  assert.match(prelude, /if \(!complete\) \{/);
  // Deltas append through the runtime's own streaming event, which already
  // merges into the open turn (packages/widget-runtime `#receiveEvent`).
  assert.match(prelude, /type: "response\.delta",/);
  assert.match(prelude, /status: "streaming",/);
  // The terminal update carries no parts, so the streamed text is not
  // discarded by the runtime's upsert.
  assert.match(prelude, /parts: \[\],\s*\n\s*status: "complete",/);
});

test("the embed adapter still rates only a server-minted id when streaming", () => {
  assert.match(
    prelude,
    /typeof payload\.messageId === "string" &&\s*\n\s*uuidPattern\.test\(payload\.messageId\)/,
  );
  assert.match(prelude, /if \(feedbackRef\) settled\.feedbackRef = feedbackRef;/);
});

test("the hosted assistant reads the stream and keeps its JSON fallback", () => {
  assert.match(hostedAssistant, /accept: "text\/event-stream, application\/json",/);
  assert.match(hostedAssistant, /async function readEventStream\(/);
  assert.match(hostedAssistant, /const streamed =\s*\n\s*response\.ok &&/);
  // Citations and grounded visuals resolve from the sources event, before the
  // first token.
  assert.match(hostedAssistant, /sources: parseSources\(payload\.sources\),/);
  assert.match(
    hostedAssistant,
    /visuals: parseVisuals\(payload\.parts, window\.location\.origin\),/,
  );
  // The buffered path is untouched, so a JSON response still renders.
  assert.match(hostedAssistant, /parseVisuals\(\s*payload\.message\.parts/);
});

test("the hosted assistant never presents a truncated stream as finished", () => {
  assert.match(hostedAssistant, /if \(!completed\) \{/);
  assert.match(hostedAssistant, /The answer stopped before it finished\./);
  // The thinking row gives way to the answer the moment content starts
  // arriving, instead of sitting under a bubble that is already filling.
  assert.match(hostedAssistant, /\{isSending && streamingId === null \? \(/);
});

test("the collapsed sources disclosure on the hosted page is preserved", () => {
  // A regression here would push every answer's citations between the reader
  // and the next reply, which is what the `<details>` change fixed.
  assert.match(hostedAssistant, /<details\s*\n\s*aria-label="Sources"/);
  assert.doesNotMatch(hostedAssistant, /<details\s+open/);
});
