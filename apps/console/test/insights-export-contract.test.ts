import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const insights = readFileSync(
  new URL("../src/components/sections/insights-panel.tsx", import.meta.url),
  "utf8",
);

test("Insights exports only tenant-scoped data returned by the durable analytics loaders", () => {
  assert.match(insights, /tenantId: payload\.tenant\.tenantId/);
  assert.match(insights, /analytics: snapshot/);
  assert.match(insights, /questionIntelligence: intelligence/);
  assert.match(insights, /widget,/);
  assert.match(insights, /learnerSignals,/);
  assert.match(insights, /rangeQuery\(days\)/);
  // Both bounds are guarded before slicing. `const toolbar` — the previous end
  // marker — no longer exists in the panel, so `indexOf` returned -1 and this
  // slice silently ran from `exportData` to the end of the file instead of to
  // the end of the memo. It still passed, which is the problem: a region
  // assertion that loses a bound stops testing the region it names without
  // ever failing. `const exportAvailable` is the declaration that actually
  // follows the memo.
  const exportStart = insights.indexOf("const exportData");
  const exportEnd = insights.indexOf("const exportAvailable");
  assert.ok(exportStart > -1, "the export payload memo must exist");
  assert.ok(
    exportEnd > exportStart,
    "the export payload memo must be bounded by the availability flag",
  );
  assert.doesNotMatch(
    insights.slice(exportStart, exportEnd),
    /fixture|sampleData|mockData|Math\.random/,
  );
});

test("JSON and CSV actions stay disabled until at least one durable dataset is available", () => {
  assert.match(
    insights,
    /const exportAvailable =[\s\S]*snapshot !== null[\s\S]*intelligence !== null[\s\S]*widget !== null[\s\S]*learnerSignals !== null/,
  );
  assert.match(insights, /disabled=\{!exportAvailable\}/g);
  assert.match(insights, /Export JSON/);
  assert.match(insights, /Export CSV/);
});

test("CSV output protects spreadsheet formulas and both formats are real downloads", () => {
  assert.match(insights, /\^\[=\+\\-@\]/);
  assert.match(insights, /replaceAll\('"', '""'\)/);
  assert.match(insights, /new Blob/);
  assert.match(insights, /URL\.createObjectURL/);
  assert.match(insights, /anchor\.download/);
  assert.match(insights, /URL\.revokeObjectURL/);
});

test("partial analytics are exported honestly with per-dataset availability", () => {
  assert.match(insights, /availability:/);
  assert.match(
    insights,
    /questionIntelligence:[\s\S]*intelligenceFailure \?\? "loading"/,
  );
  assert.match(insights, /widgetFailure \?\? "loading"/);
  assert.match(insights, /learnerSignalsFailure \?\? "loading"/);
  assert.match(
    insights,
    /Downloaded \$\{format\.toUpperCase\(\)\} from the durable data currently available/,
  );
});
