/** Joins class names, dropping anything falsy. Internal helper for this directory. */
export function cx(
  ...values: ReadonlyArray<string | false | null | undefined>
): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
