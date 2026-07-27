/**
 * Stage 3, step 6: structure recovery (docs/PLAN.md Section 4) — inferring
 * headings so the publish-stage chunker (`app_private.knowledge_split_text` /
 * `knowledge_pack_chunks`, reused unchanged from the authored content path)
 * breaks chunks on meaning rather than mid-thought.
 *
 * This step only ever *inserts* a blank line around a heading-shaped line
 * that is not already isolated — it never removes or rewrites a word, so it
 * cannot be the step that corrupts a creator's meaning.
 */
import { isPlainTextHeadingCandidate } from "../extract";
import type { TextEdit } from "../types";
import { dedupeOverlapping } from "../text-edits";

export function findStructureEdits(text: string): TextEdit[] {
  const lines = text.split("\n");
  const edits: TextEdit[] = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed !== "" && isPlainTextHeadingCandidate(line) && index > 0) {
      const prevBlank = (lines[index - 1]?.trim() ?? "") === "";
      const nextBlank = (lines[index + 1]?.trim() ?? "") === "";
      if (!prevBlank) {
        edits.push({
          start: offset,
          end: offset,
          replacement: "\n",
          reason: `inserted blank line before inferred heading "${trimmed}"`,
        });
      }
      if (!nextBlank && index < lines.length - 1) {
        const lineEnd = offset + line.length;
        edits.push({
          start: lineEnd,
          end: lineEnd,
          replacement: "\n",
          reason: `inserted blank line after inferred heading "${trimmed}"`,
        });
      }
    }
    offset += line.length + 1;
  }

  return dedupeOverlapping(edits);
}
