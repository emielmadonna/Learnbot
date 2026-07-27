/**
 * Stage 3 (Clean) orchestrator (docs/PLAN.md Section 4). Runs the six
 * ordered steps, protecting quoted spans throughout, and composes one
 * cleaned-text -> raw-text offset map across all of them so a citation
 * survives every transformation. Cleaning is non-destructive: `rawText` is
 * never mutated, and the caller is expected to persist this whole result as
 * a NEW revision rather than overwriting anything.
 */
import { sha256Hex } from "../hash";
import { excludeProtected, findQuotedSpans } from "../quoted-spans";
import { applyStep, buildDiff, identityOffsetMap } from "../text-edits";
import type {
  BoilerplateShingleCounts,
  CleaningResult,
  CleaningStepLog,
  CleaningStepName,
  OffsetBreakpoint,
  TextEdit,
} from "../types";
import { findBoilerplateEdits } from "./boilerplate";
import { findDisfluencyEdits } from "./disfluencies";
import { findFalseStartEdits } from "./false-starts";
import { findFurnitureEdits } from "./furniture";
import { findSentenceRepairEdits } from "./sentence-repair";
import { findStructureEdits } from "./structure";

export function runCleaningPipeline(
  rawText: string,
  priorBoilerplateCounts: BoilerplateShingleCounts = {},
): CleaningResult {
  let text = rawText;
  let breakpoints: readonly OffsetBreakpoint[] = identityOffsetMap();
  const steps: CleaningStepLog[] = [];

  const runStep = (name: CleaningStepName, edits: readonly TextEdit[]) => {
    const protectedSpans = findQuotedSpans(text);
    const allowed = excludeProtected(edits, protectedSpans);
    const applied = applyStep(text, breakpoints, allowed, rawText);
    text = applied.text;
    breakpoints = applied.breakpoints;
    steps.push({ step: name, removals: applied.removals });
  };

  runStep("disfluencies", findDisfluencyEdits(text));
  runStep("false_starts", findFalseStartEdits(text));
  runStep("furniture", findFurnitureEdits(text));

  const boilerplate = findBoilerplateEdits(text, priorBoilerplateCounts);
  runStep("boilerplate", boilerplate.edits);

  runStep("sentence_repair", findSentenceRepairEdits(text));
  runStep("structure_recovery", findStructureEdits(text));

  return {
    cleanedText: text,
    steps,
    offsetMap: breakpoints,
    diff: buildDiff(rawText, text, breakpoints),
    contentHash: sha256Hex(text),
    cleanerVersion: 1,
    shingleUpdates: boilerplate.shingleUpdates,
  };
}
