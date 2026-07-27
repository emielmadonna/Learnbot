"use client";

import { useId } from "react";

import styles from "./toggle.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

export type ToggleProps = {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** What turning this on or off actually changes. */
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** Keeps the name for assistive tech but hides the visible text. */
  readonly hideLabel?: boolean | undefined;
  /** Draws a divider underneath, for stacked lists of switches. */
  readonly bordered?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
};

/**
 * Accessible switch for enabling and disabling a section.
 * Rendered as a native button with role="switch", so Space and Enter both work.
 */
export function Toggle({
  label,
  checked,
  onChange,
  description,
  disabled = false,
  hideLabel = false,
  bordered = false,
  id,
  className,
}: ToggleProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-toggle`;
  const labelId = `${controlId}-label`;
  const descriptionId = `${controlId}-description`;

  return (
    <div
      className={cx(
        tokens.uiRoot,
        styles.toggle,
        bordered && styles.bordered,
        className,
      )}
    >
      <span className={cx(styles.copy, hideLabel && styles.hiddenLabel)}>
        <span className={styles.label} id={labelId}>
          {label}
        </span>
        {description !== undefined && (
          <span className={styles.description} id={descriptionId}>
            {description}
          </span>
        )}
      </span>
      <button
        aria-checked={checked}
        aria-describedby={description === undefined ? undefined : descriptionId}
        aria-labelledby={labelId}
        className={styles.switch}
        disabled={disabled}
        id={controlId}
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      />
    </div>
  );
}

export default Toggle;
