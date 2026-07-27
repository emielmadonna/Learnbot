"use client";

import { useEffect, useId, useRef } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import styles from "./panel-frame.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

export type PanelSide = "right" | "left" | "inline";

export type PanelFrameProps = {
  readonly title: string;
  readonly eyebrow?: string | undefined;
  readonly description?: string | undefined;
  readonly children: ReactNode;
  /** Rendered right-aligned in the sticky footer. Usually Buttons. */
  readonly footer?: ReactNode | undefined;
  /** Rendered left-aligned in the footer — save state, last-published stamps. */
  readonly footerLead?: ReactNode | undefined;
  /** Extra controls beside the close button. */
  readonly headerActions?: ReactNode | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly closeLabel?: string | undefined;
  /** Slide-in edge, or "inline" to sit in the page flow. Defaults to "right". */
  readonly side?: PanelSide | undefined;
  /** CSS width for the slide-in variants. Ignored when side is "inline". */
  readonly width?: string | undefined;
  /** Traps focus and marks the dialog modal. Off by default. */
  readonly modal?: boolean | undefined;
  /** Moves focus into the panel on mount. Defaults to true. */
  readonly autoFocus?: boolean | undefined;
  readonly className?: string | undefined;
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Standard panel chrome: title block, close affordance, one scrolling body and
 * a sticky action footer. Positioning and open/closed state stay with the
 * caller; this component only owns the chrome and its keyboard behaviour.
 */
export function PanelFrame({
  title,
  eyebrow,
  description,
  children,
  footer,
  footerLead,
  headerActions,
  onClose,
  closeLabel = "Close panel",
  side = "right",
  width,
  modal = false,
  autoFocus = true,
  className,
}: PanelFrameProps) {
  const generated = useId();
  const titleId = `${generated}-title`;
  const descriptionId = `${generated}-description`;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, [autoFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && onClose !== undefined) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !modal) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((element) => element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      aria-describedby={description === undefined ? undefined : descriptionId}
      aria-labelledby={titleId}
      aria-modal={modal || undefined}
      className={cx(tokens.uiRoot, styles.panel, styles[side], className)}
      onKeyDown={onKeyDown}
      ref={panelRef}
      role="dialog"
      style={
        side === "inline" || width === undefined
          ? undefined
          : ({ "--panel-width": width } as CSSProperties)
      }
      tabIndex={-1}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          {eyebrow !== undefined && <p className={styles.eyebrow}>{eyebrow}</p>}
          <h2 className={styles.title} id={titleId}>
            {title}
          </h2>
          {description !== undefined && (
            <p className={styles.description} id={descriptionId}>
              {description}
            </p>
          )}
        </div>
        <div className={styles.headerActions}>
          {headerActions}
          {onClose !== undefined && (
            <button
              aria-label={closeLabel}
              className={styles.close}
              onClick={onClose}
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                height="14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="14"
              >
                <path d="m6 6 12 12" />
                <path d="m18 6-12 12" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <div className={styles.body}>{children}</div>

      {(footer !== undefined || footerLead !== undefined) && (
        <footer className={styles.footer}>
          {footerLead !== undefined && (
            <div className={styles.footerLead}>{footerLead}</div>
          )}
          {footer}
        </footer>
      )}
    </div>
  );
}

export default PanelFrame;
