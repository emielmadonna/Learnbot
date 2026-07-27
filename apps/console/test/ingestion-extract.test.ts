import assert from "node:assert/strict";
import test from "node:test";

import { extractPlainText } from "../src/lib/ingestion/extract";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test("extracts a markdown heading with its raw-text offset", () => {
  const text = "## Getting Started\n\nWelcome to the course.";
  const result = extractPlainText(bytes(text), "text/markdown");
  const heading = result.sourceLocations.find((location) => location.kind === "heading");
  assert.ok(heading);
  assert.equal(heading!.value, "Getting Started");
  assert.equal(heading!.offset, 0);
  assert.equal(result.rawText, text);
});

test("extracts an isolated plain-text heading candidate but not ordinary prose", () => {
  const text = [
    "Module One Overview",
    "",
    "We start today with the basics of the tool, and we will go slowly.",
  ].join("\n");
  const result = extractPlainText(bytes(text), "text/plain");
  const headings = result.sourceLocations.filter((location) => location.kind === "heading");
  assert.equal(headings.length, 1);
  assert.equal(headings[0]!.value, "Module One Overview");
});

test("extracts inline timestamps and speaker labels with correct offsets", () => {
  const text = "00:12 Alex: So today we begin the lesson.";
  const result = extractPlainText(bytes(text), "text/plain");
  const timestamp = result.sourceLocations.find((location) => location.kind === "timestamp");
  const speaker = result.sourceLocations.find((location) => location.kind === "speaker");
  assert.ok(timestamp);
  assert.equal(timestamp!.value, "00:12");
  assert.ok(speaker);
  assert.equal(speaker!.value, "Alex");
  assert.equal(text.slice(speaker!.offset).startsWith("Alex:"), true);
});

test("normalizes CRLF line endings without altering visible content", () => {
  const result = extractPlainText(bytes("Line one\r\nLine two\r\n"), "text/plain");
  assert.equal(result.rawText, "Line one\nLine two\n");
});

test("content hash is stable for identical bytes", () => {
  const a = extractPlainText(bytes("hello world"), "text/plain");
  const b = extractPlainText(bytes("hello world"), "text/plain");
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(a.contentHash.length, 64);
});
