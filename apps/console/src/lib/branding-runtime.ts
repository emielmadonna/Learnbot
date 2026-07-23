export const BRANDING_STORAGE_KEY = "learningbot:tenant-branding:v1";
export const BRANDING_EVENT = "learningbot:branding-published";

export type RuntimeBranding = {
  assistantName: string;
  initials: string;
  logoDataUrl: string | null;
  primary: string;
  accent: string;
  surface: string;
  welcome: string;
  voice: "Harbor" | "Meadow" | "Sol";
  attribution: boolean;
  privacyLink: boolean;
};

export const DEFAULT_RUNTIME_BRANDING: RuntimeBranding = {
  assistantName: "Nova",
  initials: "N",
  logoDataUrl: null,
  primary: "#315f50",
  accent: "#d8a653",
  surface: "#fffdf8",
  welcome:
    "Hi, I’m Nova. Ask a question about this lesson, upload a file, or talk it through with me.",
  voice: "Harbor",
  attribution: true,
  privacyLink: true,
};

export function loadRuntimeBranding(): RuntimeBranding {
  if (typeof window === "undefined") return DEFAULT_RUNTIME_BRANDING;
  const value = window.localStorage.getItem(BRANDING_STORAGE_KEY);
  if (!value) return DEFAULT_RUNTIME_BRANDING;
  try {
    return { ...DEFAULT_RUNTIME_BRANDING, ...JSON.parse(value) };
  } catch {
    return DEFAULT_RUNTIME_BRANDING;
  }
}

export function publishRuntimeBranding(value: RuntimeBranding) {
  window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(BRANDING_EVENT, { detail: value }));
}
