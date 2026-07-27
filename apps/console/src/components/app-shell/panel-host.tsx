"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PanelKey, ShellPayload } from "./contract";
import { panelRegistry } from "./panel-registry";
import { DataVersionProvider } from "./shell-data";
import styles from "./shell.module.css";

const EXIT_MS = 220;

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hasAttribute("aria-hidden") &&
      element.offsetParent !== null,
  );
}

export type PanelHostProps = {
  payload: ShellPayload;
  activePanel: PanelKey | null;
  params: URLSearchParams;
  /** Person-initiated close: leaves a history entry, so Back re-opens. */
  onClose: () => void;
  /** Drop an unusable `?panel=` without adding a history entry. */
  onDiscard?: () => void;
};

/**
 * Renders the panel named by `?panel=`. One dialog at a time, animated in from
 * the trailing edge, with a focus trap, Escape-to-close, background scroll lock
 * and restored focus on exit.
 *
 * Which panel is open is a pure function of the URL — `open` below is derived,
 * never stored — so a cold load of `/app?panel=agent` renders the open panel in
 * its very first commit, exactly like a click does. The entrance is a CSS
 * animation rather than a transition out of a stored "closed" state, precisely
 * so that no frame of client state has to elapse before the panel is on screen.
 * The only state here is `exiting`, which keeps a *closed* panel mounted long
 * enough to animate away; it can never keep an open one shut.
 */
export function PanelHost({
  payload,
  activePanel,
  params,
  onClose,
  onDiscard,
}: PanelHostProps) {
  const router = useRouter();
  const titleId = useId();
  const subtitleId = useId();

  // A panel is only permitted if the server said this role may see it.
  const requested =
    activePanel !== null && payload.sections[activePanel] === true
      ? activePanel
      : null;

  // Unknown keys and keys this role may not see are both "not a panel". Either
  // way the parameter must not linger in the URL, and cleaning it up is not a
  // navigation the person made, so it replaces rather than pushes: Back still
  // leads where they came from instead of back into the broken address.
  const stray = requested === null && params.get("panel") !== null;

  const [exiting, setExiting] = useState<PanelKey | null>(null);
  const previousRef = useRef<PanelKey | null>(requested);

  const panelRef = useRef<HTMLElement | null>(null);

  const rendered = requested ?? exiting;
  const open = requested !== null;

  useEffect(() => {
    if (!stray) return;
    (onDiscard ?? onClose)();
  }, [stray, onDiscard, onClose]);

  // Hold the outgoing panel on screen for one exit animation.
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = requested;
    if (requested !== null) {
      setExiting(null);
      return;
    }
    if (previous === null) return;
    setExiting(previous);
    const timer = setTimeout(() => setExiting(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [requested]);

  // Background scroll lock while a panel is on screen.
  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, [open]);

  // Remember and restore the trigger element. On a deep link there is no
  // trigger — focus is on the document — and nothing is restored on close.
  useEffect(() => {
    if (!open) return;
    const trigger =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    return () => {
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  // Move focus into the panel once it exists.
  useEffect(() => {
    if (!open) return;
    const root = panelRef.current;
    if (!root) return;
    const [first] = focusableWithin(root);
    (first ?? root).focus();
  }, [open, requested]);

  // Escape closes; Tab cycles inside the dialog.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = focusableWithin(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  const [dataVersion, setDataVersion] = useState(0);
  const refresh = useCallback(async () => {
    setDataVersion((value) => value + 1);
    router.refresh();
  }, [router]);

  if (!rendered) return null;

  const definition = panelRegistry[rendered];
  const PanelComponent = definition.component;

  return (
    <div className={styles.panelLayer} data-open={open || undefined}>
      <div className={styles.panelScrim} onClick={onClose} aria-hidden="true" />
      <section
        className={styles.panel}
        data-size={definition.size}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle} id={titleId}>
              {definition.title}
            </h2>
            <p className={styles.panelSubtitle} id={subtitleId}>
              {definition.subtitle}
            </p>
          </div>
          <button
            className={styles.panelClose}
            type="button"
            onClick={onClose}
            aria-label={`Close ${definition.title}`}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className={styles.panelBody}>
          <DataVersionProvider value={dataVersion}>
            <PanelComponent
              payload={payload}
              params={params}
              close={onClose}
              refresh={refresh}
            />
          </DataVersionProvider>
        </div>
      </section>
    </div>
  );
}

export default PanelHost;
