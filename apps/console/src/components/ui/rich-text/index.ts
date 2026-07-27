/**
 * Rich text for the console: one format, one sanitiser, one renderer.
 *
 * Deliberately **not** re-exported from `components/ui/index.ts`. That barrel
 * is the shared primitive surface and is edited by other work; this directory
 * is additive and imported by path:
 *
 * ```ts
 * import { MarkdownEditor, RichText } from "@/components/ui/rich-text";
 * ```
 *
 * See `markdown.ts` for the storage format, the sanitisation allowlist and the
 * link policy, and `markdown-editor.tsx` for why the editor is a markdown
 * textarea rather than a `contenteditable` surface.
 */

export { MarkdownEditor } from "./markdown-editor";
export type { MarkdownEditorProps } from "./markdown-editor";

export { PlainText, RichText, renderRichTextDocument } from "./rich-text";
export type { RichTextProps } from "./rich-text";

export { LearningBlockView, learningBlockPreview } from "./learning-block";
export type { LearningBlockViewProps } from "./learning-block";

export {
  RICH_TEXT_MAX_LENGTH,
  RICH_TEXT_TAGS,
  isMarkdownBlockContent,
  markdownToPlainText,
  parseRichText,
  readRichTextMarkdown,
  richTextBlockContent,
  richTextToPlainText,
  safeLinkHref,
  sanitizeRichTextMarkdown,
} from "./markdown";
export type {
  ParseOptions,
  RichTextDocument,
  RichTextNode,
  RichTextTag,
} from "./markdown";

export {
  LINK_PLACEHOLDER_URL,
  applyRichTextCommand,
  continueBlockOnEnter,
} from "./commands";
export type { EditorState, RichTextCommand } from "./commands";
