export const CONSOLE_THEME_STORAGE_KEY = "corso.console.theme";

export const CONSOLE_THEME_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "light", label: "Always light" },
  { value: "dark", label: "Always dark" },
] as const;

export type ConsoleThemePreference =
  (typeof CONSOLE_THEME_OPTIONS)[number]["value"];

export type ThemeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function parseConsoleThemePreference(
  value: unknown,
): ConsoleThemePreference {
  return value === "light" || value === "dark" ? value : "auto";
}

export function readConsoleThemePreference(
  storage: Pick<ThemeStorage, "getItem"> | null | undefined,
): ConsoleThemePreference {
  if (storage === null || storage === undefined) return "auto";
  try {
    return parseConsoleThemePreference(
      storage.getItem(CONSOLE_THEME_STORAGE_KEY),
    );
  } catch {
    return "auto";
  }
}

export function writeConsoleThemePreference(
  storage: Pick<ThemeStorage, "setItem"> | null | undefined,
  preference: ConsoleThemePreference,
) {
  if (storage === null || storage === undefined) return false;
  try {
    storage.setItem(CONSOLE_THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

/**
 * The reference console launches on its quiet paper ground. Automatic keeps
 * that reference-safe default; people who explicitly prefer the supplied dark
 * composition can select it from the account menu.
 */
export function groundForConsoleTheme(
  preference: ConsoleThemePreference,
): "light" | "dark" | undefined {
  return preference === "dark" ? "dark" : "light";
}
