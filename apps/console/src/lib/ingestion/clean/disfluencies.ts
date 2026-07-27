/**
 * Stage 3, step 1: disfluency removal (docs/PLAN.md Section 4).
 *
 * Rule of the whole module: a filler is only ever removed when its
 * surrounding punctuation makes it unambiguous that it is a discourse filler,
 * not a load-bearing word. That is what keeps "I mean it" intact while
 * stripping "I mean, we should..." — the comma is the signal, not the
 * phrase. Quoted speech is filtered out entirely by the caller
 * (`quoted-spans.ts`) before these edits are ever applied.
 */
import type { TextEdit } from "../types";
import { dedupeOverlapping } from "../text-edits";

const INTERJECTION =
  /[,]?\s*\b(?:um+|uh+|erm+|hmm+|huh)\b[,]?\s*/giu;

/** ", like," or ", you know," — bounded by commas on both sides. */
const COMMA_BOUNDED_TAG = /,\s*\b(like|you know)\b\s*,/giu;

/** "Like, " / "You know, " at the very start of a sentence or the text. */
const CLAUSE_INITIAL_TAG = /(^|[.!?]\s+|\n)\s*\b(like|you know)\b\s*,\s*/gimu;

/** "...you know?" / "...you know." as a trailing tag — punctuation kept. */
const TRAILING_TAG = /\byou know\b\s*(?=[.?!]|$)/giu;

/** "I mean, " — never "I mean it"/"I mean that", because no comma follows "mean" there. */
const HEDGING_I_MEAN = /\bI mean\s*,\s*/giu;

function edit(match: RegExpMatchArray, replacement: string, reason: string): TextEdit {
  const start = match.index ?? 0;
  return { start, end: start + match[0].length, replacement, reason };
}

export function findDisfluencyEdits(text: string): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const match of text.matchAll(INTERJECTION)) {
    const word = match[0].trim().replace(/,$/u, "");
    const replacement = (match.index ?? 0) === 0 || text[(match.index ?? 0) - 1] === "\n" ? "" : " ";
    edits.push(edit(match, replacement, `filler interjection removed: "${word}"`));
  }

  for (const match of text.matchAll(COMMA_BOUNDED_TAG)) {
    edits.push(edit(match, ",", `filler discourse tag removed: "${match[1]}"`));
  }

  for (const match of text.matchAll(CLAUSE_INITIAL_TAG)) {
    edits.push(edit(match, match[1] ?? "", `filler discourse tag removed: "${match[2]}"`));
  }

  for (const match of text.matchAll(TRAILING_TAG)) {
    edits.push(edit(match, "", 'filler discourse tag removed: "you know"'));
  }

  for (const match of text.matchAll(HEDGING_I_MEAN)) {
    const start = match.index ?? 0;
    const replacement = start === 0 || text[start - 1] === "\n" ? "" : " ";
    edits.push(edit(match, replacement, 'filler hedge removed: "I mean,"'));
  }

  return dedupeOverlapping(edits);
}
