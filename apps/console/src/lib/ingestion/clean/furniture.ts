/**
 * Stage 3, step 3: transcription furniture (docs/PLAN.md Section 4) —
 * timestamps, bracketed transcriber notes, speaker labels, and the
 * mid-sentence line breaks auto-captioning tools insert to keep lines short.
 *
 * Unlike boilerplate (below), this is a small fixed list on purpose: these
 * are structural artifacts of the transcription format itself, not repeated
 * creator content, so there is nothing to "learn" per creator here.
 */
import { SPEAKER_LABEL, TIMESTAMP_LINE } from "../extract";
import type { TextEdit } from "../types";
import { dedupeOverlapping } from "../text-edits";

const BRACKETED_NOTE =
  /\[\s*(?:inaudible|crosstalk|cross[- ]talk|unintelligible|laughter|laughing|music|applause|silence|pause|background noise|static)\s*\]/giu;

const SENTENCE_END = /[.!?:;"'”’)\]]$/u;

function isStructuralLine(line: string): boolean {
  return TIMESTAMP_LINE.test(line) || SPEAKER_LABEL.test(line) || line.trim() === "";
}

export function findFurnitureEdits(text: string): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const match of text.matchAll(BRACKETED_NOTE)) {
    const start = match.index ?? 0;
    edits.push({
      start,
      end: start + match[0].length,
      replacement: "",
      reason: `transcription furniture removed: "${match[0]}"`,
    });
  }

  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const timestampMatch = TIMESTAMP_LINE.exec(line);
    // A line may carry both a timestamp prefix and a speaker label
    // ("00:12 Alex: ..."); the speaker check runs against whatever remains
    // after the timestamp rather than being mutually exclusive with it.
    const remainderAfterTimestamp =
      timestampMatch !== null ? line.slice(timestampMatch[0].length) : line;
    const remainderOffsetShift = timestampMatch !== null ? timestampMatch[0].length : 0;
    const speakerMatch = SPEAKER_LABEL.exec(remainderAfterTimestamp);

    if (timestampMatch !== null && timestampMatch[0].trim() !== "") {
      edits.push({
        start: offset,
        end: offset + timestampMatch[0].length,
        replacement: "",
        reason: "timestamp marker removed",
      });
    }
    if (speakerMatch !== null) {
      const speakerStart = offset + remainderOffsetShift;
      edits.push({
        start: speakerStart,
        end: speakerStart + speakerMatch[0].length,
        replacement: "",
        reason: `speaker label removed: "${speakerMatch[1]}"`,
      });
    }

    const nextLine = lines[index + 1];
    const lineEndsAtOffset = offset + line.length;
    if (
      nextLine !== undefined &&
      line.trim() !== "" &&
      nextLine.trim() !== "" &&
      !SENTENCE_END.test(line.trim()) &&
      !isStructuralLine(nextLine)
    ) {
      // A caption line break in the middle of a sentence: join with a space.
      edits.push({
        start: lineEndsAtOffset,
        end: lineEndsAtOffset + 1,
        replacement: " ",
        reason: "caption line break joined mid-sentence",
      });
    }

    offset = lineEndsAtOffset + 1;
  }

  return dedupeOverlapping(edits);
}
