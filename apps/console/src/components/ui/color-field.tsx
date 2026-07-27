"use client";

import { useEffect, useId, useState } from "react";

import styles from "./color-field.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";
import {
  AA_THRESHOLD,
  contrastRatio,
  normalizeHex,
  type ContrastLevel,
} from "./contrast";

export type ColorFieldProps = {
  readonly label: string;
  /** Canonical `#rrggbb` value. Free-typed hex is echoed back only once it parses. */
  readonly value: string;
  readonly onChange: (hex: string) => void;
  readonly id?: string | undefined;
  readonly help?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  /** Colour this one is placed against. Enables the WCAG AA check. */
  readonly contrastAgainst?: string | undefined;
  /** Which AA threshold applies. Defaults to body text (4.5:1). */
  readonly contrastLevel?: ContrastLevel | undefined;
  /** Names the pair in the result, e.g. "primary on surface". */
  readonly contrastLabel?: string | undefined;
};

const levelCopy: Readonly<Record<ContrastLevel, string>> = {
  text: "body text",
  "large-text": "large text",
  ui: "UI edges and icons",
};

/**
 * Colour input with a hex entry box and a live WCAG AA verdict.
 * The check is only rendered when a comparison colour is supplied — an
 * unverifiable pair reports "not checked" rather than a passing badge.
 */
export function ColorField({
  label,
  value,
  onChange,
  id,
  help,
  disabled = false,
  className,
  contrastAgainst,
  contrastLevel = "text",
  contrastLabel,
}: ColorFieldProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-color`;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const resultId = `${controlId}-contrast`;
  const [draft, setDraft] = useState(value);

  // Re-sync when the owner changes the value from outside (rollback, load).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const parsedDraft = normalizeHex(draft);
  const invalid = parsedDraft === undefined;
  const swatchValue = normalizeHex(value) ?? "#000000";

  function commit(next: string) {
    setDraft(next);
    const normalized = normalizeHex(next);
    if (normalized !== undefined) onChange(normalized);
  }

  const ratio =
    contrastAgainst === undefined
      ? undefined
      : contrastRatio(parsedDraft ?? value, contrastAgainst);
  const threshold = AA_THRESHOLD[contrastLevel];
  const pairName = contrastLabel ?? `${label} against its background`;

  return (
    <div className={cx(tokens.uiRoot, styles.colorField, className)}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
      </label>
      <div className={cx(styles.row, invalid && styles.invalid)}>
        <input
          aria-label={`${label} colour picker`}
          className={styles.swatch}
          disabled={disabled}
          onChange={(event) => commit(event.target.value)}
          type="color"
          value={swatchValue}
        />
        <input
          aria-describedby={
            cx(
              help !== undefined ? helpId : "",
              invalid ? errorId : "",
              ratio !== undefined ? resultId : "",
            ) || undefined
          }
          aria-invalid={invalid ? true : undefined}
          autoComplete="off"
          className={styles.hex}
          disabled={disabled}
          id={controlId}
          inputMode="text"
          onBlur={() => setDraft(normalizeHex(draft) ?? value)}
          onChange={(event) => commit(event.target.value)}
          spellCheck={false}
          value={draft}
        />
      </div>
      {help !== undefined && (
        <p className={styles.help} id={helpId}>
          {help}
        </p>
      )}
      {invalid && (
        <p className={styles.error} id={errorId} role="alert">
          Enter a hex colour such as #235A47.
        </p>
      )}
      {contrastAgainst !== undefined && (
        <div
          aria-live="polite"
          className={cx(
            styles.contrast,
            ratio === undefined
              ? styles.contrastUnknown
              : ratio < threshold
                ? styles.contrastFail
                : undefined,
          )}
          id={resultId}
        >
          <span className={styles.ratio}>
            {ratio === undefined ? "—" : `${ratio.toFixed(1)}:1`}
          </span>
          <div>
            <strong>
              {ratio === undefined
                ? "Contrast not checked"
                : ratio < threshold
                  ? "Fails WCAG AA"
                  : "Passes WCAG AA"}
            </strong>
            <p>
              {ratio === undefined
                ? "One of the two colours could not be read, so no ratio is claimed."
                : ratio < threshold
                  ? `${pairName} needs ${threshold}:1 for ${levelCopy[contrastLevel]}. Darken one side or lighten the other.`
                  : `${pairName} clears the ${threshold}:1 minimum for ${levelCopy[contrastLevel]}.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default ColorField;
