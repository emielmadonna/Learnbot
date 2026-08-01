import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/sections/insights-panel.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../src/components/sections/insights-panel.module.css", import.meta.url),
  "utf8",
);

test("Results uses the Corso v2 four-metric, question-list and sidebar composition", () => {
  assert.match(source, /function V2InsightsView/);
  assert.match(source, /label="Questions asked"/);
  assert.match(source, /label="Students asking"/);
  assert.match(source, /label="Answered"/);
  assert.match(source, /label="Rated helpful"/);
  assert.match(source, /<h2>Every question<\/h2>/);
  assert.match(source, /<h2>Topics<\/h2>/);
  assert.match(source, /<h2>When they ask<\/h2>/);
  assert.match(css, /\.v2MetricGrid[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.v2InsightsGrid[\s\S]*340px/);
});

test("Results controls filter and range-query durable data instead of fixtures", () => {
  assert.match(source, /setFilter\("refused"\)/);
  assert.match(source, /setFilter\("repeated"\)/);
  assert.match(source, /setQuery\(event\.target\.value\)/);
  assert.match(source, /\{ value: "366", label: "All" \}/);
  assert.match(source, /onExport=\{\(\) => exportAnalytics\("csv"\)\}/);
  assert.match(source, /intelligence=\{intelligence\}/);
  assert.match(source, /snapshot=\{snapshot\}/);
  // Guarded before slicing: an unguarded `indexOf` that misses returns -1, and
  // the resulting slice is empty, which makes `doesNotMatch` pass vacuously.
  // Both markers exist today; these assertions make a rename fail loudly rather
  // than silently stop checking for fixture data.
  const viewStart = source.indexOf("function V2InsightsView");
  const viewEnd = source.indexOf("function V2DepthBars");
  assert.ok(viewStart > -1, "V2InsightsView must exist");
  assert.ok(viewEnd > viewStart, "V2DepthBars must follow V2InsightsView");
  assert.doesNotMatch(
    source.slice(viewStart, viewEnd),
    /mockData|sampleData|fixtureData|Math\.random/,
  );
});

test("Students is a selectable two-column live learner readout", () => {
  assert.match(source, /function V2StudentsView/);
  assert.match(source, /learnerSignals\.metrics\.learnerRows/);
  assert.match(source, /setSelectedLearnerId\(row\.subjectUserId\)/);
  assert.match(source, /row\.stuck\.clusterCount > 0/);
  assert.match(source, /row\.readiness\.tier === "likely_ready"/);
  assert.match(css, /\.v2SplitBody[\s\S]*minmax\(520px, 1fr\)[\s\S]*380px/);
});

test("Signals preserves deterministic evidence and the real review lifecycle", () => {
  assert.match(source, /function V2SignalsView/);
  assert.match(source, /signals\.metrics\.detectedSignals/);
  assert.match(source, /evidenceFacts\(selected\.evidence\)/);
  assert.match(source, /selected\.evidenceRefs/);
  assert.match(source, /onReview\(selected, action\)/);
  assert.match(source, /selected\.review\.status !== "new" \|\| action !== "actioned"/);
  assert.match(source, /href="\/app\?panel=course"/);
});

/*
 * This used to pin the hard-coded `value="Not measured"` placeholder. That
 * placeholder was the whole defect: 20260731061000 shipped
 * `learning_answer_feedback_summary` and nothing ever called it, so the card
 * reported "not recorded yet" no matter how many ratings existed. The contract
 * now pins the three statements the card must keep distinct instead.
 */
test("Rated helpful reads the durable summary and keeps its three states apart", () => {
  assert.match(source, /loadAnswerFeedback/);
  assert.match(source, /\/api\/analytics\/answer-feedback/);
  assert.match(source, /parseAnswerFeedbackSummary/);
  assert.match(source, /feedback=\{feedback\}/);
  // A failed read is "Not known"; an unrated window is "Not measured"; a real
  // score is a percentage. None of these may collapse into another.
  assert.match(source, /feedback === null\s*\?\s*"Not known"/);
  assert.match(source, /feedback\.helpfulPercent === null\s*\?\s*"Not measured"/);
  assert.match(source, /`\$\{feedback\.helpfulPercent\}%`/);
  // The score never renders without the denominator it was drawn from.
  assert.match(source, /of \$\{count\(feedback\.answerCount\)\} answers rated/);
  assert.doesNotMatch(source, /Feedback is not recorded yet/);
});

test("the not-helpful question filter still states why it cannot filter", () => {
  assert.match(source, /Not helpful —/);
  assert.match(
    source,
    /analytics_question_labels does not carry a per-question rating/,
  );
});

test("an empty Signals list repeats the reasons the RPC gave for being empty", () => {
  assert.match(source, /metric\.limitations\.map/);
});
