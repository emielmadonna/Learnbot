"use client";

import { useId, useRef } from "react";
import type { KeyboardEvent } from "react";

import styles from "./segmented-control.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

export type SegmentedControlOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
};

export type SegmentedControlProps = {
  /** Accessible name for the group. The control itself never renders a visible label. */
  readonly ariaLabel: string;
  readonly value: string;
  readonly options: readonly SegmentedControlOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
};

/**
 * Small, fixed choice of mutually exclusive options rendered as pills in a
 * recessed track. role="radiogroup" over role="radio" buttons with a roving
 * tabindex and arrow-key navigation, per the ARIA APG radio group pattern —
 * Tab enters/leaves the group once, arrow keys move the selection within it.
 */
export function SegmentedControl({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  id,
  className,
}: SegmentedControlProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-segmented`;
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = options.findIndex((option) => option.value === value);

  function moveFocus(nextIndex: number) {
    const option = options[nextIndex];
    if (option === undefined || option.disabled === true) return;
    onChange(option.value);
    segmentRefs.current[nextIndex]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled) return;
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % options.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + options.length) % options.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveFocus(nextIndex);
  }

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className={cx(tokens.uiRoot, styles.segmented, className)}
      id={controlId}
      role="radiogroup"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const focusable = selected || (selectedIndex === -1 && index === 0);
        return (
          <button
            aria-checked={selected}
            className={cx(styles.segment, selected && styles.active)}
            disabled={disabled || option.disabled === true}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(node) => {
              segmentRefs.current[index] = node;
            }}
            role="radio"
            tabIndex={focusable ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
