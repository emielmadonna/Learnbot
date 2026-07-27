// Zero-dependency WCAG contrast gate for apps/console/src/app/tokens.css.
//
// Parses the Graphite token file directly (no CSS parser dependency) and
// computes WCAG 2.x contrast ratios for every text-capable color token
// against every ground it can sit on. Exits non-zero if anything falls
// below 4.5:1 (AA for normal text).
//
// Why these tokens and not others:
//   - --ink, --muted, --good, --warn, --accent are the tokens the design
//     system (docs/PLAN.md Section 3) documents with a measured contrast
//     ratio, i.e. tokens that are expected to be read as text or read
//     against a ground. They are checked here.
//   - --hairline is explicitly NOT a text token (the "two-gray rule",
//     Section 3.2) and is deliberately excluded from this sweep. Adding
//     it here would either force it to fail (it is non-text by design and
//     measures ~2:1 on light ground) or tempt someone into loosening the
//     threshold to make it pass, which is exactly the bug this rule exists
//     to prevent.
//   - --accent-wash is a translucent fill, not text, and is excluded.
//   - --accent-ink is text, but its ground is --accent, not
//     --bg/--surface/--elev — it gets its own dedicated check below rather
//     than being folded into the general sweep.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKENS_PATH = resolve("apps/console/src/app/tokens.css");
const MIN_CONTRAST = 4.5;

const TEXT_TOKENS = ["ink", "muted", "good", "warn", "accent"];
const GROUND_TOKENS = ["bg", "surface", "elev"];

// ---------------------------------------------------------------- parsing

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract the raw declaration body of every top-level `:root { ... }`
 * block, in source order, plus the `[data-ground="light"]` block. Relies
 * on tokens.css never nesting braces inside a custom-property value
 * (true for colors, radii, easing curves and font stacks), so a
 * non-greedy `[^}]*` safely spans each block including ones nested one
 * level inside `@media`. */
function extractBlocks(css) {
  const rootBodies = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map(
    (m) => m[1]
  );
  const dataGroundMatch = css.match(
    /\[data-ground=["']light["']\]\s*\{([^}]*)\}/
  );

  if (rootBodies.length < 2) {
    throw new Error(
      `expected 2 ":root { ... }" blocks (dark + light media query), found ${rootBodies.length}`
    );
  }
  if (!dataGroundMatch) {
    throw new Error('missing [data-ground="light"] { ... } block');
  }

  return {
    dark: rootBodies[0],
    lightMedia: rootBodies[1],
    lightAttr: dataGroundMatch[1],
  };
}

/** Parse `--name: value;` declarations from a block body into a map,
 * resolving single-level `var(--other)` references against the same
 * block. Values never contain a literal `;`, so splitting on `;` is
 * safe even for multi-line font-stack values. */
function parseDeclarations(body) {
  const raw = new Map();
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = re.exec(body))) {
    raw.set(match[1], match[2].trim().replace(/\s+/g, " "));
  }

  const resolved = new Map();
  for (const [name, value] of raw) {
    const varRef = value.match(/^var\(--([a-zA-Z0-9-]+)\)$/);
    resolved.set(name, varRef ? raw.get(varRef[1]) ?? value : value);
  }
  return resolved;
}

// -------------------------------------------------------------- color math

/** Parse a solid CSS color (#rgb, #rrggbb, rgb()/rgba() with comma or
 * space+slash syntax) into [r, g, b] in 0-255. Alpha is ignored — every
 * token this script checks is opaque; translucent tokens (--hairline,
 * --accent-wash) are intentionally excluded from the sweep. */
function parseColor(value) {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return h.split("").map((c) => parseInt(c + c, 16));
    }
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((p) => parseFloat(p));
    if (parts.length >= 3) return parts.slice(0, 3);
  }

  throw new Error(`unparseable color: "${value}"`);
}

function srgbChannelToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]) {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function contrastRatio(colorA, colorB) {
  const lA = relativeLuminance(parseColor(colorA));
  const lB = relativeLuminance(parseColor(colorB));
  const [hi, lo] = lA >= lB ? [lA, lB] : [lB, lA];
  return (hi + 0.05) / (lo + 0.05);
}

// -------------------------------------------------------------------- main

function checkPalette(name, decls, errors, report) {
  for (const textToken of TEXT_TOKENS) {
    const textValue = decls.get(textToken);
    if (!textValue) {
      errors.push(`[${name}] missing --${textToken}`);
      continue;
    }

    let worst = Infinity;
    let worstGround = null;
    for (const groundToken of GROUND_TOKENS) {
      const groundValue = decls.get(groundToken);
      if (!groundValue) {
        errors.push(`[${name}] missing --${groundToken}`);
        continue;
      }
      const ratio = contrastRatio(textValue, groundValue);
      if (ratio < worst) {
        worst = ratio;
        worstGround = groundToken;
      }
    }

    report.push({
      palette: name,
      token: `--${textToken}`,
      worst,
      worstGround: `--${worstGround}`,
    });

    if (worst < MIN_CONTRAST) {
      errors.push(
        `[${name}] --${textToken} (${textValue}) is only ${worst.toFixed(2)}:1 ` +
          `against --${worstGround} — below the ${MIN_CONTRAST}:1 minimum`
      );
    }
  }

  // Dedicated check: --accent-ink against its actual ground, --accent.
  const accentInk = decls.get("accent-ink");
  const accent = decls.get("accent");
  if (accentInk && accent) {
    const ratio = contrastRatio(accentInk, accent);
    report.push({
      palette: name,
      token: "--accent-ink",
      worst: ratio,
      worstGround: "--accent",
    });
    if (ratio < MIN_CONTRAST) {
      errors.push(
        `[${name}] --accent-ink (${accentInk}) is only ${ratio.toFixed(2)}:1 ` +
          `against --accent (${accent}) — below the ${MIN_CONTRAST}:1 minimum`
      );
    }
  }
}

function checkLightParity(lightMedia, lightAttr, errors) {
  const keys = new Set([...lightMedia.keys(), ...lightAttr.keys()]);
  for (const key of keys) {
    const mediaValue = lightMedia.get(key);
    const attrValue = lightAttr.get(key);
    if (mediaValue !== attrValue) {
      errors.push(
        `[light parity] --${key} differs between ` +
          `"@media (prefers-color-scheme: light)" (${mediaValue ?? "missing"}) and ` +
          `"[data-ground=\\"light\\"]" (${attrValue ?? "missing"}) — ` +
          "the two light-ground blocks must define the same token names with the same values"
      );
    }
  }
}

function main() {
  const css = stripComments(readFileSync(TOKENS_PATH, "utf8"));
  const blocks = extractBlocks(css);

  const dark = parseDeclarations(blocks.dark);
  const lightMedia = parseDeclarations(blocks.lightMedia);
  const lightAttr = parseDeclarations(blocks.lightAttr);

  const errors = [];
  const report = [];

  checkPalette("dark", dark, errors, report);
  checkPalette("light", lightMedia, errors, report);
  checkLightParity(lightMedia, lightAttr, errors);

  console.log(`Contrast check — ${TOKENS_PATH}\n`);
  for (const row of report) {
    const status = row.worst >= MIN_CONTRAST ? "PASS" : "FAIL";
    console.log(
      `  [${status}] ${row.palette.padEnd(6)} ${row.token.padEnd(14)} ` +
        `${row.worst.toFixed(2)}:1 worst case (vs ${row.worstGround})`
    );
  }
  console.log();

  if (errors.length > 0) {
    console.error("Contrast check failed:\n");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(
    `All text tokens clear ${MIN_CONTRAST}:1 on every ground (--bg, --surface, --elev), ` +
      "and both light-ground blocks agree."
  );
}

main();
