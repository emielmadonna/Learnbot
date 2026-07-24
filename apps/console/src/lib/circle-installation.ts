export const DEFAULT_CIRCLE_APP_URL =
  "https://clone.stack-labs.ai/app/conversation";
export const DEFAULT_CIRCLE_SCRIPT_URL =
  "https://clone.stack-labs.ai/integrations/circle-learningbot.js";

export type CircleInstallationConfig = {
  tenantId: string;
  tenantSlug: string;
  assistantName: string;
  primaryColor: string;
  accentColor: string;
  welcomeMessage: string;
  launcherLabel?: string;
  communityUrl?: string;
  appUrl?: string;
  scriptUrl?: string;
};

function javascriptString(value: string) {
  return JSON.stringify(value).replace(/[<>&]/gu, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function publicCircleAppUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return configured ? `${configured.replace(/\/+$/u, "")}/app/conversation` : DEFAULT_CIRCLE_APP_URL;
}

export function validCircleUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function buildCircleSnippet(config: CircleInstallationConfig) {
  const appUrl = config.appUrl ?? publicCircleAppUrl();
  const scriptUrl = config.scriptUrl ?? DEFAULT_CIRCLE_SCRIPT_URL;
  const label = config.launcherLabel?.trim() || `Ask ${config.assistantName}`;
  const communityUrl = config.communityUrl?.trim() ?? "";
  return `(() => {
  const script = document.createElement("script");
  script.src = ${javascriptString(scriptUrl)};
  script.dataset.appUrl = ${javascriptString(appUrl)};
  script.dataset.tenantId = ${javascriptString(config.tenantId)};
  script.dataset.tenantSlug = ${javascriptString(config.tenantSlug)};
  script.dataset.assistantName = ${javascriptString(config.assistantName)};
  script.dataset.assistantPrimary = ${javascriptString(config.primaryColor)};
  script.dataset.assistantAccent = ${javascriptString(config.accentColor)};
  script.dataset.assistantWelcome = ${javascriptString(config.welcomeMessage)};
  script.dataset.label = ${javascriptString(label)};${
    communityUrl
      ? `
  script.dataset.communityUrl = ${javascriptString(communityUrl)};`
      : ""
  }
  script.defer = true;
  document.head.append(script);
})();`;
}
