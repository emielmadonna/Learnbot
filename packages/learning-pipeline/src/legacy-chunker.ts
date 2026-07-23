import type {
  EmbeddedChunk,
  TranscriptCue,
  TranscriptParagraph,
} from "./types.js";

export const LEGACY_PAUSE_BOUNDARY_MS = 1_800;
export const LEGACY_TARGET_WORDS = 220;
export const LEGACY_OVERLAP_WORDS = 40;

interface TimestampedWord {
  readonly value: string;
  readonly startMs?: number;
  readonly endMs?: number;
}

export function paragraphizeTranscript(
  cues: readonly TranscriptCue[],
): readonly TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  let words: string[] = [];
  let startMs: number | undefined;
  let endMs: number | undefined;

  const flush = (): void => {
    if (words.length === 0) return;
    paragraphs.push({
      text: words.join(" "),
      ...(startMs === undefined ? {} : { startMs }),
      ...(endMs === undefined ? {} : { endMs }),
    });
    words = [];
    startMs = undefined;
    endMs = undefined;
  };

  cues.forEach((cue, index) => {
    const previous = index === 0 ? undefined : cues[index - 1];
    if (
      previous !== undefined &&
      cue.startMs - previous.endMs >= LEGACY_PAUSE_BOUNDARY_MS
    ) {
      flush();
    }
    if (startMs === undefined) startMs = cue.startMs;
    const cueWords = splitWords(cue.text);
    words.push(...cueWords);
    endMs = cue.endMs;
  });
  flush();
  return paragraphs;
}

export function paragraphizeText(body: string): readonly TranscriptParagraph[] {
  return body
    .split(/\n\s*\n/u)
    .map((text) => text.trim().replace(/\s+/gu, " "))
    .filter(Boolean)
    .map((text) => ({ text }));
}

export function legacyChunk(
  tenantId: string,
  documentId: string,
  paragraphs: readonly TranscriptParagraph[],
): readonly EmbeddedChunk[] {
  const words: TimestampedWord[] = paragraphs.flatMap((paragraph) =>
    splitWords(paragraph.text).map((value) => ({
      value,
      ...(paragraph.startMs === undefined
        ? {}
        : { startMs: paragraph.startMs }),
      ...(paragraph.endMs === undefined ? {} : { endMs: paragraph.endMs }),
    })),
  );

  const chunks: EmbeddedChunk[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + LEGACY_TARGET_WORDS, words.length);
    const slice = words.slice(start, end);
    const first = slice[0];
    const last = slice.at(-1);
    const chunkId = stableId("chunk", `${tenantId}:${documentId}:${start}`);
    const text = slice.map((word) => word.value).join(" ");
    chunks.push({
      chunkId,
      tenantId,
      documentId,
      text,
      ordinal: chunks.length,
      tokenCount: approximateTokens(text),
      assetIds: [],
      metadata: {
        wordCount: slice.length,
        wordStart: start,
        ...(first?.startMs === undefined
          ? {}
          : { startTimestampMs: first.startMs }),
        ...(last?.endMs === undefined ? {} : { endTimestampMs: last.endMs }),
      },
      embedding: deterministicEmbedding(text),
    });
    if (end === words.length) break;
    start = end - LEGACY_OVERLAP_WORDS;
  }
  return chunks;
}

export function deterministicEmbedding(text: string): readonly number[] {
  const accumulator = Array.from({ length: 8 }, () => 0);
  Array.from(text).forEach((character, index) => {
    const slot = index % accumulator.length;
    accumulator[slot] = ((accumulator[slot] ?? 0) + character.codePointAt(0)!) % 997;
  });
  return accumulator.map((value) => Number((value / 997).toFixed(6)));
}

export function stableId(prefix: string, value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean);
}

function approximateTokens(text: string): number {
  return Math.ceil(splitWords(text).length * 1.33);
}
