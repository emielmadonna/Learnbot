import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const coursePanel = readFileSync(
  new URL("../src/components/sections/course-panel.tsx", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731034750_durable_ingestion_publish_controls.sql",
    import.meta.url,
  ),
  "utf8",
);
const extractRoute = readFileSync(
  new URL("../src/app/api/ingestion/extract/route.ts", import.meta.url),
  "utf8",
);

test("Knowledge exposes the prototype's live assistant test control", () => {
  assert.match(coursePanel, /Test what it knows/u);
  assert.match(coursePanel, /onTest=\{\(\) => openPanel\("agent"\)\}/u);
});

test("Knowledge counts active imported projections as ready and searchable", () => {
  assert.match(coursePanel, /courseIsReady\(course\)/u);
  assert.match(coursePanel, /Ready from the active imported source/u);
  assert.match(coursePanel, /label="Searchable chunks"/u);
  assert.match(coursePanel, /sum \+ course\.chunkCount/u);
});

test("Cleanup reconstructs approved publish controls after a reload", () => {
  for (const field of [
    "'courseId'",
    "'latestRevisionStatus'",
    "'publishedToActiveKnowledge'",
  ]) {
    assert.ok(migration.includes(field), `missing durable field ${field}`);
  }
  assert.match(
    migration,
    /left join lateral \([\s\S]*from public\.ingestion_cleaning_revisions/u,
  );
  assert.match(
    migration,
    /document\.knowledge_version_id = course\.active_knowledge_version_id/u,
  );
  assert.match(coursePanel, /durableApprovedCourseIds/u);
  assert.match(coursePanel, /!item\.publishedToActiveKnowledge/u);
});

test("Cleanup does not re-run extraction for reviewed or terminal jobs", () => {
  assert.match(coursePanel, /terminalIngestionStates/u);
  assert.match(coursePanel, /reviewedRevisionStates/u);
  assert.match(coursePanel, /reviewReadyJobIds/u);
});

test("upload publication handles authored-knowledge activation honestly", () => {
  assert.match(coursePanel, /replaceAuthoredKnowledge/u);
  assert.match(
    coursePanel,
    /Replace the active authored knowledge version/u,
  );
  assert.match(
    coursePanel,
    /knowledge\?\.activated === false \|\| knowledge\?\.retrievable === false/u,
  );
  assert.match(
    coursePanel,
    /published as an inactive version/u,
  );
});

test("Cleanup clears security before extracting supported uploads", () => {
  assert.match(
    coursePanel,
    /postIngestion\(`?\/api\/ingestion\/scan`?, \{ jobId \}\)/u,
  );
  assert.match(coursePanel, /Scan, extract &amp; clean/u);
  assert.match(extractRoute, /"application\/pdf"/u);
  assert.match(
    extractRoute,
    /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/u,
  );
  assert.match(extractRoute, /extractUploadedDocument/u);
});
