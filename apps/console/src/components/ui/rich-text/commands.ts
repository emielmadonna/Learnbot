/**
 * The editing model behind the rich-text toolbar.
 *
 * Every command is a pure function of `(value, selectionStart, selectionEnd)`
 * to a new `(value, selectionStart, selectionEnd)`. Nothing here touches the
 * DOM, `document.execCommand`, `contenteditable` or React — which is what makes
 * the toolbar testable, undoable through the browser's own textarea history,
 * and identical whether it was reached by pointer or by keyboard.
 *
 * Commands are toggles: applying one to text that already carries it removes
 * it. That is what makes a toolbar feel like a toolbar rather than a set of
 * "insert some syntax" buttons.
 */

export type RichTextCommand =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberedList"
  | "quote"
  | "codeBlock";

export type EditorState = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

/* ------------------------------------------------------------------------ */
/* Inline wrapping                                                           */
/* ------------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalize(state: EditorState): EditorState {
  const start = clamp(
    Math.min(state.selectionStart, state.selectionEnd),
    0,
    state.value.length,
  );
  const end = clamp(
    Math.max(state.selectionStart, state.selectionEnd),
    start,
    state.value.length,
  );
  return { value: state.value, selectionStart: start, selectionEnd: end };
}

/**
 * Wraps or unwraps the selection in `marker`. Handles the two ways a selection
 * can already be marked: the markers inside the selection (`**bold**` selected
 * whole) and the markers just outside it (`bold` selected within `**bold**`).
 */
function toggleWrap(
  state: EditorState,
  marker: string,
  placeholder: string,
): EditorState {
  const { value, selectionStart, selectionEnd } = normalize(state);
  const selected = value.slice(selectionStart, selectionEnd);
  const width = marker.length;

  if (
    selected.length >= width * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(width, selected.length - width);
    return {
      value: value.slice(0, selectionStart) + inner + value.slice(selectionEnd),
      selectionStart,
      selectionEnd: selectionStart + inner.length,
    };
  }

  const before = value.slice(Math.max(0, selectionStart - width), selectionStart);
  const after = value.slice(selectionEnd, selectionEnd + width);
  if (before === marker && after === marker) {
    return {
      value:
        value.slice(0, selectionStart - width) +
        selected +
        value.slice(selectionEnd + width),
      selectionStart: selectionStart - width,
      selectionEnd: selectionEnd - width,
    };
  }

  const body = selected.length > 0 ? selected : placeholder;
  return {
    value:
      value.slice(0, selectionStart) +
      marker +
      body +
      marker +
      value.slice(selectionEnd),
    selectionStart: selectionStart + width,
    selectionEnd: selectionStart + width + body.length,
  };
}

/* ------------------------------------------------------------------------ */
/* Line prefixes                                                             */
/* ------------------------------------------------------------------------ */

/** Expands a selection to whole lines, which is what a block command acts on. */
function lineRange(state: EditorState) {
  const { value, selectionStart, selectionEnd } = normalize(state);
  const start = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const lineEnd = value.indexOf("\n", selectionEnd);
  const end = lineEnd === -1 ? value.length : lineEnd;
  return { start, end, lines: value.slice(start, end).split("\n") };
}

function replaceLines(
  state: EditorState,
  start: number,
  end: number,
  lines: readonly string[],
): EditorState {
  const replacement = lines.join("\n");
  return {
    value: state.value.slice(0, start) + replacement + state.value.slice(end),
    selectionStart: start,
    selectionEnd: start + replacement.length,
  };
}

const BULLET_PREFIX = /^\s{0,3}[-*+]\s+/u;
const ORDERED_PREFIX = /^\s{0,3}\d{1,9}[.)]\s+/u;
const QUOTE_PREFIX = /^\s{0,3}>\s?/u;
const HEADING_PREFIX = /^\s{0,3}#{1,6}\s+/u;

/** Strips whichever block prefix a line already carries, so they never stack. */
function stripBlockPrefix(line: string) {
  return line
    .replace(HEADING_PREFIX, "")
    .replace(BULLET_PREFIX, "")
    .replace(ORDERED_PREFIX, "")
    .replace(QUOTE_PREFIX, "");
}

