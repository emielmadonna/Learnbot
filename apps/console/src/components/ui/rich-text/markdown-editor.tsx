"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { cx } from "../cx";
import tokens from "../tokens.module.css";
import {
  applyRichTextCommand,
  continueBlockOnEnter,
  type EditorState,
  type RichTextCommand,
} from "./commands";
import { RICH_TEXT_MAX_LENGTH } from "./markdown";
import { RichText } from "./rich-text";
import styles from "./markdown-editor.module.css";

/**
 * ## Why a markdown textarea and not a contenteditable surface
 *
 * The brief allowed either. This is a textarea with an explicit-range command
 * model and a live preview, for four reasons that all point the same way:
 *
 * 1. **Accessibility.** `<textarea>` is a native, fully supported form control:
 *    every screen reader announces it correctly, every browser gives it real
 *    caret navigation, selection, spellcheck and — critically — native undo /
 *    redo. A `contenteditable` region has to reimplement all of that, and the
 *    accessible-name, caret-restoration and IME behaviour of a hand-rolled one
 *    is where rich-text editors most often quietly break for assistive tech.
 * 2. **No dependency budget.** A correct `contenteditable` editor needs a
 *    document model, selection mapping and input-event normalisation across
 *    browsers — the reason TipTap/ProseMirror/Slate exist. Without one of them
 *    the honest options were "markdown textarea" or "a broken editor".
 * 3. **The stored value is visible.** The author can always see exactly what is
 *    saved. There is no hidden HTML that "looks fine" but round-trips wrong.
 * 4. **The command model is pure and tested.** Every button is a pure function
 *    over `(value, selectionStart, selectionEnd)` — see `commands.ts` — so
 *    keyboard and pointer paths are literally the same code.
 *
 * The toolbar is a real ARIA toolbar with roving tab focus: one Tab stop, then
 * arrow keys between buttons, so a keyboard user never has to page through ten
 * controls to reach the text.
 */

type ToolbarItem = {
  readonly command: RichTextCommand;
  readonly label: string;
  readonly glyph: string;
  readonly shortcut?: string;
};

const TOOLBAR: readonly ToolbarItem[] = [
  { command: "bold", label: "Bold", glyph: "B", shortcut: "Meta+B" },
  { command: "italic", label: "Italic", glyph: "I", shortcut: "Meta+I" },
  { command: "code", label: "Inline code", glyph: "‹›" },
  { command: "link", label: "Link", glyph: "🔗", shortcut: "Meta+K" },
  { command: "heading2", label: "Heading", glyph: "H2" },
  { command: "heading3", label: "Subheading", glyph: "H3" },
  { command: "bulletList", label: "Bulleted list", glyph: "•—" },
  { command: "numberedList", label: "Numbered list", glyph: "1." },
  { command: "quote", label: "Quote", glyph: "❝" },
  { command: "codeBlock", label: "Code block", glyph: "{ }" },
];

export type MarkdownEditorProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (markdown: string) => void;
  readonly help?: string | undefined;
  readonly disabled?: boolean;
  readonly rows?: number;
  readonly maxLength?: number;
  readonly className?: string | undefined;
};

