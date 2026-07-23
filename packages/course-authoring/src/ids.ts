import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function deterministicId(
  kind: "course" | "module" | "lesson" | "block" | "revision" | "list-item",
  namespace: string,
  ordinal: number | string,
  value: unknown,
): string {
  const digest = fingerprint({ namespace, ordinal, value }).slice(0, 20);
  return `${kind}_${digest}`;
}
