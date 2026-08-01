import type { CSSProperties } from "react";
import type { AgentConfig } from "./contract";

/**
 * Brand token derivation for the app shell.
 *
 * The shell root is the ONLY place that may emit brand colors. Every other
 * surface reads `--brand-*` custom properties, so a tenant can be re-themed
 * without touching a single component.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

const FALLBACK_PRIMARY = "#4a637f";
const FALLBACK_ACCENT = "#4a637f";
const FALLBACK_SURFACE = "#ffffff";
const FALLBACK_TEXT = "#1d1d1f";

/** Dark counterpart used when a brand color is too light for white text. */
const ON_LIGHT = "#101614";
const ON_DARK = "#ffffff";

function normalizeHex(value: string | null | undefined, fallback: string) {
  const candidate = (value ?? "").trim();
  if (!HEX.test(candidate)) return fallback;
  if (candidate.length === 4) {
    const r = candidate.charAt(1);
    const g = candidate.charAt(2);
    const b = candidate.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return candidate.toLowerCase();
}

function channels(hex: string) {
  const value = normalizeHex(hex, FALLBACK_PRIMARY).slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ] as const;
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string) {
  const toLinear = (channel: number) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = channels(hex);
  return (
    0.2126 * toLinear(red) +
    0.7152 * toLinear(green) +
    0.0722 * toLinear(blue)
  );
}

export function contrastRatio(a: string, b: string) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Pick the readable foreground for a filled brand surface. */
export function readableOn(background: string) {
  return contrastRatio(background, ON_DARK) >=
    contrastRatio(background, ON_LIGHT)
    ? ON_DARK
    : ON_LIGHT;
}

/**
 * The single source of truth for shell theming. Everything downstream reads
 * these custom properties; nothing else may hardcode a brand color.
 */
export function brandStyle(agent: AgentConfig): CSSProperties {
  const primary = normalizeHex(agent.primaryColor, FALLBACK_PRIMARY);
  const accent = normalizeHex(agent.accentColor, FALLBACK_ACCENT);
  const surface = normalizeHex(agent.surfaceColor, FALLBACK_SURFACE);
  const text = normalizeHex(agent.textColor, FALLBACK_TEXT);

  return {
    "--brand-primary": primary,
    "--brand-accent": accent,
    "--brand-surface": surface,
    "--brand-text": text,
    "--brand-on-primary": readableOn(primary),
    "--brand-on-accent": readableOn(accent),
  } as CSSProperties;
}

/** Header mark fallback. Never a hardcoded letter — always tenant-derived. */
export function brandInitial(agent: AgentConfig, fallbackName: string) {
  const source = agent.assistantName.trim() || fallbackName.trim();
  const initial = Array.from(source)[0] ?? "";
  return initial ? initial.toUpperCase() : agent.iconGlyph;
}
