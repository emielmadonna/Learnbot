import type { ReactNode } from "react";

import { cx } from "../cx";
import tokens from "../tokens.module.css";
import {
  isMarkdownBlockContent,
  markdownToPlainText,
  readRichTextMarkdown,
} from "./markdown";
import { RichText } from "./rich-text";
import styles from "./learning-block.module.css";

/**
 * The learner-facing rendering of one authored content block.
 *
 * Until now a block was shown as one truncated line of `content.text`, so a
 * heading, a callout, a code sample and a bulleted list all arrived as the same
 * grey paragraph — and a `rich_text` block's markdown was displayed with its
 * asterisks showing. This renders each block as what it is.
 *
 * Every string it touches is rendered as a React *child*, never as markup:
 * plain-text block types are printed with `white-space: pre-wrap` so authored
 * line breaks survive without any parsing at all, and `rich_text` markdown goes
 * through `RichText`, whose allowlisted render plan is the only path from
 * stored text to elements.
 */

export type LearningBlockViewProps = {
  /** Block type as stored: rich_text | heading | callout | code | quote | list | divider. */
  readonly type: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly className?: string | undefined;
};

function textOf(content: Readonly<Record<string, unknown>>): string {
  return typeof content.text === "string" ? content.text : "";
}

function itemsOf(content: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(content.items)
    ? content.items.filter((item): item is string => typeof item === "string")
    : [];
}

const CALLOUT_TONE: Readonly<Record<string, string>> = {
  note: "toneNote",
  info: "toneNote",
  tip: "tonePositive",
  success: "tonePositive",
  example: "toneNote",
  warning: "toneWarning",
};

/** A single line of prose describing a block, for collapsed rows and previews. */
export function learningBlockPreview(
  type: string,
  content: Readonly<Record<string, unknown>>,
): string {
  if (type === "divider") return "— divider —";
  if (type === "list") {
    const items = itemsOf(content);
    if (items.length > 0) return items.map((item) => `• ${item}`).join("\n");
  }
  if (type === "rich_text" && isMarkdownBlockContent(content)) {
    return markdownToPlainText(readRichTextMarkdown(content));
  }
  const text = textOf(content);
  if (text.length > 0) return text;
  const markdown = content.markdown;
  if (typeof markdown === "string") return markdownToPlainText(markdown);
  return "";
}

export function LearningBlockView({
  type,
  content,
  className,
}: LearningBlockViewProps) {
  const root = (children: ReactNode) => (
    <div className={cx(tokens.uiRoot, styles.block, className)}>{children}</div>
  );

  if (type === "divider") {
    return root(<hr className={styles.divider} />);
  }

  if (type === "heading") {
    const level = typeof content.level === "number" ? content.level : 2;
    const body = textOf(content);
    // Lesson bodies already sit under the module's <h4>, so an authored
    // heading is announced at level 5 or 6 rather than jumping back up.
    return root(
      <p
        aria-level={Math.min(6, Math.max(5, level + 3))}
        className={cx(styles.heading, level >= 3 && styles.headingSmall)}
        role="heading"
      >
        {body}
      </p>,
    );
  }

  if (type === "callout") {
    const tone = typeof content.tone === "string" ? content.tone : "note";
    const toneClass = styles[CALLOUT_TONE[tone] ?? "toneNote"];
    return root(
      <aside className={cx(styles.callout, toneClass)}>
        <span className={styles.calloutTone}>{tone}</span>
        <p className={styles.plain}>{textOf(content)}</p>
      </aside>,
    );
  }

  if (type === "code") {
    const language =
      typeof content.language === "string" && content.language.trim().length > 0
        ? content.language.trim()
        : undefined;
    return root(
      <pre
        className={styles.code}
        {...(language === undefined ? {} : { "data-language": language })}
      >
        <code>{textOf(content)}</code>
      </pre>,
    );
  }

  if (type === "quote") {
    const attribution =
      typeof content.attribution === "string" &&
      content.attribution.trim().length > 0
        ? content.attribution.trim()
        : null;
    return root(
      <blockquote className={styles.quote}>
        <p className={styles.plain}>{textOf(content)}</p>
        {attribution === null ? null : (
          <footer className={styles.attribution}>— {attribution}</footer>
        )}
      </blockquote>,
    );
  }

  if (type === "list") {
    const items = itemsOf(content);
    const ordered = content.style === "numbered";
    if (items.length === 0) {
      return root(<p className={styles.empty}>This list has no items.</p>);
    }
    const listItems = items.map((item, index) => (
      <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
    ));
    return root(
      ordered ? (
        <ol className={styles.list}>{listItems}</ol>
      ) : (
        <ul className={styles.list}>{listItems}</ul>
      ),
    );
  }

  // rich_text, and anything this console does not recognise.
  if (isMarkdownBlockContent(content)) {
    return (
      <RichText
        className={cx(styles.block, className)}
        emptyFallback={<p className={styles.empty}>This block is empty.</p>}
        markdown={readRichTextMarkdown(content)}
      />
    );
  }

  const plain = textOf(content);
  if (plain.length === 0) {
    const preview = learningBlockPreview(type, content);
    return root(
      <p className={preview.length === 0 ? styles.empty : styles.plain}>
        {preview.length === 0 ? "This block is empty." : preview}
      </p>,
    );
  }
  // Plain-format text: authored line breaks are preserved by CSS, not by any
  // parsing, so nothing in it can be interpreted as formatting or as markup.
  return root(<p className={styles.plain}>{plain}</p>);
}

export default LearningBlockView;
