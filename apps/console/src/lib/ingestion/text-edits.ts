/**
 * Generic, provenance-preserving text-edit machinery shared by every cleaning
 * step (packages: disfluencies, false starts, furniture, boilerplate,
 * sentence repair, structure recovery).
 *
 * Each step proposes a list of non-overlapping `TextEdit`s against the
 * text as it stands *after the previous step*. `applyStep` applies them and,
 * critically, carries forward a mapping from the new text's offsets all the
 * way back to the ORIGINAL raw text's offsets — not just the previous
 * step's. That composed mapping is what lets a citation survive five rounds
 * of editing and still resolve to a real offset in the file the creator
 * uploaded (docs/PLAN.md Section 4, stage 3: "cleaning is non-destructive").
 */
import type { DiffSegment, OffsetBreakpoint, TextEdit } from "./types";

const IDENTITY_MAP: readonly OffsetBreakpoint[] = [{ at: 0, rawAt: 0 }];

/** The breakpoint map every pipeline starts from: raw text maps to itself. */
export function identityOffsetMap(): readonly OffsetBreakpoint[] {
  return IDENTITY_MAP;
}

/**
 * Raw-text offset corresponding to `pos` in the text this breakpoint map
 * describes. Breakpoints must be sorted ascending by `at`; the segment
 * between two breakpoints is assumed to be an untouched copy, so offsets
 * inside it are recovered by adding the constant delta to the prior anchor.
 */
export function mapToRaw(
  breakpoints: readonly OffsetBreakpoint[],
  pos: number,
): number {
  let lo = 0;
  let hi = breakpoints.length - 1;
  let candidate = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (breakpoints[mid]!.at <= pos) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const bp = breakpoints[candidate] ?? { at: 0, rawAt: 0 };
  return bp.rawAt + Math.max(0, pos - bp.at);
}

/**
 * Keeps the earliest-starting edit whenever two candidate edits overlap.
 * Every step-finder produces candidates independently per pattern; this is
 * the one seam where they are reconciled before `applyStep` (which requires
 * non-overlapping input) ever sees them.
 */
export function dedupeOverlapping(edits: readonly TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: TextEdit[] = [];
  for (const edit of sorted) {
    const last = accepted[accepted.length - 1];
    if (last !== undefined && edit.start < last.end) continue;
    accepted.push(edit);
  }
  return accepted;
}

export interface AppliedStep {
  readonly text: string;
  readonly breakpoints: readonly OffsetBreakpoint[];
  readonly removals: readonly {
    readonly rawStart: number;
    readonly rawEnd: number;
    readonly originalText: string;
    readonly replacementText: string;
    readonly reason: string;
  }[];
}

function assertWellFormed(currentText: string, edits: readonly TextEdit[]) {
  let previousEnd = -1;
  for (const edit of edits) {
    if (
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > currentText.length
    ) {
      throw new RangeError(
        `Cleaning edit [${edit.start}, ${edit.end}) is out of bounds for text of length ${currentText.length}`,
      );
    }
    if (edit.start < previousEnd) {
      throw new RangeError(
        "Cleaning edits from one step must not overlap and must be sorted ascending",
      );
    }
    previousEnd = edit.end;
  }
}

/**
 * Applies one cleaning step's edits to `currentText`, and folds the result
 * through `currentBreakpoints` so the returned breakpoints still map all the
 * way back to `rawText` — never merely to `currentText`.
 */
export function applyStep(
  currentText: string,
  currentBreakpoints: readonly OffsetBreakpoint[],
  edits: readonly TextEdit[],
  rawText: string,
): AppliedStep {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  assertWellFormed(currentText, sorted);
  if (sorted.length === 0) {
    return { text: currentText, breakpoints: currentBreakpoints, removals: [] };
  }

  const outputParts: string[] = [];
  const newBreakpoints: OffsetBreakpoint[] = [];
  const removals: AppliedStep["removals"][number][] = [];
  let cursor = 0;
  let outPos = 0;
  let bpIndex = 0;

  const flushUpTo = (limit: number, shift: number) => {
    while (
      bpIndex < currentBreakpoints.length &&
      currentBreakpoints[bpIndex]!.at < limit
    ) {
      const bp = currentBreakpoints[bpIndex]!;
      const last = newBreakpoints[newBreakpoints.length - 1];
      const at = bp.at + shift;
      if (last === undefined || last.at !== at) {
        newBreakpoints.push({ at, rawAt: bp.rawAt });
      }
      bpIndex += 1;
    }
  };

  for (const edit of sorted) {
    const shift = outPos - cursor;
    if (edit.start > cursor) {
      outputParts.push(currentText.slice(cursor, edit.start));
    }
    flushUpTo(edit.start, shift);

    const editOutStart = outPos + (edit.start - cursor);
    const editRawStart = mapToRaw(currentBreakpoints, edit.start);
    const editRawEnd = mapToRaw(currentBreakpoints, edit.end);
    const last = newBreakpoints[newBreakpoints.length - 1];
    if (last === undefined || last.at !== editOutStart) {
      newBreakpoints.push({ at: editOutStart, rawAt: editRawStart });
    }

    outputParts.push(edit.replacement);
    if (edit.end > edit.start || edit.replacement !== "") {
      removals.push({
        rawStart: editRawStart,
        rawEnd: editRawEnd,
        originalText: rawText.slice(editRawStart, editRawEnd),
        replacementText: edit.replacement,
        reason: edit.reason,
      });
    }

    const editOutEnd = editOutStart + edit.replacement.length;
    newBreakpoints.push({ at: editOutEnd, rawAt: editRawEnd });
    outPos = editOutEnd;
    cursor = edit.end;

    while (
      bpIndex < currentBreakpoints.length &&
      currentBreakpoints[bpIndex]!.at < edit.end
    ) {
      bpIndex += 1;
    }
  }

  const finalShift = outPos - cursor;
  if (cursor < currentText.length) {
    outputParts.push(currentText.slice(cursor));
  }
  flushUpTo(currentText.length + 1, finalShift);

  return {
    text: outputParts.join(""),
    breakpoints: newBreakpoints,
    removals,
  };
}

/**
 * Reconstructs a raw-vs-cleaned diff for the review UI directly from the
 * final composed offset map, rather than re-diffing the strings — the map
 * already knows exactly which spans survived unchanged.
 */
export function buildDiff(
  rawText: string,
  cleanedText: string,
  offsetMap: readonly OffsetBreakpoint[],
): DiffSegment[] {
  const boundaries = [...offsetMap];
  if (boundaries.length === 0 || boundaries[0]!.at !== 0) {
    boundaries.unshift({ at: 0, rawAt: 0 });
  }
  const segments: DiffSegment[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1];
    const cleanedEnd = end?.at ?? cleanedText.length;
    const rawEnd = end?.rawAt ?? rawText.length;
    if (cleanedEnd <= start.at && rawEnd <= start.rawAt) continue;
    const cleanedSpan = cleanedText.slice(start.at, cleanedEnd);
    const rawSpan = rawText.slice(start.rawAt, rawEnd);
    if (cleanedSpan === "" && rawSpan === "") continue;
    const op =
      cleanedSpan === rawSpan
        ? "equal"
        : cleanedSpan === ""
          ? "delete"
          : rawSpan === ""
            ? "insert"
            : "replace";
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.op === op && op === "equal") {
      segments[segments.length - 1] = {
        op,
        rawText: previous.rawText + rawSpan,
        cleanedText: previous.cleanedText + cleanedSpan,
      };
    } else {
      segments.push({ op, rawText: rawSpan, cleanedText: cleanedSpan });
    }
  }
  return segments;
}
