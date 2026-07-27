/**
 * Stage 3, step 4: boilerplate (docs/PLAN.md Section 4) — intros, outros,
 * "smash that subscribe", housekeeping, promo reads.
 *
 * Deliberately NOT a hardcoded phrase list: a paragraph is only removed once
 * it has been seen, verbatim, at least `threshold` times across OTHER
 * uploads from the *same creator*. The caller supplies those prior counts
 * (read from `public.learning_ingestion_boilerplate_shingles` — scoped to
 * `auth.uid()`, never another tenant's or another creator's library) and
 * receives back the updates to persist, so the next upload benefits too.
 */
import { sha256Hex } from "../hash";
import type { BoilerplateShingleCounts, BoilerplateShingleUpdate, TextEdit } from "../types";

const MIN_CANDIDATE_LENGTH = 20;
const MAX_CANDIDATE_LENGTH = 600;
export const DEFAULT_BOILERPLATE_THRESHOLD = 2;

/** Exported so callers computing prior counts hash candidates identically. */
export function normalizeBoilerplateCandidate(paragraph: string): string {
  return paragraph
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.,!?;:"'“”’]+$/u, "")
    .trim();
}

export function boilerplateShingleHash(paragraph: string): string {
  return sha256Hex(normalizeBoilerplateCandidate(paragraph));
}

interface Paragraph {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function findParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const boundary = /\n\s*\n/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pushIfCandidate = (start: number, end: number) => {
    const raw = text.slice(start, end);
    const trimmedStart = start + (raw.length - raw.trimStart().length);
    const trimmedEnd = end - (raw.length - raw.trimEnd().length);
    if (trimmedEnd <= trimmedStart) return;
    const trimmed = text.slice(trimmedStart, trimmedEnd);
    if (trimmed.length < MIN_CANDIDATE_LENGTH || trimmed.length > MAX_CANDIDATE_LENGTH) return;
    paragraphs.push({ start: trimmedStart, end: trimmedEnd, text: trimmed });
  };
  while ((match = boundary.exec(text)) !== null) {
    pushIfCandidate(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  pushIfCandidate(cursor, text.length);
  return paragraphs;
}

export interface BoilerplateDetection {
  readonly edits: readonly TextEdit[];
  readonly shingleUpdates: readonly BoilerplateShingleUpdate[];
}

export function findBoilerplateEdits(
  text: string,
  priorCounts: BoilerplateShingleCounts,
  threshold: number = DEFAULT_BOILERPLATE_THRESHOLD,
): BoilerplateDetection {
  const edits: TextEdit[] = [];
  const shingleUpdates: BoilerplateShingleUpdate[] = [];

  for (const paragraph of findParagraphs(text)) {
    const normalized = normalizeBoilerplateCandidate(paragraph.text);
    if (normalized.length < MIN_CANDIDATE_LENGTH) continue;
    const hash = sha256Hex(normalized);
    shingleUpdates.push({ shingleHash: hash, sampleText: paragraph.text.slice(0, 200) });

    const priorOccurrences = priorCounts[hash] ?? 0;
    if (priorOccurrences >= threshold) {
      // Consume one adjacent blank-line run too, so removing this paragraph
      // never leaves behind a stray double blank line.
      let end = paragraph.end;
      const after = /^\s*\n\s*\n/u.exec(text.slice(end));
      if (after !== null) end += after[0].length;
      edits.push({
        start: paragraph.start,
        end,
        replacement: "",
        reason: `boilerplate removed: repeated ${priorOccurrences + 1} times across this creator's uploads`,
      });
    }
  }

  return { edits, shingleUpdates };
}
