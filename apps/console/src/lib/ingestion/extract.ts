/**
 * Stage 2 (Extract) for plain-text and markdown transcript uploads
 * (docs/PLAN.md Section 4). PDF/DOCX/audio extraction are separate,
 * out-of-scope extractors for a later pass — this is the one file type taken
 * end to end, because it is where the cleaning module actually matters.
 *
 * Output is raw text plus a list of `SourceLocation` anchors (heading,
 * timestamp, speaker) with character offsets, matching the plan's "raw text
 * plus an asset list, each with a source location" requirement. Every
 * anchor's offset is into the RAW text returned here — cleaning never
 * changes these offsets, it only carries a map back to them.
 */
import { sha256Hex } from "./hash";
import type { ExtractionResult, SourceLocation } from "./types";

export type PlainTextMediaType = "text/plain" | "text/markdown";

const MAX_RAW_TEXT_LENGTH = 4_000_000;

/** Exported so the cleaning stage (`clean/furniture.ts`) recognizes the same shapes. */
export const TIMESTAMP_LINE =
  /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?(?:\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)?\s*[:.\-]?\s*/u;

export const SPEAKER_LABEL = /^\s*([A-Z][\w .'-]{0,39}):\s+(?=\S)/u;

const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;

const TITLE_CASE_WORD = /^[A-Z0-9][\w'&-]*$/u;

/** Exported so `clean/structure.ts` can re-apply the same heading shape test. */
export function isPlainTextHeadingCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 70) return false;
  if (/[.,;!?]$/u.test(trimmed)) return false;
  if (TIMESTAMP_LINE.test(trimmed) || SPEAKER_LABEL.test(trimmed)) {
    return false;
  }
  if (trimmed === trimmed.toUpperCase() && /[A-Z]/u.test(trimmed)) {
    return true;
  }
  const words = trimmed.split(/\s+/u);
  if (words.length < 1 || words.length > 10) return false;
  const capitalized = words.filter((word) => TITLE_CASE_WORD.test(word));
  return capitalized.length / words.length >= 0.7;
}

/** Decodes bytes as UTF-8 and normalizes line endings without touching content. */
export function decodeUploadedText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.replace(/\r\n?/gu, "\n").replace(/^﻿/u, "");
}

export function extractPlainText(
  bytes: Uint8Array,
  mediaType: PlainTextMediaType,
): ExtractionResult {
  const rawText = decodeUploadedText(bytes).slice(0, MAX_RAW_TEXT_LENGTH);
  const lines = rawText.split("\n");
  const sourceLocations: SourceLocation[] = [];

  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const isIsolated =
      (lines[index - 1]?.trim() ?? "") === "" &&
      (lines[index + 1]?.trim() ?? "") === "";

    const atxMatch = ATX_HEADING.exec(line);
    const timestampMatch = TIMESTAMP_LINE.exec(line);
    // A line may carry both a leading timestamp AND a speaker label
    // ("00:12 Alex: ..."), so the speaker check runs against whatever
    // remains after the timestamp prefix rather than being mutually
    // exclusive with it.
    const remainderAfterTimestamp =
      timestampMatch !== null ? line.slice(timestampMatch[0].length) : line;
    const remainderOffsetShift =
      timestampMatch !== null ? timestampMatch[0].length : 0;
    const speakerMatch = SPEAKER_LABEL.exec(remainderAfterTimestamp);

    if (mediaType === "text/markdown" && atxMatch !== null) {
      sourceLocations.push({
        offset,
        kind: "heading",
        value: atxMatch[2]!.trim(),
        line: lineNumber,
      });
    } else if (mediaType === "text/plain" && isIsolated && isPlainTextHeadingCandidate(line)) {
      sourceLocations.push({
        offset,
        kind: "heading",
        value: line.trim(),
        line: lineNumber,
      });
    }

    if (timestampMatch !== null) {
      sourceLocations.push({
        offset,
        kind: "timestamp",
        value: timestampMatch[1]!,
        line: lineNumber,
      });
    }
    if (speakerMatch !== null) {
      sourceLocations.push({
        offset: offset + remainderOffsetShift,
        kind: "speaker",
        value: speakerMatch[1]!.trim(),
        line: lineNumber,
      });
    }

    offset += line.length + 1; // account for the '\n' the split() consumed
  }

  sourceLocations.sort((a, b) => a.offset - b.offset);

  return {
    rawText,
    sourceLocations,
    contentHash: sha256Hex(rawText),
    extractor: "plain_text_transcript_v1",
    extractorVersion: 1,
  };
}
