import { createElement, type ReactNode } from "react";

import { cx } from "../cx";
import tokens from "../tokens.module.css";
import {
  RICH_TEXT_TAGS,
  parseRichText,
  type RichTextDocument,
  type RichTextNode,
} from "./markdown";
import styles from "./rich-text.module.css";

/**
 * Renders a rich-text document.
 *
 * The security property this component exists to hold: **there is no HTML
 * string anywhere in it.** It walks the render plan `parseRichText` produced
 * and calls `createElement` with tags drawn from a closed allowlist, passing
 * every piece of author or model text as a React *child*, which React escapes.
 * `dangerouslySetInnerHTML` is not used, and could not be used without deleting
 * the parser, because the parser never produces markup to pass to it.
 *
 * The tag check below is redundant with the `RichTextTag` union — it exists so
 * the guarantee survives a future caller that hand-builds a node tree from
 * untyped data.
 */

export type RichTextProps = {
  /** Markdown as stored. Sanitised again on the way in by the parser. */
  readonly markdown: string;
  /**
   * How many sources accompany this text. Above zero, `[1]`…`[n]` in the prose
   * render as citation references pointing at `citationHrefPrefix`.
   */
  readonly citationCount?: number;
  /** Fragment prefix for citation references. Defaults to `#source-`. */
  readonly citationHrefPrefix?: string;
  readonly className?: string | undefined;
  /** Rendered instead of nothing when the document is empty. */
  readonly emptyFallback?: ReactNode;
};

function renderNode(
  node: RichTextNode,
  key: string,
  citationHrefPrefix: string,
): ReactNode {
  if (node.kind === "text") return node.value;
  if (!RICH_TEXT_TAGS.has(node.tag)) return node.children.length > 0 ? "" : null;

  const children = node.children.map((child, index) =>
    renderNode(child, `${key}.${index}`, citationHrefPrefix),
  );

  if (node.tag === "br" || node.tag === "hr") {
    return createElement(node.tag, { key });
  }

  if (node.tag === "a" && node.href !== undefined) {
    const external = !node.href.startsWith("#");
    return createElement(
      "a",
      {
        key,
        href: node.href,
        // Same-document links must not open a tab; outbound links must not
        // hand the opener over, and carry no implied endorsement.
        ...(external
          ? { target: "_blank", rel: "noopener noreferrer nofollow ugc" }
          : {}),
        className: styles.link,
      },
      children,
    );
  }

  if (node.tag === "sup" && node.citation !== undefined) {
    return createElement(
      "sup",
      { key, className: styles.citation },
      createElement(
        "a",
        {
          href: `${citationHrefPrefix}${node.citation}`,
          "aria-label": `Jump to source ${node.citation}`,
        },
        children,
      ),
    );
  }

  if (node.tag === "pre") {
    return createElement(
      "pre",
      {
        key,
        className: styles.code,
        ...(node.language === undefined
          ? {}
          : { "data-language": node.language }),
      },
      children,
    );
  }

  return createElement(node.tag, { key }, children);
}

export function renderRichTextDocument(
  document: RichTextDocument,
  citationHrefPrefix = "#source-",
): ReactNode[] {
  return document.map((node, index) =>
    renderNode(node, `n${index}`, citationHrefPrefix),
  );
}

export function RichText({
  markdown,
  citationCount = 0,
  citationHrefPrefix = "#source-",
  className,
  emptyFallback,
}: RichTextProps) {
  const document = parseRichText(markdown, { citationCount });
  if (document.length === 0) {
    return emptyFallback === undefined ? null : (
      <div className={cx(tokens.uiRoot, styles.prose, className)}>
        {emptyFallback}
      </div>
    );
  }
  return (
    <div className={cx(tokens.uiRoot, styles.prose, className)}>
      {renderRichTextDocument(document, citationHrefPrefix)}
    </div>
  );
}

/**
 * Text that must never be interpreted as formatting — a learner's own message,
 * a stored plain-format block. Line breaks survive through CSS; the string is
 * passed to React as a child and is therefore escaped, and nothing parses it,
 * so there is no syntax an author or a model could reach for.
 */
export function PlainText({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string | undefined;
}) {
  return (
    <div className={cx(tokens.uiRoot, className)}>
      <p className={styles.plainText}>{value}</p>
    </div>
  );
}

export default RichText;
