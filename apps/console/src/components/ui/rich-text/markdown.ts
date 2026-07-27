/**
 * The console's one rich-text format, and the only thing allowed to turn it
 * into something renderable.
 *
 * ## This file is the single source of truth for the sanitizer
 *
 * It began life as a hand-copied fork of `packages/course-authoring/src/sanitizer.ts`,
 * which meant two divergent copies of an XSS-relevant regex set. That package was
 * deleted on 2026-07-26 — its eleven authoring operations, revisions and rollback
 * are live in plpgsql (`20260725122000_course_editing.sql`), and the TypeScript
 * had zero importers — so this file is now the only copy. **Do not re-share it
 * back into a workspace package.** The fork was not an accident: the authoring
 * package pulled in `node:crypto` through its service layer, and this module is
 * imported by client components, so a shared import would have dragged a Node
 * builtin into the browser bundle. Any future server-side sanitizer must import
 * *this* module, not restate it.
 *
 * ## Why markdown, and why a render *plan* instead of HTML
 *
 * The editorial vocabulary is fixed: a span carries
 * `bold | italic | underline | strike | code` marks plus an optional `href`, and
 * `safeLinkHref` fixes the URL policy (`https:` / `mailto:` / same-document
 * fragment, no credentials, no private hosts). The console's `rich_text` block
 * content already declares `{ text, format }` with `format: "markdown"` as one
 * of its two legal values. So the storage format here is that declared one —
 * markdown in `content.text`, `format:"markdown"`.
 * Nothing new is invented, and no block content shape changes.
 *
 * Rendering never goes near an HTML string. `parseRichText` produces a tree of
 * *allowlisted tags* (`RICH_TEXT_TAGS`) whose leaves are plain text nodes, and
 * the React renderer builds elements from that tree. There is therefore no
 * `dangerouslySetInnerHTML` anywhere in this pipeline and no place for markup
 * to be injected: an attacker-controlled `<script>` in the stored text can only
 * ever come back out as a *text node*, which React escapes.
 *
 * Two independent gates, so neither one is load-bearing on its own:
 *   1. **On write** — `sanitizeRichTextMarkdown` strips dangerous elements,
 *      every remaining HTML tag, and control characters, then NFC-normalises.
 *   2. **On render** — the parser emits only allowlisted tags and only
 *      allowlisted attributes, and `safeLinkHref` re-checks every URL against
 *      the same policy.
 *
 * This module is deliberately free of React and CSS imports so it can be unit
 * tested directly under `node:test`.
 */

/* ------------------------------------------------------------------------ */
/* The allowlist                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Every element a rich-text document may become. Anything outside this set is
 * unrepresentable — the parser has no branch that produces it.
 */
export type RichTextTag =
  | "p"
  | "h2"
  | "h3"
  | "h4"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "pre"
  | "code"
  | "strong"
  | "em"
  | "a"
  | "hr"
  | "br"
  | "sup";

export const RICH_TEXT_TAGS: ReadonlySet<RichTextTag> = new Set<RichTextTag>([
  "p",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "strong",
  "em",
  "a",
  "hr",
  "br",
  "sup",
]);

/**
 * The only attributes any node may carry. `href` is always run through
 * `safeLinkHref`; `language` becomes a `data-language` string on `<pre>`;
 * `citation` becomes a same-document fragment link on a `<sup>`.
 */
export type RichTextNode =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "element";
      readonly tag: RichTextTag;
      readonly children: readonly RichTextNode[];
      readonly href?: string;
      readonly language?: string;
      readonly citation?: number;
    };

export type RichTextDocument = readonly RichTextNode[];

/* ------------------------------------------------------------------------ */
/* Write-side sanitisation                                                   */
/* ------------------------------------------------------------------------ */

/** Control characters stripped on write: tab, LF and CR survive. */
const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** Dangerous HTML elements, removed with their contents. */
const DANGEROUS_HTML =
  /<(?:script|style|iframe|object|embed|link|meta|svg|math)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed|link|meta|svg|math)>|<(?:script|style|iframe|object|embed|link|meta|svg|math)\b[^>]*\/?>/giu;

