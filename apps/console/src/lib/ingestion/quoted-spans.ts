/**
 * Finds spans of `text` that are quoted speech, so every cleaning step can
 * refuse to touch a single character inside them. This is the mechanism
 * behind "never inside a quotation" (docs/PLAN.md Section 4, stage 3): a
 * creator quoting a student, a book, or their own past words verbatim must
 * come through byte-for-byte, filler words and all.
 */
import type { TextEdit } from "./types";

export interface Span {
  readonly start: number;
  readonly end: number;
}

const DOUBLE_QUOTE_PAIR = /["“][^"”\n]{1,4000}["”]/gu;
const SINGLE_QUOTE_PAIR =
  /(?<=[\s(,:;—-])'[^'\n]{2,4000}'(?=[\s).,:;!?—-]|$)/gu;

/** A markdown/plain-text blockquote line: one that starts with `> `. */
const BLOCKQUOTE_LINE = /^[ \t]*>.*$/gmu;

export function findQuotedSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(DOUBLE_QUOTE_PAIR)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(SINGLE_QUOTE_PAIR)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(BLOCKQUOTE_LINE)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  spans.sort((a, b) => a.start - b.start);
  return mergeOverlapping(spans);
}

function mergeOverlapping(spans: readonly Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/** True when [start, end) overlaps any protected span, even partially. */
export function overlapsAny(
  spans: readonly Span[],
  start: number,
  end: number,
): boolean {
  // spans is sorted ascending by start; a linear scan is fine at transcript
  // scale (typically low hundreds of quotes at most).
  for (const span of spans) {
    if (span.start >= end) break;
    if (span.end > start) return true;
  }
  return false;
}

/** Drops every candidate edit that touches a protected quoted span. */
export function excludeProtected(
  edits: readonly TextEdit[],
  protectedSpans: readonly Span[],
): TextEdit[] {
  if (protectedSpans.length === 0) return [...edits];
  return edits.filter((edit) => !overlapsAny(protectedSpans, edit.start, edit.end));
}
