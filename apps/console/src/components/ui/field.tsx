"use client";

import { useId } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import styles from "./field.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

/** Attributes a control must spread to stay wired to its label, help and error. */
export type FieldControl = {
  readonly id: string;
  readonly "aria-describedby": string | undefined;
  readonly "aria-invalid": true | undefined;
  readonly required: boolean;
};

export type FieldProps = {
  readonly label: string;
  /** Supply when the control needs a stable id (test hooks, external labels). */
  readonly id?: string | undefined;
  readonly help?: string | undefined;
  /** Non-empty string renders the inline error and marks the control invalid. */
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  /** Keeps the label for assistive tech but hides it visually. */
  readonly hideLabel?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children: (control: FieldControl) => ReactNode;
};

/**
 * Label / help / error scaffolding. Use it directly when wrapping a control
 * this module does not ship; otherwise prefer TextField, TextAreaField or
 * SelectField, which are built on top of it.
 */
export function Field({
  label,
  id,
  help,
  error,
  required = false,
  hideLabel = false,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const invalid = error !== undefined && error !== "";
  const describedBy =
    cx(help !== undefined ? helpId : "", invalid ? errorId : "") || undefined;

  return (
    <div className={cx(tokens.uiRoot, styles.field, className)}>
      <label
        className={cx(styles.label, hideLabel && styles.hiddenLabel)}
        htmlFor={controlId}
      >
        {label}
        {required && (
          <span aria-hidden="true" className={styles.required}>
            *
          </span>
        )}
      </label>
      {children({
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": invalid ? true : undefined,
        required,
      })}
      {help !== undefined && (
        <p className={styles.help} id={helpId}>
          {help}
        </p>
      )}
      {invalid && (
        <p className={styles.error} id={errorId} role="alert">
          <span aria-hidden="true">!</span>
          {error}
        </p>
      )}
    </div>
  );
}

type SharedFieldProps = Pick<
  FieldProps,
  "label" | "id" | "help" | "error" | "required" | "hideLabel" | "className"
>;

export type TextFieldProps = SharedFieldProps &
  Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "id" | "className" | "required" | "aria-describedby" | "aria-invalid"
  >;

export function TextField({
  label,
  id,
  help,
  error,
  required,
  hideLabel,
  className,
  ...input
}: TextFieldProps) {
  return (
    <Field
      className={className}
      error={error}
      help={help}
      hideLabel={hideLabel}
      id={id}
      label={label}
      required={required}
    >
      {(control) => (
        <input
          {...input}
          {...control}
          className={cx(styles.control, styles.input)}
          type={input.type ?? "text"}
        />
      )}
    </Field>
  );
}

export type TextAreaFieldProps = SharedFieldProps &
  Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "id" | "className" | "required" | "aria-describedby" | "aria-invalid"
  >;

export function TextAreaField({
  label,
  id,
  help,
  error,
  required,
  hideLabel,
  className,
  ...textarea
}: TextAreaFieldProps) {
  return (
    <Field
      className={className}
      error={error}
      help={help}
      hideLabel={hideLabel}
      id={id}
      label={label}
      required={required}
    >
      {(control) => (
        <textarea
          {...textarea}
          {...control}
          className={cx(styles.control, styles.textarea)}
        />
      )}
    </Field>
  );
}

export type SelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
};

export type SelectFieldProps = SharedFieldProps &
  Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "id" | "className" | "required" | "aria-describedby" | "aria-invalid"
  > & {
    readonly options: readonly SelectOption[];
    /** Renders a disabled first option. Use for "choose one" affordances. */
    readonly placeholder?: string | undefined;
  };

export function SelectField({
  label,
  id,
  help,
  error,
  required,
  hideLabel,
  className,
  options,
  placeholder,
  ...select
}: SelectFieldProps) {
  return (
    <Field
      className={className}
      error={error}
      help={help}
      hideLabel={hideLabel}
      id={id}
      label={label}
      required={required}
    >
      {(control) => (
        <span className={styles.selectWrap}>
          <select
            {...select}
            {...control}
            className={cx(styles.control, styles.select)}
          >
            {placeholder !== undefined && (
              <option disabled value="">
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option
                disabled={option.disabled === true}
                key={option.value}
                value={option.value}
              >
                {option.label}
              </option>
            ))}
          </select>
        </span>
      )}
    </Field>
  );
}

export default Field;