/** Any remaining HTML tag. */
const HTML_TAG = /<\/?[a-z][^>]*>/giu;

/** Ceiling for one block's markdown. The route caps whole content at 100 kB. */
export const RICH_TEXT_MAX_LENGTH = 20_000;

/**
 * What is stored. Every path that writes rich text goes through this, so no
 * HTML — safe or otherwise — ever reaches the database from this console.
 */
export function sanitizeRichTextMarkdown(input: string): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/\r\n?/gu, "\n")
    .replace(DANGEROUS_HTML, "")
    .replace(HTML_TAG, "")
    .replace(CONTROL_CHARACTERS, "")
    .normalize("NFC")
    .slice(0, RICH_TEXT_MAX_LENGTH);
}

/* ------------------------------------------------------------------------ */
/* Link policy — the client half of `sanitizeLinkUrl`                        */
/* ------------------------------------------------------------------------ */

const ALLOWED_LINK_PROTOCOLS: ReadonlySet<string> = new Set([
  "https:",
  "mailto:",
]);

const FRAGMENT = /^#[A-Za-z][A-Za-z0-9_:.-]*$/u;

/** Byte-for-byte the host rules `sanitizeLinkUrl` refuses. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/u.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4 === null) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * `null` means "not a link we will render". The caller then renders the link
 * *text* as ordinary prose — a rejected URL is never silently followed and
 * never silently dropped along with its label.
 */
export function safeLinkHref(raw: string): string | null {
  const candidate = raw.trim();
  if (candidate.length === 0 || candidate.length > 2048) return null;
  if (candidate.startsWith("#")) {
    return FRAGMENT.test(candidate) ? candidate : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.protocol === "https:" && isPrivateHost(parsed.hostname)) {
    return null;
  }
  return parsed.toString();
}

/* ------------------------------------------------------------------------ */
/* Block content mapping                                                     */
/* ------------------------------------------------------------------------ */

/** The stored shape of a `rich_text` block whose body is markdown. */
export function richTextBlockContent(
  markdown: string,
): { readonly text: string; readonly format: "markdown" } {
  return { text: sanitizeRichTextMarkdown(markdown), format: "markdown" };
}

/** True when a `rich_text` block's content declares the markdown format. */
export function isMarkdownBlockContent(
  content: Readonly<Record<string, unknown>>,
): boolean {
  return content.format === "markdown" && typeof content.text === "string";
}

/**
 * Reads markdown back out of stored content, sanitising again on the way in.
 * Content that arrived before this editor existed — or from any other writer —
 * is treated with exactly the same suspicion as fresh input.
 */
export function readRichTextMarkdown(
  content: Readonly<Record<string, unknown>>,
): string {
  const text = content.text;
  return typeof text === "string" ? sanitizeRichTextMarkdown(text) : "";
}

/* ------------------------------------------------------------------------ */
/* Inline parsing                                                            */
/* ------------------------------------------------------------------------ */

const ESCAPABLE = new Set(["*", "_", "`", "[", "]", "(", ")", "\\", "#", ">", "-"]);

type InlineOptions = {
  /** How many sources this answer cited. 0 disables `[n]` citation markers. */
  readonly citationCount: number;
  /** Guards against `[a](b)` recursion producing a link inside a link. */
  readonly allowLinks: boolean;
};

function text(value: string): RichTextNode {
  return { kind: "text", value };
}

function element(
  tag: RichTextTag,
  children: readonly RichTextNode[],
  extra: {
    readonly href?: string;
    readonly language?: string;
    readonly citation?: number;
  } = {},
): RichTextNode {
  return { kind: "element", tag, children, ...extra };
}

/** Collapses adjacent text nodes so the tree is stable and easy to assert. */
function compact(nodes: readonly RichTextNode[]): readonly RichTextNode[] {
  const out: RichTextNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (
      node.kind === "text" &&
      previous !== undefined &&
      previous.kind === "text"
    ) {
      out[out.length - 1] = text(previous.value + node.value);
      continue;
    }
    if (node.kind === "text" && node.value.length === 0) continue;
    out.push(node);
  }
  return out;
}

