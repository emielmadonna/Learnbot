import assert from "node:assert/strict";
import test from "node:test";
import {
  allDiagramFlagsReviewed,
  prepareKnowledgeDraft,
  reviewDiagramFlag,
} from "../src/lib/knowledge-ingestion";

test("cleaning removes deterministic page noise and flags duplicate and missing sections", () => {
  const draft = prepareKnowledgeDraft({
    sourceName: "enablement-guide.md",
    format: "markdown",
    text: [
      "\uFEFF# Enablement guide",
      "Page 1",
      "",
      "## Start here",
      "Capture the learner's first question.",
      "",
      "Page 1",
      "",
      "## Repeat",
      "Capture the learner's first question.",
      "",
      "## Practice",
      "",
    ].join("\r\n"),
  });

  assert.equal(draft.title, "Enablement guide");
  assert.match(draft.normalizedText, /Capture the learner's first question/u);
  assert.doesNotMatch(draft.normalizedText, /Page 1/u);
  assert.ok(draft.issues.some((issue) => issue.kind === "noise"));
  assert.ok(draft.issues.some((issue) => issue.kind === "duplicate_section"));
  assert.ok(draft.issues.some((issue) => issue.kind === "missing_section"));
  assert.equal(draft.processing.embeddingStatus, "not_requested");
  assert.equal(draft.processing.retrievalStatus, "not_available");
});

test("CSV input becomes a normalized table and remains deterministic", () => {
  const input = {
    sourceName: "workflow.csv",
    format: "csv" as const,
    text: 'Step,Owner,Outcome\nCapture,Coach,"A clear question"\nReview,Learner,"One next action"',
  };
  const first = prepareKnowledgeDraft(input);
  const second = prepareKnowledgeDraft(input);

  assert.equal(first.normalizedText, second.normalizedText);
  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.normalizedText, /\| Step \| Owner \| Outcome \|/u);
  assert.ok(first.diagramFlags.some((flag) => flag.kind === "table"));
});

test("diagram flags identify flows, sequences, and comparisons for explicit review", () => {
  const draft = prepareKnowledgeDraft({
    sourceName: "process.txt",
    format: "text",
    text: [
      "Decision guide",
      "",
      "Capture -> Review -> Publish",
      "",
      "1. Capture the question",
      "2. Review the evidence",
      "3. Publish the answer",
      "",
      "Compare a quick fix versus a durable habit.",
    ].join("\n"),
  });

  assert.deepEqual(
    draft.diagramFlags.map((flag) => flag.kind),
    ["flow", "sequence", "comparison"],
  );
  assert.equal(allDiagramFlagsReviewed(draft), false);
  const reviewed = draft.diagramFlags.reduce(
    (current, flag) => reviewDiagramFlag(current, flag.flagId, "accepted"),
    draft,
  );
  assert.equal(allDiagramFlagsReviewed(reviewed), true);
  assert.ok(reviewed.diagramFlags.every((flag) => flag.state === "accepted"));
});
