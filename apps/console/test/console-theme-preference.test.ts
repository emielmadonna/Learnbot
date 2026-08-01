import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONSOLE_THEME_OPTIONS,
  CONSOLE_THEME_STORAGE_KEY,
  groundForConsoleTheme,
  parseConsoleThemePreference,
  readConsoleThemePreference,
  writeConsoleThemePreference,
} from "../src/components/app-shell/theme-preference";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const shellSource = readFileSync(
  new URL("../src/components/app-shell/app-shell.tsx", import.meta.url),
  "utf8",
);
const shellStyles = readFileSync(
  new URL("../src/components/app-shell/shell.module.css", import.meta.url),
  "utf8",
);
const homeStyles = readFileSync(
  new URL("../src/components/sections/home-section.module.css", import.meta.url),
  "utf8",
);

test("console theme exposes the three prototype appearance modes", () => {
  assert.deepEqual(CONSOLE_THEME_OPTIONS, [
    { value: "auto", label: "Automatic" },
    { value: "light", label: "Always light" },
    { value: "dark", label: "Always dark" },
  ]);
});

test("automatic launches on the prototype's light paper ground", () => {
  assert.equal(parseConsoleThemePreference(null), "auto");
  assert.equal(parseConsoleThemePreference("unsupported"), "auto");
  assert.equal(groundForConsoleTheme("auto"), "light");
  assert.equal(groundForConsoleTheme("light"), "light");
  assert.equal(groundForConsoleTheme("dark"), "dark");
});

test("console theme round-trips through client storage", () => {
  const storage = new MemoryStorage();

  assert.equal(readConsoleThemePreference(storage), "auto");
  assert.equal(writeConsoleThemePreference(storage, "dark"), true);
  assert.equal(storage.getItem(CONSOLE_THEME_STORAGE_KEY), "dark");
  assert.equal(readConsoleThemePreference(storage), "dark");

  storage.setItem(CONSOLE_THEME_STORAGE_KEY, "invalid");
  assert.equal(readConsoleThemePreference(storage), "auto");
});

test("restricted storage falls back without blocking an in-session choice", () => {
  const denied = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };

  assert.equal(readConsoleThemePreference(denied), "auto");
  assert.equal(writeConsoleThemePreference(denied, "light"), false);
});

test("authenticated shell uses the preference adapter and token aliases", () => {
  assert.match(shellSource, /groundForConsoleTheme\(themePreference\)/u);
  assert.match(shellSource, /platformMode \? "light"/u);
  assert.match(shellSource, /data-theme-preference=\{themePreference\}/u);
  assert.match(shellSource, /role="radiogroup"/u);
  assert.doesNotMatch(shellSource, /data-ground="light"/u);

  for (const source of [shellStyles, homeStyles]) {
    assert.match(source, /var\(--bg\)|var\(--surface\)/u);
    assert.match(source, /var\(--ink\)/u);
    assert.match(source, /var\(--muted\)/u);
    assert.match(source, /var\(--accent\)/u);
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/iu);
  }
});