/**
 * Finds the closing run of `marker` starting at `from`, honouring backslash
 * escapes. Returns -1 when the emphasis is never closed, in which case the
 * opener is emitted as literal text rather than swallowing the rest of the line.
 */
function findClose(source: string, marker: string, from: number): number {
  let index = from;
  while (index <= source.length - marker.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

/**
 * The `)` that closes a link target, counting nesting so a URL or a refused
 * `javascript:alert(1)` payload does not leave a stray bracket in the prose.
 */
function findCloseParen(source: string, from: number): number {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function parseInline(
  source: string,
  options: InlineOptions,
): readonly RichTextNode[] {
  const out: RichTextNode[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(text(buffer));
      buffer = "";
    }
  };

  while (index < source.length) {
    const character = source[index] ?? "";

    // Backslash escape: the next character is literal, never a marker.
    if (character === "\\") {
      const next = source[index + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        buffer += next;
        index += 2;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // Inline code wins over every other marker and parses nothing inside it.
    if (character === "`") {
      const close = source.indexOf("`", index + 1);
      if (close > index + 1) {
        flush();
        out.push(element("code", [text(source.slice(index + 1, close))]));
        index = close + 1;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // Citation marker: `[3]` when the answer carries at least three sources.
    if (character === "[" && options.citationCount > 0) {
      const marker = /^\[(\d{1,3})\]/u.exec(source.slice(index));
      const ordinal = marker === null ? 0 : Number(marker[1]);
      if (
        marker !== null &&
        ordinal >= 1 &&
        ordinal <= options.citationCount
      ) {
        flush();
        out.push(
          element("sup", [text(String(ordinal))], { citation: ordinal }),
        );
        index += marker[0].length;
        continue;
      }
    }

    // Link: [label](url). A refused URL degrades to its label as plain prose.
    if (character === "[" && options.allowLinks) {
      const closeLabel = findClose(source, "]", index + 1);
      if (closeLabel !== -1 && source[closeLabel + 1] === "(") {
        const closeUrl = findCloseParen(source, closeLabel + 2);
        if (closeUrl !== -1) {
          const label = source.slice(index + 1, closeLabel);
          const href = safeLinkHref(source.slice(closeLabel + 2, closeUrl));
          const labelNodes = compact(
            parseInline(label, { ...options, allowLinks: false }),
          );
          flush();
          if (href === null) {
            out.push(...labelNodes);
          } else {
            out.push(
              element(
                "a",
                labelNodes.length > 0 ? labelNodes : [text(href)],
                { href },
              ),
            );
          }
          index = closeUrl + 1;
          continue;
        }
      }
    }

    // Strong before emphasis, so `**x**` is never read as `*` + `*x*`.
    const strongMarker =
      source.startsWith("**", index)
        ? "**"
        : source.startsWith("__", index)
          ? "__"
          : null;
    if (strongMarker !== null) {
      const close = findClose(source, strongMarker, index + 2);
      if (close === -1) {
        // Never closed: emit the marker literally rather than swallowing the
        // rest of the line into an emphasis the author did not write.
        buffer += strongMarker;
        index += 2;
        continue;
      }
      const inner = source.slice(index + 2, close);
      flush();
      out.push(element("strong", compact(parseInline(inner, options))));
      index = close + 2;
      continue;
    }

    if (character === "*" || character === "_") {
      const close = findClose(source, character, index + 1);
      if (close !== -1) {
        const inner = source.slice(index + 1, close);
        flush();
        out.push(element("em", compact(parseInline(inner, options))));
        index = close + 1;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    buffer += character;
    index += 1;
  }

  flush();
  return compact(out);
}

/**
 * A paragraph-ish run of lines. A single newline inside a paragraph becomes a
 * `<br>` rather than a space: authors typing into a textarea expect the break
 * they pressed to survive, and a lesson written that way currently loses it.
 */
function parseParagraphLines(
  lines: readonly string[],
  options: InlineOptions,
): readonly RichTextNode[] {
  const out: RichTextNode[] = [];
  lines.forEach((line, position) => {
    if (position > 0) out.push(element("br", []));
    out.push(...parseInline(line, options));
  });
  return compact(out);
}

/* ------------------------------------------------------------------------ */
/* Block parsing                                                             */
/* ------------------------------------------------------------------------ */

const HEADING = /^(#{1,6})\s+(.*)$/u;
const FENCE = /^```([A-Za-z0-9+#._-]{0,32})\s*$/u;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;

/** `#`→h2, `##`→h3, everything deeper→h4. `<h1>` belongs to the page. */
function headingTag(hashes: number): RichTextTag {
  if (hashes <= 1) return "h2";
  if (hashes === 2) return "h3";
  return "h4";
}

export type ParseOptions = {
  /**
   * Number of cited sources. When above zero, `[1]`…`[n]` in the prose become
   * `<sup>` citation references instead of literal brackets.
   */
  readonly citationCount?: number;
};

/**
 * Markdown in, allowlisted render plan out. Never throws: unparseable input
 * degrades to paragraphs of its own literal text.
 */
export function parseRichText(
  markdown: string,
  options: ParseOptions = {},
): RichTextDocument {
  const inline: InlineOptions = {
    citationCount: Math.max(0, Math.min(999, options.citationCount ?? 0)),
    allowLinks: true,
  };
  const lines = sanitizeRichTextMarkdown(markdown).split("\n");
  const out: RichTextNode[] = [];
  let index = 0;

  const isBlockStart = (line: string) =>
    HEADING.test(line) ||
    FENCE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line);

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const language = (fence[1] ?? "").trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      out.push(
        element("pre", [element("code", [text(code.join("\n"))])], {
          ...(language.length > 0 ? { language } : {}),
        }),
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push(element("hr", []));
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const body = (heading[2] ?? "").trim();
      out.push(
        element(headingTag((heading[1] ?? "#").length), parseInline(body, inline)),
      );
      index += 1;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line) && !BULLET.test(line);
      const pattern = ordered ? ORDERED : BULLET;
      const items: RichTextNode[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = pattern.exec(current);
        if (match === null) break;
        const itemLines = [match[1] ?? ""];
        index += 1;
        // Continuation lines: indented, non-blank, not the start of a new block.
        while (index < lines.length) {
          const next = lines[index] ?? "";
          if (next.trim().length === 0 || isBlockStart(next)) break;
          if (!/^\s{2,}/u.test(next)) break;
          itemLines.push(next.trim());
          index += 1;
        }
        items.push(element("li", parseParagraphLines(itemLines, inline)));
      }
      out.push(element(ordered ? "ol" : "ul", items));
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? "");
        if (match === null) break;
        quoted.push(match[1] ?? "");
        index += 1;
      }
      out.push(
        element("blockquote", [
          element("p", parseParagraphLines(quoted, inline)),
        ]),
      );
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim().length === 0 || isBlockStart(next)) break;
      paragraph.push(next);
      index += 1;
    }
    out.push(element("p", parseParagraphLines(paragraph, inline)));
  }

  return out;
}

/* ------------------------------------------------------------------------ */
/* Plain-text projection                                                     */
/* ------------------------------------------------------------------------ */

const BLOCK_LEVEL: ReadonlySet<RichTextTag> = new Set<RichTextTag>([
  "p",
  "h2",
  "h3",
  "h4",
  "li",
  "blockquote",
  "pre",
  "hr",
]);

/**
 * The document as prose, for row previews, `title` attributes and anywhere a
 * single line of text is what is actually wanted. Never returns markup.
 */
export function richTextToPlainText(nodes: RichTextDocument): string {
  const parts: string[] = [];
  const walk = (list: RichTextDocument) => {
    for (const node of list) {
      if (node.kind === "text") {
        parts.push(node.value);
        continue;
      }
      if (node.tag === "br") {
        parts.push("\n");
        continue;
      }
      walk(node.children);
      if (BLOCK_LEVEL.has(node.tag)) parts.push("\n");
    }
  };
  walk(nodes);
  return parts
    .join("")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Convenience: markdown straight to prose. */
export function markdownToPlainText(markdown: string): string {
  return richTextToPlainText(parseRichText(markdown));
}