function toggleLinePrefix(
  state: EditorState,
  test: RegExp,
  prefix: (index: number) => string,
): EditorState {
  const { start, end, lines } = lineRange(state);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const alreadyApplied =
    nonEmpty.length > 0 && nonEmpty.every((line) => test.test(line));
  const next = lines.map((line, index) =>
    alreadyApplied
      ? stripBlockPrefix(line)
      : prefix(index) + stripBlockPrefix(line),
  );
  return replaceLines(state, start, end, next);
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The URL a fresh link is seeded with. `https://` is pre-selected so the very
 * next keystroke replaces it — and it is already inside the allowed protocol
 * set, so a half-typed link never renders as an anchor to somewhere unexpected.
 */
export const LINK_PLACEHOLDER_URL = "https://";

export function applyRichTextCommand(
  state: EditorState,
  command: RichTextCommand,
): EditorState {
  const current = normalize(state);

  switch (command) {
    case "bold":
      return toggleWrap(current, "**", "bold text");
    case "italic":
      return toggleWrap(current, "*", "italic text");
    case "code":
      return toggleWrap(current, "`", "code");

    case "link": {
      const { value, selectionStart, selectionEnd } = current;
      const label =
        selectionStart === selectionEnd
          ? "link text"
          : value.slice(selectionStart, selectionEnd);
      const inserted = `[${label}](${LINK_PLACEHOLDER_URL})`;
      // Caret lands on the placeholder URL: the author's next keystroke is the
      // destination, not a hunt through brackets.
      const urlStart = selectionStart + label.length + 3;
      return {
        value:
          value.slice(0, selectionStart) + inserted + value.slice(selectionEnd),
        selectionStart: urlStart,
        selectionEnd: urlStart + LINK_PLACEHOLDER_URL.length,
      };
    }

    // Named for the level they *render* as. `#` is the top authorable level:
    // `<h1>` belongs to the page, not to a lesson block.
    case "heading2":
      return toggleLinePrefix(current, /^\s{0,3}#\s+/u, () => "# ");
    case "heading3":
      return toggleLinePrefix(current, /^\s{0,3}##\s+/u, () => "## ");
    case "bulletList":
      return toggleLinePrefix(current, BULLET_PREFIX, () => "- ");
    case "numberedList":
      return toggleLinePrefix(
        current,
        ORDERED_PREFIX,
        (index) => `${index + 1}. `,
      );
    case "quote":
      return toggleLinePrefix(current, QUOTE_PREFIX, () => "> ");

    case "codeBlock": {
      const { start, end, lines } = lineRange(current);
      const fenced =
        lines.length >= 2 &&
        /^```/u.test(lines[0] ?? "") &&
        /^```\s*$/u.test(lines[lines.length - 1] ?? "");
      const next = fenced ? lines.slice(1, -1) : ["```", ...lines, "```"];
      return replaceLines(current, start, end, next);
    }

    default:
      return current;
  }
}

/* ------------------------------------------------------------------------ */
/* Enter continuation                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Pressing Enter inside a list or quote continues it, and pressing Enter on an
 * empty item ends it — the behaviour every editor has, without which a list is
 * a chore to type. Returns `null` when Enter should do its normal thing.
 */
export function continueBlockOnEnter(state: EditorState): EditorState | null {
  const { value, selectionStart, selectionEnd } = normalize(state);
  if (selectionStart !== selectionEnd) return null;

  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const line = value.slice(lineStart, selectionStart);

  const ordered = ORDERED_PREFIX.exec(line);
  const bullet = BULLET_PREFIX.exec(line);
  const quote = QUOTE_PREFIX.exec(line);
  const match = ordered ?? bullet ?? quote;
  if (match === null) return null;

  const marker = match[0];
  // An empty item: Enter clears the marker instead of adding another one.
  if (line.trim() === marker.trim()) {
    return {
      value: value.slice(0, lineStart) + value.slice(selectionStart),
      selectionStart: lineStart,
      selectionEnd: lineStart,
    };
  }

  const next =
    ordered === null
      ? marker
      : `${Number(marker.replace(/\D/gu, "")) + 1}${
          marker.includes(")") ? ") " : ". "
        }`;
  const insertion = `\n${next}`;
  return {
    value:
      value.slice(0, selectionStart) + insertion + value.slice(selectionEnd),
    selectionStart: selectionStart + insertion.length,
    selectionEnd: selectionStart + insertion.length,
  };
}
