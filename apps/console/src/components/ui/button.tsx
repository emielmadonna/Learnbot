import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./button.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
> & {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  /** Shows a spinner, sets aria-busy and blocks activation. */
  readonly loading?: boolean | undefined;
  /** Replaces the label while loading. Falls back to the normal children. */
  readonly loadingLabel?: ReactNode | undefined;
  readonly iconStart?: ReactNode | undefined;
  readonly iconEnd?: ReactNode | undefined;
  readonly fullWidth?: boolean | undefined;
  readonly className?: string | undefined;
};

const variantClass: Readonly<Record<ButtonVariant, string>> = {
  primary: styles.primary!,
  secondary: styles.secondary!,
  ghost: styles.ghost!,
  danger: styles.danger!,
};

const sizeClass: Readonly<Record<ButtonSize, string>> = {
  sm: styles.sm!,
  md: "",
  lg: styles.lg!,
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel,
  iconStart,
  iconEnd,
  fullWidth = false,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const label = loading && loadingLabel !== undefined ? loadingLabel : children;

  return (
    <button
      {...rest}
      aria-busy={loading || undefined}
      className={cx(
        tokens.uiRoot,
        styles.button,
        variantClass[variant],
        sizeClass[size],
        fullWidth && styles.fullWidth,
        className,
      )}
      disabled={disabled === true || loading}
      type={type ?? "button"}
    >
      {loading ? (
        <span aria-hidden="true" className={styles.spinner} />
      ) : (
        iconStart !== undefined && (
          <span aria-hidden="true" className={styles.icon}>
            {iconStart}
          </span>
        )
      )}
      {label}
      {!loading && iconEnd !== undefined && (
        <span aria-hidden="true" className={styles.icon}>
          {iconEnd}
        </span>
      )}
    </button>
  );
}

export default Button;
