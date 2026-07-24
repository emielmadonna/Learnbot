import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  agentAssistedStarter,
  prepareKnowledgeDraft,
} from "../src/lib/knowledge-ingestion";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const sourceTypes = source("../src/lib/knowledge-ingestion/types.ts");
const workbench = source("../src/app/app/learning/knowledge-workbench.tsx");
const prepareRoute = source("../src/app/api/learning/knowledge/prepare/route.ts");

test("agent-assisted intake is deterministic, reviewable, and provider-free", () => {
  const starter = agentAssistedStarter("coach feedback conversations");
  const draft = prepareKnowledgeDraft({
    sourceName: "agent-assisted-starter.md",
    format: "markdown",
    text: starter,
  });

  assert.match(starter, /^# Coach feedback conversations/m);
  assert.match(starter, /trusted source material/iu);
  assert.ok(draft.sections.length >= 3);
  assert.equal(draft.processing.cleanedLocally, true);
  assert.equal(draft.processing.embeddingStatus, "not_requested");
  assert.equal(draft.processing.retrievalStatus, "not_available");
});

test("YouTube URL intake is an explicit blocker, not a false ingestion success", () => {
  assert.match(sourceTypes, /KnowledgeSourceFormat = "text" \| "markdown" \| "csv"/u);
  assert.doesNotMatch(sourceTypes, /youtube/iu);
  assert.match(workbench, /\.txt,.md,.markdown,.csv/iu);
  assert.doesNotMatch(workbench, /youtube/iu);
  assert.match(prepareRoute, /requested_lesson_content/iu);
  assert.doesNotMatch(prepareRoute, /fetch\s*\(/u);
});
