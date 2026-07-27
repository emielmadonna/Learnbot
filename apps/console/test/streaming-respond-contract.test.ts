import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL(
    "../src/app/api/learning/respond/route.ts",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(name: string): string {
  const start = route.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected to find function ${name}`);

  // Walk the parameter list to its matching ')' before looking for the body.
  // Taking the first '{' after the name is wrong the moment a parameter is
  // itself an object type -- `function buildStreamingResponse(params: { ... })`
  // -- because that brace opens the *type literal*, so the "body" came back as
  // the parameter type and every assertion below silently searched the wrong
  // text. That is exactly what happened here, and the tests failed with an
  // unhelpful "expected -1 to be unequal to -1" rather than naming the cause.
  let index = route.indexOf("(", start);
  let parenDepth = 0;
  for (; index < route.length; index += 1) {
    if (route[index] === "(") parenDepth += 1;
    else if (route[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }

  const bodyStart = route.indexOf("{", index);
  assert.notEqual(bodyStart, -1, `expected a body for ${name}`);
  let depth = 0;
  let cursor = bodyStart;
  for (; cursor < route.length; cursor += 1) {
    if (route[cursor] === "{") depth += 1;
    else if (route[cursor] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return route.slice(bodyStart, cursor + 1);
}

test("streaming is opt-in via Accept: text/event-stream and voice is force-excluded", () => {
  const gate = functionBody("wantsEventStream");
  assert.match(gate, /modality === "voice"\) return false/);
  assert.match(gate, /text\/event-stream/);
  assert.match(gate, /request\.headers\.get\("accept"\)/);
});

test("the POST handler only streams when wantsEventStream says so, and defaults to JSON", () => {
  assert.match(
    route,
    /const streamResponse = wantsEventStream\(request, modality\);/,
  );
  assert.match(route, /if \(streamResponse\) \{\s*return buildStreamingResponse/);
  assert.match(route, /if \(streamResponse\) \{\s*return replayStreamingResponse/);
  // The non-streaming branch still ends in NextResponse.json, unchanged.
  assert.match(route, /return NextResponse\.json\(\s*\{\s*ok: true,\s*dataMode: "durable",\s*conversationId,\s*message: \{/);
});

test("the operation token is still validated once, before any branch", () => {
  const tokenCheckIndex = route.indexOf("operationToken.length < 32");
  const streamBranchIndex = route.indexOf("const streamResponse = wantsEventStream");
  assert.notEqual(tokenCheckIndex, -1);
  assert.ok(
    tokenCheckIndex < streamBranchIndex,
    "operation token must be validated before the streaming decision, for both paths",
  );
  const streamBody = functionBody("buildStreamingResponse");
  assert.match(streamBody, /operation_token: params\.operationToken/);
});

test("sources are sent as the first SSE event, before any provider call", () => {
  const body = functionBody("buildStreamingResponse");
  const sourcesEventIndex = body.indexOf('sseBytes("sources"');
  const adapterCallIndex = body.indexOf("streamingAdapter()");
  const deltaEventIndex = body.indexOf('sseBytes("delta"');
  assert.notEqual(sourcesEventIndex, -1);
  assert.notEqual(adapterCallIndex, -1);
  assert.ok(
    sourcesEventIndex < adapterCallIndex,
    "the sources SSE event must be enqueued before the provider adapter is invoked",
  );
  assert.ok(
    sourcesEventIndex < deltaEventIndex,
    "the sources SSE event must be enqueued before any delta event",
  );
});

test("persistence of the assistant message happens inside after(), only on a successful stream", () => {
  const body = functionBody("buildStreamingResponse");
  const afterIndex = body.indexOf("after(async () => {");
  const recordCallIndex = body.indexOf("learning_record_assistant_message");
  const guardIndex = body.indexOf("if (!result.ok) return;");
  assert.notEqual(afterIndex, -1);
  assert.notEqual(recordCallIndex, -1);
  assert.ok(
    afterIndex < guardIndex && guardIndex < recordCallIndex,
    "the assistant message must be recorded inside after(), and only once the stream outcome is known to be ok",
  );
  // The RPC that persists the answer must not run in the synchronous request
  // path above the ReadableStream/after() wiring.
  const streamConstructorIndex = body.indexOf("new ReadableStream<Uint8Array>({");
  assert.ok(streamConstructorIndex < afterIndex);
});

test("a stream that fails or is cancelled mid-turn is never persisted", () => {
  const body = functionBody("buildStreamingResponse");
  assert.match(body, /terminal !== "done" \|\| trimmed === ""/);
  assert.match(body, /resolveOutcome\(\{ ok: false \}\)/);
  // cancel() — the reader disconnecting — also resolves to a non-persisted outcome.
  assert.match(body, /cancel\(\)\s*\{[\s\S]*?resolveOutcome\(\{ ok: false \}\);/);
});

test("the request's abort signal is linked into the provider stream call", () => {
  const body = functionBody("buildStreamingResponse");
  assert.match(
    body,
    /adapter\.streamChatText\(\s*context,\s*\{ model, messages \},\s*\{ signal: params\.request\.signal \}/,
  );
});

test("streaming reuses provider-router's streamChatText rather than the buffering complete()", () => {
  assert.match(route, /adapter\.streamChatText\(/);
  assert.doesNotMatch(
    functionBody("buildStreamingResponse"),
    /\.complete\(/,
  );
});

test("the non-streaming path is untouched: answerGroundedLearningQuestion still runs before persistence", () => {
  const nonStreamStart = route.indexOf("const answer = await answerGroundedLearningQuestion({");
  const nonStreamRecord = route.indexOf(
    'executeLearningRpc(\n      supabase,\n      "learning_record_assistant_message"',
  );
  assert.notEqual(nonStreamStart, -1);
  assert.notEqual(nonStreamRecord, -1);
  assert.ok(nonStreamStart < nonStreamRecord);
});
