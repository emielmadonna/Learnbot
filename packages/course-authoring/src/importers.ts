import type { ContentBlock, RichTextSpan } from "@course-ai/contracts";
import { deterministicId } from "./ids.js";
import { sanitizeHtmlToPlainText } from "./sanitizer.js";
import type { ImportedBlocks } from "./types.js";

function span(text: string): readonly RichTextSpan[] {
  return [{ text: sanitizeHtmlToPlainText(text) }];
}

function blockId(namespace: string, index: number, value: unknown): string {
  return deterministicId("block", namespace, index, value);
}

export function importPlainText(input: string, namespace: string): ImportedBlocks {
  const clean = sanitizeHtmlToPlainText(input);
  const paragraphs = clean
    .split(/\n\s*\n/gu)
    .map((value) => value.replace(/\s*\n\s*/gu, " ").trim())
    .filter(Boolean);
  const blocks: ContentBlock[] = paragraphs.map((text, index) => ({
    id: blockId(namespace, index, text),
    type: "paragraph",
    content: span(text),
  }));
  return {
    blocks,
    warnings: blocks.length === 0 ? ["No importable text was found."] : [],
  };
}

export function importMarkdown(input: string, namespace: string): ImportedBlocks {
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ContentBlock[] = [];
  const warnings: string[] = [];
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let codeLanguage: string | undefined;
  let list: { style: "bullet" | "numbered"; items: string[] } | undefined;

  const push = (withoutList = false): void => {
    if (paragraph.length > 0) {
      const text = paragraph.join(" ").trim();
      if (text) {
        blocks.push({
          id: blockId(namespace, blocks.length, text),
          type: "paragraph",
          content: span(text),
        });
      }
      paragraph = [];
    }
    if (!withoutList && list) {
      const value = list;
      blocks.push({
        id: blockId(namespace, blocks.length, value),
        type: "list",
        style: value.style,
        items: value.items.map((text, index) => ({
          id: deterministicId("list-item", namespace, `${blocks.length}:${index}`, text),
          content: span(text),
        })),
      });
      list = undefined;
    }
  };

  for (const line of lines) {
    if (code) {
      if (/^```/u.test(line)) {
        const body = code.join("\n");
        blocks.push({
          id: blockId(namespace, blocks.length, body),
          type: "code",
          code: body,
          ...(codeLanguage ? { language: sanitizeHtmlToPlainText(codeLanguage) } : {}),
        });
        code = undefined;
        codeLanguage = undefined;
      } else {
        code.push(line);
      }
      continue;
    }
    const fence = line.match(/^```([\w.+-]*)\s*$/u);
    if (fence) {
      push();
      code = [];
      codeLanguage = fence[1] || undefined;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      push();
      const text = heading[2] ?? "";
      blocks.push({
        id: blockId(namespace, blocks.length, { heading: text }),
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4,
        content: span(text),
      });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/u);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/u);
    if (bullet || numbered) {
      push(true);
      const style = bullet ? "bullet" : "numbered";
      const text = (bullet?.[1] ?? numbered?.[1] ?? "").trim();
      if (list && list.style !== style) push();
      list ??= { style, items: [] };
      list.items.push(text);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      push();
      const text = quote[1] ?? "";
      blocks.push({
        id: blockId(namespace, blocks.length, { quote: text }),
        type: "quote",
        content: span(text),
      });
      continue;
    }
    if (line.trim() === "") {
      push();
    } else {
      paragraph.push(line.trim());
    }
  }
  if (code) {
    warnings.push("An unclosed code fence was imported as a code block.");
    const body = code.join("\n");
    blocks.push({
      id: blockId(namespace, blocks.length, body),
      type: "code",
      code: body,
      ...(codeLanguage ? { language: sanitizeHtmlToPlainText(codeLanguage) } : {}),
    });
  }
  push();
  if (blocks.length === 0) warnings.push("No importable Markdown was found.");
  return { blocks, warnings };
}
