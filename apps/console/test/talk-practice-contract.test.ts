import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(
  new URL("../src/components/sections/agent-panel.tsx", import.meta.url),
  "utf8",
);
const conversation = readFileSync(
  new URL(
    "../src/app/app/conversation/conversation-client.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Talk practice loads only durable privacy-reviewed learner questions", () => {
  assert.match(panel, /\/api\/analytics\/question-intelligence/u);
  assert.match(panel, /payload\.ok !== true/u);
  assert.match(panel, /importantQuestions/u);
  assert.doesNotMatch(
    panel,
    /Do you have a rate increase template\?|Is a retainer just a discount\?/u,
  );
});

test("a recorded question is passed into the real conversation composer", () => {
  assert.match(panel, /suggestedQuestion=\{suggestedQuestion\}/u);
  assert.match(conversation, /suggestedQuestion\?: \{ id: string; text: string \}/u);
  assert.match(conversation, /setDraft\(suggestedQuestion\.text\)/u);
  assert.match(conversation, /textareaRef\.current\?\.focus\(\)/u);
});