export function MarkdownEditor({
  label,
  value,
  onChange,
  help,
  disabled = false,
  rows = 8,
  maxLength = RICH_TEXT_MAX_LENGTH,
  className,
}: MarkdownEditorProps) {
  const baseId = useId();
  const textareaId = `${baseId}-input`;
  const helpId = `${baseId}-help`;
  const previewId = `${baseId}-preview`;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<readonly [number, number] | null>(null);
  const [focusedButton, setFocusedButton] = useState(0);
  const [showPreview, setShowPreview] = useState(false);

  // A command changes the value and the selection together. React owns the
  // value, so the caret is restored after the controlled re-render — otherwise
  // it would jump to the end and every second click would land in the wrong
  // place.
  useEffect(() => {
    const pending = pendingSelection.current;
    const textarea = textareaRef.current;
    if (pending === null || textarea === null) return;
    pendingSelection.current = null;
    textarea.setSelectionRange(pending[0], pending[1]);
    textarea.focus();
  }, [value]);

  const currentState = useCallback((): EditorState => {
    const textarea = textareaRef.current;
    return {
      value,
      selectionStart: textarea?.selectionStart ?? value.length,
      selectionEnd: textarea?.selectionEnd ?? value.length,
    };
  }, [value]);

  const commit = useCallback(
    (next: EditorState) => {
      pendingSelection.current = [next.selectionStart, next.selectionEnd];
      onChange(next.value.slice(0, maxLength));
    },
    [maxLength, onChange],
  );

  const run = useCallback(
    (command: RichTextCommand) => {
      if (disabled) return;
      commit(applyRichTextCommand(currentState(), command));
    },
    [commit, currentState, disabled],
  );

  function onTextareaKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const accel = event.metaKey || event.ctrlKey;
    if (accel && !event.altKey) {
      const key = event.key.toLowerCase();
      const shortcut: Partial<Record<string, RichTextCommand>> = {
        b: "bold",
        i: "italic",
        k: "link",
      };
      const command = shortcut[key];
      if (command !== undefined) {
        event.preventDefault();
        run(command);
        return;
      }
    }
    if (event.key === "Enter" && !accel && !event.shiftKey) {
      const continued = continueBlockOnEnter(currentState());
      if (continued !== null) {
        event.preventDefault();
        commit(continued);
      }
    }
  }

  /** Roving tab focus: the toolbar is one Tab stop, arrows move within it. */
  function onToolbarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const last = TOOLBAR.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = focusedButton >= last ? 0 : focusedButton + 1;
    if (event.key === "ArrowLeft") next = focusedButton <= 0 ? last : focusedButton - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    setFocusedButton(next);
    const item = TOOLBAR[next];
    if (item === undefined) return;
    document.getElementById(`${baseId}-${item.command}`)?.focus();
  }

  return (
    <div className={cx(tokens.uiRoot, styles.editor, className)}>
      <div className={styles.head}>
        <label className={styles.label} htmlFor={textareaId}>
          {label}
        </label>
        <button
          aria-controls={previewId}
          aria-expanded={showPreview}
          className={styles.previewToggle}
          disabled={disabled}
          onClick={() => setShowPreview((open) => !open)}
          type="button"
        >
          {showPreview ? "Hide preview" : "Preview"}
        </button>
      </div>

      <div
        aria-controls={textareaId}
        aria-label={`Formatting for ${label}`}
        className={styles.toolbar}
        onKeyDown={onToolbarKeyDown}
        role="toolbar"
      >
        {TOOLBAR.map((item, index) => (
          <button
            className={styles.tool}
            disabled={disabled}
            id={`${baseId}-${item.command}`}
            key={item.command}
            onClick={() => run(item.command)}
            onFocus={() => setFocusedButton(index)}
            tabIndex={index === focusedButton ? 0 : -1}
            title={
              item.shortcut === undefined
                ? item.label
                : `${item.label} (${item.shortcut.replace("Meta", "⌘/Ctrl")})`
            }
            type="button"
            {...(item.shortcut === undefined
              ? {}
              : { "aria-keyshortcuts": item.shortcut })}
          >
            <span aria-hidden="true" className={styles.glyph}>
              {item.glyph}
            </span>
            <span className={styles.srOnly}>{item.label}</span>
          </button>
        ))}
      </div>

      <textarea
        aria-describedby={helpId}
        className={styles.input}
        disabled={disabled}
        id={textareaId}
        maxLength={maxLength}
        /**
         * Typing is not sanitised keystroke-by-keystroke: rewriting the value
         * mid-composition breaks IME and dead-key input, and moves the caret.
         * Sanitisation happens where it matters and cannot be skipped — on
         * write (`richTextBlockContent`) and again on render (`parseRichText`).
         */
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onTextareaKeyDown}
        ref={textareaRef}
        rows={rows}
        spellCheck
        value={value}
      />

      <p className={styles.help} id={helpId}>
        {help === undefined ? "" : `${help} `}
        Formatting is markdown: <code>**bold**</code>, <code>*italic*</code>,{" "}
        <code>`code`</code>, <code>## heading</code>, <code>- list</code>,{" "}
        <code>&gt; quote</code>, <code>[label](https://…)</code>. ⌘/Ctrl+B, I and
        K apply bold, italic and a link. Only <code>https:</code> and{" "}
        <code>mailto:</code> links are rendered; anything else stays as plain
        text.
      </p>

      {showPreview ? (
        <div
          aria-label={`Formatted preview of ${label}`}
          className={styles.preview}
          id={previewId}
          role="group"
        >
          <RichText
            emptyFallback={
              <p className={styles.previewEmpty}>Nothing to preview yet.</p>
            }
            markdown={value}
          />
        </div>
      ) : null}
    </div>
  );
}

export default MarkdownEditor;
