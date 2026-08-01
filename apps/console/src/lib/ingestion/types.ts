/**
 * Shared types for the knowledge ingestion pipeline (docs/PLAN.md Section 4).
 *
 * The pipeline is six resumable stages — intake, extract, clean, review,
 * publish, serve — and every stage must write provenance so a citation a
 * student clicks survives every transformation back to a real location in a
 * real file. These types are the vocabulary the extract and clean stages
 * share; the database migration mirrors the same shapes in jsonb columns.
 */

/** One recoverable anchor into the RAW text produced by extraction. */
export interface SourceLocation {
  /** UTF-16 code-unit offset into the raw text where this anchor starts. */
  readonly offset: number;
  readonly kind: "heading" | "timestamp" | "speaker";
  /** The literal recovered value — a heading's text, a timestamp, a speaker name. */
  readonly value: string;
  /** 1-based line number in the raw text, for a human-readable citation. */
  readonly line: number;
}

export interface ExtractionResult {
  readonly rawText: string;
  readonly sourceLocations: readonly SourceLocation[];
  /** sha256 hex digest of rawText. */
  readonly contentHash: string;
  readonly extractor:
    | "plain_text_transcript_v1"
    | "pdf_text_v1"
    | "docx_raw_text_v1";
  readonly extractorVersion: 1;
}

/**
 * A single proposed transformation of a span of the CURRENT step's input
 * text. `end` is exclusive. `replacement` may be shorter (deletion), the same
 * length (a capitalization fix), or longer (inserting a missing period) than
 * the span it replaces. Edits proposed by one step must never overlap.
 */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly reason: string;
}

/** A breakpoint in the map from "current text" offsets back to raw-text offsets. */
export interface OffsetBreakpoint {
  readonly at: number;
  readonly rawAt: number;
}

/** What a creator sees logged for one cleaning step. */
export interface CleaningStepLog {
  readonly step: CleaningStepName;
  readonly removals: readonly CleaningRemoval[];
}

export type CleaningStepName =
  | "disfluencies"
  | "false_starts"
  | "furniture"
  | "boilerplate"
  | "sentence_repair"
  | "structure_recovery";

/** One removal/edit reported back to the creator, expressed in RAW-text offsets. */
export interface CleaningRemoval {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly originalText: string;
  readonly replacementText: string;
  readonly reason: string;
}

export type DiffOp = "equal" | "delete" | "insert" | "replace";

export interface DiffSegment {
  readonly op: DiffOp;
  readonly rawText: string;
  readonly cleanedText: string;
}

export interface CleaningResult {
  readonly cleanedText: string;
  readonly steps: readonly CleaningStepLog[];
  /** Cleaned-text offset -> raw-text offset, monotonically increasing by `at`. */
  readonly offsetMap: readonly OffsetBreakpoint[];
  readonly diff: readonly DiffSegment[];
  readonly contentHash: string;
  readonly cleanerVersion: 1;
  readonly shingleUpdates: readonly BoilerplateShingleUpdate[];
}

export interface BoilerplateShingleUpdate {
  readonly shingleHash: string;
  readonly sampleText: string;
}

/** What the cleaning pipeline reads back per candidate shingle before deciding removal. */
export interface BoilerplateShingleCounts {
  readonly [shingleHash: string]: number;
}
