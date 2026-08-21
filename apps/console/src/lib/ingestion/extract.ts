/**
 * Stage 2 (Extract) for text, Markdown, PDF, and DOCX uploads
 * (docs/PLAN.md Section 4).
 *
 * Output is raw text plus a list of `SourceLocation` anchors (heading,
 * timestamp, speaker) with character offsets, matching the plan's "raw text
 * plus an asset list, each with a source location" requirement. Every
 * anchor's offset is into the RAW text returned here — cleaning never
 * changes these offsets, it only carries a map back to them.
 */
import { sha256Hex } from "./hash";
import type { ExtractionResult, SourceLocation } from "./types";

export type PlainTextMediaType = "text/plain" | "text/markdown";
export type SupportedDocumentMediaType =
  | PlainTextMediaType
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const MAX_RAW_TEXT_LENGTH = 4_000_000;
const MAX_PDF_PAGES = 500;

export class DocumentExtractionError extends Error {
  constructor(
    readonly code:
      | "document_extraction_failed"
      | "document_has_no_extractable_text"
      | "document_page_limit_exceeded",
  ) {
    super(code);
    this.name = "DocumentExtractionError";
  }
}

/** Exported so the cleaning stage (`clean/furniture.ts`) recognizes the same shapes. */
export const TIMESTAMP_LINE =
  /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?(?:\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)?\s*[:.\-]?\s*/u;

export const SPEAKER_LABEL = /^\s*([A-Z][\w .'-]{0,39}):\s+(?=\S)/u;

const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;

const TITLE_CASE_WORD = /^[A-Z0-9][\w'&-]*$/u;

/** Exported so `clean/structure.ts` can re-apply the same heading shape test. */
export function isPlainTextHeadingCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 70) return false;
  if (/[.,;!?]$/u.test(trimmed)) return false;
  if (TIMESTAMP_LINE.test(trimmed) || SPEAKER_LABEL.test(trimmed)) {
    return false;
  }
  if (trimmed === trimmed.toUpperCase() && /[A-Z]/u.test(trimmed)) {
    return true;
  }
  const words = trimmed.split(/\s+/u);
  if (words.length < 1 || words.length > 10) return false;
  const capitalized = words.filter((word) => TITLE_CASE_WORD.test(word));
  return capitalized.length / words.length >= 0.7;
}

/** Decodes bytes as UTF-8 and normalizes line endings without touching content. */
export function decodeUploadedText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.replace(/\r\n?/gu, "\n").replace(/^﻿/u, "");
}

export function extractPlainText(
  bytes: Uint8Array,
  mediaType: PlainTextMediaType,
): ExtractionResult {
  const rawText = decodeUploadedText(bytes).slice(0, MAX_RAW_TEXT_LENGTH);
  const lines = rawText.split("\n");
  const sourceLocations: SourceLocation[] = [];

  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const isIsolated =
      (lines[index - 1]?.trim() ?? "") === "" &&
      (lines[index + 1]?.trim() ?? "") === "";

    const atxMatch = ATX_HEADING.exec(line);
    const timestampMatch = TIMESTAMP_LINE.exec(line);
    // A line may carry both a leading timestamp AND a speaker label
    // ("00:12 Alex: ..."), so the speaker check runs against whatever
    // remains after the timestamp prefix rather than being mutually
    // exclusive with it.
    const remainderAfterTimestamp =
      timestampMatch !== null ? line.slice(timestampMatch[0].length) : line;
    const remainderOffsetShift =
      timestampMatch !== null ? timestampMatch[0].length : 0;
    const speakerMatch = SPEAKER_LABEL.exec(remainderAfterTimestamp);

    if (mediaType === "text/markdown" && atxMatch !== null) {
      sourceLocations.push({
        offset,
        kind: "heading",
        value: atxMatch[2]!.trim(),
        line: lineNumber,
      });
    } else if (mediaType === "text/plain" && isIsolated && isPlainTextHeadingCandidate(line)) {
      sourceLocations.push({
        offset,
        kind: "heading",
        value: line.trim(),
        line: lineNumber,
      });
    }

    if (timestampMatch !== null) {
      sourceLocations.push({
        offset,
        kind: "timestamp",
        value: timestampMatch[1]!,
        line: lineNumber,
      });
    }
    if (speakerMatch !== null) {
      sourceLocations.push({
        offset: offset + remainderOffsetShift,
        kind: "speaker",
        value: speakerMatch[1]!.trim(),
        line: lineNumber,
      });
    }

    offset += line.length + 1; // account for the '\n' the split() consumed
  }

  sourceLocations.sort((a, b) => a.offset - b.offset);

  return {
    rawText,
    sourceLocations,
    contentHash: sha256Hex(rawText),
    extractor: "plain_text_transcript_v1",
    extractorVersion: 1,
  };
}

function requireExtractableText(value: string) {
  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(/^﻿/u, "")
    .slice(0, MAX_RAW_TEXT_LENGTH);
  if (normalized.trim().length === 0) {
    throw new DocumentExtractionError("document_has_no_extractable_text");
  }
  return normalized;
}

export function extractionFromParsedDocument(
  rawValue: string,
  extractor: Extract<ExtractionResult["extractor"], `${string}_text_v1`>,
  pageOffsets: readonly { offset: number; page: number; line: number }[] = [],
): ExtractionResult {
  const rawText = requireExtractableText(rawValue);
  const base = extractPlainText(
    new TextEncoder().encode(rawText),
    "text/plain",
  );
  const sourceLocations: SourceLocation[] = [
    ...base.sourceLocations,
    ...pageOffsets
      .filter((entry) => entry.offset < rawText.length)
      .map(
        (entry): SourceLocation => ({
          offset: entry.offset,
          kind: "heading",
          value: `Page ${entry.page}`,
          line: entry.line,
        }),
      ),
  ].sort((left, right) => left.offset - right.offset);

  return {
    ...base,
    sourceLocations,
    extractor,
    extractorVersion: 1,
  };
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    try {
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new DocumentExtractionError("document_page_limit_exceeded");
      }
      const extracted = await extractText(pdf, { mergePages: false });
      const pages = extracted.text.map((page) =>
        page.replace(/\r\n?/gu, "\n").trim(),
      );
      const offsets: { offset: number; page: number; line: number }[] = [];
      let offset = 0;
      let line = 1;
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index] ?? "";
        offsets.push({ offset, page: index + 1, line });
        offset += page.length + (index === pages.length - 1 ? 0 : 2);
        line += page.split("\n").length + 1;
      }
      return extractionFromParsedDocument(
        pages.join("\n\n"),
        "pdf_text_v1",
        offsets,
      );
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("document_extraction_failed");
  }
}

async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const mammothModule = await import("mammoth");
    const result = await mammothModule.default.extractRawText({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    return extractionFromParsedDocument(result.value, "docx_raw_text_v1");
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("document_extraction_failed");
  }
}

export async function extractUploadedDocument(
  bytes: Uint8Array,
  mediaType: SupportedDocumentMediaType,
): Promise<ExtractionResult> {
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    const extraction = extractPlainText(bytes, mediaType);
    requireExtractableText(extraction.rawText);
    return extraction;
  }
  if (mediaType === "application/pdf") return extractPdf(bytes);
  return extractDocx(bytes);
}
