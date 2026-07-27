/**
 * Stage 3, step 2: false starts and stutters (docs/PLAN.md Section 4).
 *
 * Two conservative, high-precision patterns rather than one aggressive one:
 *
 *  - An immediate repeat of a short *function* word ("the the", "we we
 *    should"). The allowlist is deliberately restricted to function words —
 *    repeating a content word is often deliberate emphasis ("very very
 *    good", "no no no") and is left alone on purpose.
 *  - A self-interrupted restart: the same short phrase, a dash, then the
 *    identical phrase again ("We should— we should look at this."). Only an
 *    *exact* repeat qualifies, so a real dash-interruption followed by a
 *    genuinely new clause is never touched.
 */
import type { TextEdit } from "../types";
import { dedupeOverlapping } from "../text-edits";

const STUTTER_WORDS = [
  "the",
  "a",
  "an",
  "we",
  "i",
  "is",
  "and",
  "so",
  "to",
  "that",
  "it",
  "but",
  "of",
  "in",
  "on",
  "if",
  "or",
  "as",
  "at",
];

const STUTTER = new RegExp(
  `\\b(${STUTTER_WORDS.join("|")})\\b(\\s+)\\1\\b`,
  "giu",
);

const SELF_INTERRUPTED_RESTART =
  /\b(\w+(?:\s+\w+){0,3})[,]?\s*[-–—]{1,2}\s*\1\b/giu;

function edit(match: RegExpMatchArray, replacement: string, reason: string): TextEdit {
  const start = match.index ?? 0;
  return { start, end: start + match[0].length, replacement, reason };
}

export function findFalseStartEdits(text: string): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const match of text.matchAll(STUTTER)) {
    edits.push(edit(match, match[1] ?? "", `stutter removed: repeated "${match[1]}"`));
  }

  for (const match of text.matchAll(SELF_INTERRUPTED_RESTART)) {
    edits.push(
      edit(match, match[1] ?? "", `self-interrupted restart collapsed: "${match[1]}"`),
    );
  }

  return dedupeOverlapping(edits);
}
