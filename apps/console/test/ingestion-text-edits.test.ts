import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStep,
  buildDiff,
  dedupeOverlapping,
  identityOffsetMap,
  mapToRaw,
} from "../src/lib/ingestion/text-edits";
import type { TextEdit } from "../src/lib/ingestion/types";

test("mapToRaw resolves offsets inside an untouched segment by adding the delta", () => {
  const breakpoints = [
    { at: 0, rawAt: 0 },
    { at: 10, rawAt: 15 },
  ];
  assert.equal(mapToRaw(breakpoints, 0), 0);
  assert.equal(mapToRaw(breakpoints, 5), 5);
  assert.equal(mapToRaw(breakpoints, 12), 17);
});

test("dedupeOverlapping keeps the earliest-starting edit on a collision", () => {
  const edits: TextEdit[] = [
    { start: 5, end: 10, replacement: "", reason: "a" },
    { start: 7, end: 12, replacement: "", reason: "b" },
    { start: 20, end: 22, replacement: "", reason: "c" },
  ];
  assert.deepEqual(dedupeOverlapping(edits), [
    { start: 5, end: 10, replacement: "", reason: "a" },
    { start: 20, end: 22, replacement: "", reason: "c" },
  ]);
});

test("applyStep deletes a span and the offset map still points at the raw text", () => {
  const raw = "So, um, we started the lesson.";
  const step1 = applyStep(
    raw,
    identityOffsetMap(),
    [{ start: 4, end: 8, replacement: "", reason: "filler" }],
    raw,
  );
  assert.equal(step1.text, "So, we started the lesson.");
  assert.equal(step1.removals.length, 1);
  assert.equal(step1.removals[0]!.originalText, "um, ");
  assert.equal(step1.removals[0]!.rawStart, 4);
  assert.equal(step1.removals[0]!.rawEnd, 8);

  // Position of "we" in the cleaned text must still map back to its real
  // location in the raw text.
  const weInCleaned = step1.text.indexOf("we");
  assert.equal(mapToRaw(step1.breakpoints, weInCleaned), raw.indexOf("we started"));
});

test("applyStep composes correctly across two sequential steps", () => {
  const raw = "The the cat, um, sat on the mat.";
  const afterStutter = applyStep(
    raw,
    identityOffsetMap(),
    [{ start: 0, end: 8, replacement: "The ", reason: "stutter" }],
    raw,
  );
  assert.equal(afterStutter.text, "The cat, um, sat on the mat.");

  const umStart = afterStutter.text.indexOf("um, ");
  const afterFiller = applyStep(
    afterStutter.text,
    afterStutter.breakpoints,
    [{ start: umStart, end: umStart + 4, replacement: "", reason: "filler" }],
    raw,
  );
  assert.equal(afterFiller.text, "The cat, sat on the mat.");

  // "sat" in the twice-edited text must still resolve to its offset in the
  // ORIGINAL raw text, not merely the intermediate text.
  const satInFinal = afterFiller.text.indexOf("sat");
  assert.equal(mapToRaw(afterFiller.breakpoints, satInFinal), raw.indexOf("sat"));
});

test("applyStep handles an insertion (longer replacement than the matched span)", () => {
  const raw = "Section one\nWe begin now";
  const headingLine = raw.indexOf("\nWe begin");
  const step = applyStep(
    raw,
    identityOffsetMap(),
    [{ start: headingLine, end: headingLine, replacement: "\n", reason: "insert blank line" }],
    raw,
  );
  assert.equal(step.text, "Section one\n\nWe begin now");
  const weAt = step.text.indexOf("We begin");
  assert.equal(mapToRaw(step.breakpoints, weAt), raw.indexOf("We begin"));
});

test("buildDiff reconstructs equal/delete/insert spans from the offset map", () => {
  const raw = "So, um, we started.";
  const applied = applyStep(
    raw,
    identityOffsetMap(),
    [{ start: 4, end: 8, replacement: "", reason: "filler" }],
    raw,
  );
  const diff = buildDiff(raw, applied.text, applied.breakpoints);
  const deleted = diff.find((segment) => segment.op === "delete");
  assert.ok(deleted);
  assert.equal(deleted!.rawText, "um, ");
  assert.equal(diff.some((segment) => segment.op === "equal" && segment.rawText.includes("So,")), true);
});
