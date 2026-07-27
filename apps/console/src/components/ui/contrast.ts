/**
 * WCAG 2.1 contrast helpers, shared by ColorField and anything else that has to
 * tell a tenant their colour pair will not be readable.
 */

export type ContrastLevel = "text" | "large-text" | "ui";

/** Minimum ratio each level must reach to pass WCAG AA. */
export const AA_THRESHOLD: Readonly<Record<ContrastLevel, number>> = {
  text: 4.5,
  "large-text": 3,
  ui: 3,
};

const HEX_PATTERN = /^#?(?:[\da-f]{3}|[\da-f]{6})$/iu;

export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

/** Returns a canonical `#rrggbb` string, or undefined when the input is not a hex colour. */
export function normalizeHex(value: string): string | undefined {
  const raw = value.trim().replace(/^#/u, "");
  if (!HEX_PATTERN.test(raw)) return undefined;
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : raw;
  return `#${expanded.toLowerCase()}`;
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.1. Returns undefined for non-hex input. */
export function relativeLuminance(hex: string): number | undefined {
  const normalized = normalizeHex(hex);
  if (normalized === undefined) return undefined;
  const parts = normalized.slice(1).match(/.{2}/gu);
  if (parts === null || parts.length !== 3) return undefined;
  const [red, green, blue] = parts.map((part) =>
    channel(Number.parseInt(part, 16)),
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Contrast ratio between two hex colours, 1–21.
 * Returns undefined rather than a made-up number when either colour is unparseable.
 */
export function contrastRatio(
  foreground: string,
  background: string,
): number | undefined {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (first === undefined || second === undefined) return undefined;
  return (
    (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  );
}

export function passesAA(ratio: number, level: ContrastLevel = "text"): boolean {
  return ratio >= AA_THRESHOLD[level];
}
