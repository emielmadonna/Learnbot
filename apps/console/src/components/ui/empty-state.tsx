import type { ReactNode } from "react";

import styles from "./empty-state.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

export type EmptyStateTone = "neutral" | "restricted" | "error";

export type EmptyStateProps = {
  readonly headline: string;
  /** Why there is nothing here. Say what would make data appear. */
  readonly description?: string | undefined;
  readonly icon?: ReactNode | undefined;
  /** Usually a Button. Omit when there is no honest next step. */
  readonly action?: ReactNode | undefined;
  readonly tone?: EmptyStateTone | undefined;
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children?: ReactNode | undefined;
};

const toneClass: Readonly<Record<EmptyStateTone, string>> = {
  neutral: "",
  restricted: styles.restricted!,
  error: styles.error!,
};

const defaultIcon = (
  <svg
    aria-hidden="true"
    fill="none"
    height="18"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.6"
    viewBox="0 0 24 24"
    width="18"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M9 12h6" />
  </svg>
);

/** Shown when data is genuinely absent — not as a placeholder for a pending load. */
export function EmptyState({
  headline,
  description,
  icon,
  action,
  tone = "neutral",
  compact = false,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        tokens.uiRoot,
        styles.emptyState,
        toneClass[tone],
        compact && styles.compact,
        className,
      )}
    >
      <span className={styles.icon}>{icon ?? defaultIcon}</span>
      <p className={styles.headline}>{headline}</p>
      {description !== undefined && (
        <p className={styles.description}>{description}</p>
      )}
      {children}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}

export default EmptyState;
