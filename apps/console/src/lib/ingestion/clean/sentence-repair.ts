/**
 * Stage 3, step 5: sentence repair (docs/PLAN.md Section 4) — restoring
 * punctuation and casing that transcription drops, and mopping up the
 * whitespace/punctuation seams the earlier steps deliberately leave behind
 * rather than trying to get perfect on their own (a removed filler word
 * leaves "So,  we" or "So, , we"; this step is what turns that into "So we").
 */
import type { TextEdit } from "../types";
import { dedupeOverlapping } from "../text-edits";

const DOUBLE_SPACE = / {2,}/gu;
const SPACE_BEFORE_PUNCTUATION = / +([,.!?;:])/gu;
const DOUBLE_COMMA = /,(\s*,)+/gu;
const COMMA_BEFORE_PERIOD = ",\\s*\\.";
const COMMA_BEFORE_PERIOD_RE = new RegExp(COMMA_BEFORE_PERIOD, "gu");
const TRAILING_LINE_SPACE = /[ \t]+$/gmu;
const LEADING_COMMA = /(^|\n)[ \t]*,[ \t]*/gmu;
const SENTENCE_START_LOWERCASE = /(^|[.!?]\s+|\n\s*)([a-z])/gmu;
const PARAGRAPH_END_MISSING_PUNCTUATION = /([^\s.!?:;,"'”’)\]\n])\n\s*\n/gu;

function pointEdits(
  text: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => TextEdit | null,
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const match of text.matchAll(pattern)) {
    const built = build(match as RegExpExecArray);
    if (built !== null) edits.push(built);
  }
  return edits;
}

export function findSentenceRepairEdits(text: string): TextEdit[] {
  const edits: TextEdit[] = [
    ...pointEdits(text, DOUBLE_SPACE, (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      replacement: " ",
      reason: "collapsed repeated whitespace",
    })),
    ...pointEdits(text, SPACE_BEFORE_PUNCTUATION, (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      replacement: match[1] ?? "",
      reason: "removed space before punctuation",
    })),
    ...pointEdits(text, DOUBLE_COMMA, (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      replacement: ",",
      reason: "collapsed duplicate comma left by an earlier removal",
    })),
    ...pointEdits(text, COMMA_BEFORE_PERIOD_RE, (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      replacement: ".",
      reason: "removed dangling comma before a sentence end",
    })),
    ...pointEdits(text, TRAILING_LINE_SPACE, (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      replacement: "",
      reason: "trimmed trailing line whitespace",
    })),
    ...pointEdits(text, LEADING_COMMA, (match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      replacement: match[1] ?? "",
      reason: "removed a leading comma left by an earlier removal",
    })),
    ...pointEdits(text, SENTENCE_START_LOWERCASE, (match) => {
      const letter = match[2]!;
      const letterStart = (match.index ?? 0) + match[0].length - 1;
      return {
        start: letterStart,
        end: letterStart + 1,
        replacement: letter.toUpperCase(),
        reason: "restored sentence-initial capitalization",
      };
    }),
    ...pointEdits(text, PARAGRAPH_END_MISSING_PUNCTUATION, (match) => {
      const insertAt = (match.index ?? 0) + match[1]!.length;
      return {
        start: insertAt,
        end: insertAt,
        replacement: ".",
        reason: "restored missing terminal punctuation",
      };
    }),
  ];

  return dedupeOverlapping(edits);
}
