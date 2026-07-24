import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../src/app/dev/learning/page.tsx", import.meta.url),
  "utf8",
);
const styleSource = readFileSync(
  new URL("../src/app/dev/learning/page.module.css", import.meta.url),
  "utf8",
);

test("learning readiness distinguishes server evidence from local review state", () => {
  assert.match(
    pageSource,
    /pipelineQuality\?\.chunkQuality\.state === "known"/,
  );
  assert.match(
    pageSource,
    /pipelineQuality\?\.retrievalReadiness\.state === "known"/,
  );
  assert.match(
    pageSource,
    /pipelineQuality\?\.objectiveAlignment\.state === "known"/,
  );
  assert.match(pageSource, /Evidence review · local fixture/);
  assert.match(pageSource, /review-mapped/);
  assert.match(pageSource, /Fixture boundary/);
  assert.match(
    pageSource,
    /not live learner outcomes or production vector evaluation/,
  );
  assert.match(
    pageSource,
    /does not claim semantic similarity, embedding quality or production retrieval readiness/,
  );
});

test("learning editor keyboard workflows prevent browser defaults", () => {
  assert.match(
    pageSource,
    /event\.key\.toLocaleLowerCase\(\) === "s"[\s\S]*event\.preventDefault\(\);[\s\S]*void saveDraft\(\)/,
  );
  assert.match(
    pageSource,
    /event\.key === "Enter"[\s\S]*event\.preventDefault\(\);[\s\S]*void previewValidation\(\)/,
  );
});

test("learning review remains usable on narrow screens and reduced motion", () => {
  assert.match(
    styleSource,
    /@media \(max-width: 760px\)[\s\S]*\.readinessChecks, \.learningColumns, \.chunkMeta \{ grid-template-columns: 1fr; \}/,
  );
  assert.match(
    styleSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.pulse, \.spinner \{ animation: none; \}/,
  );
});
