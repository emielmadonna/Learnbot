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
  assert.doesNotMatch(
    source.slice(
      source.indexOf("function V2InsightsView"),
      source.indexOf("function V2DepthBars"),
    ),
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

test("uninstrumented feedback remains visibly unavailable", () => {
  assert.match(source, /value="Not measured"/);
  assert.match(source, /Feedback is not recorded yet/);
  assert.match(source, /Not helpful —/);
  assert.match(source, /Helpful\/not-helpful feedback has not been instrumented/);
});
