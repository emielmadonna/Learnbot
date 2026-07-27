import assert from "node:assert/strict";
import test from "node:test";

import { boilerplateShingleHash } from "../src/lib/ingestion/clean/boilerplate";
import { runCleaningPipeline } from "../src/lib/ingestion/clean/pipeline";
import { mapToRaw } from "../src/lib/ingestion/text-edits";

test("never strips a filler word that appears inside a quotation", () => {
  const raw =
    'She told the class, "um, I mean it when I say this matters." Then, um, we moved on.';
  const result = runCleaningPipeline(raw);
  assert.ok(
    result.cleanedText.includes('"um, I mean it when I say this matters."'),
    `quoted filler was stripped: ${result.cleanedText}`,
  );
  // The un-quoted "um," right after the quote must still be removed.
  assert.ok(!result.cleanedText.includes("um, we moved on"));
});

test('preserves load-bearing "I mean it" while stripping the hedging "I mean,"', () => {
  const raw = "I mean it when I say practice matters. I mean, we should try again.";
  const result = runCleaningPipeline(raw);
  assert.ok(result.cleanedText.includes("I mean it when I say practice matters"));
  assert.ok(!result.cleanedText.toLowerCase().includes("i mean, we should"));
  // Sentence-repair capitalizes "we" because it is now sentence-initial —
  // correct behavior, not a stray leftover of the removed hedge.
  assert.ok(result.cleanedText.toLowerCase().includes("we should try again"));
});

test("collapses an immediate stutter of a short function word", () => {
  const raw = "The the lesson starts now.";
  const result = runCleaningPipeline(raw);
  assert.equal(result.cleanedText, "The lesson starts now.");
  const step = result.steps.find((entry) => entry.step === "false_starts");
  assert.ok(step && step.removals.length > 0);
});

test("removes bracketed transcription furniture and speaker labels", () => {
  const raw = "[inaudible] Let's continue.\nSPEAKER 1: Great, thanks for joining.";
  const result = runCleaningPipeline(raw);
  assert.ok(!result.cleanedText.includes("[inaudible]"));
  assert.ok(!result.cleanedText.includes("SPEAKER 1:"));
  assert.ok(result.cleanedText.includes("Great, thanks for joining."));
});

test("removes a paragraph only once it has repeated across the creator's own library", () => {
  const promo =
    "Don't forget to subscribe and hit the bell so you never miss a new lesson from this channel.";
  const raw = `Welcome back everyone.\n\n${promo}\n\nToday we cover functions.`;
  const hash = boilerplateShingleHash(promo);

  const firstTime = runCleaningPipeline(raw, {});
  assert.ok(firstTime.cleanedText.includes("subscribe"), "first occurrence must survive");

  const thirdTime = runCleaningPipeline(raw, { [hash]: 2 });
  assert.ok(!thirdTime.cleanedText.includes("subscribe"), "repeated boilerplate must be removed");
  assert.ok(thirdTime.cleanedText.includes("Today we cover functions."));
});

test("restores sentence-initial capitalization dropped by transcription", () => {
  const raw = "hello there. this needs fixing.";
  const result = runCleaningPipeline(raw);
  assert.equal(result.cleanedText, "Hello there. This needs fixing.");
});

test("the composed offset map still resolves a cleaned-text position back to its raw offset", () => {
  const raw = "Intro\n\nSo, um, the the lesson starts now, and it covers functions.";
  const result = runCleaningPipeline(raw);
  const wordInCleaned = result.cleanedText.indexOf("functions");
  const rawOffset = mapToRaw(result.offsetMap, wordInCleaned);
  assert.equal(raw.slice(rawOffset, rawOffset + 9), "functions");
});

test("the diff accounts for the entire raw and cleaned text with no gaps", () => {
  const raw = "So, um, we started. The the lesson continues.";
  const result = runCleaningPipeline(raw);
  const rawFromDiff = result.diff.map((segment) => segment.rawText).join("");
  const cleanedFromDiff = result.diff.map((segment) => segment.cleanedText).join("");
  assert.equal(rawFromDiff, raw);
  assert.equal(cleanedFromDiff, result.cleanedText);
});
