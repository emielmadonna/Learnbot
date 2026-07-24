import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseTenantConfiguration,
  validateTenantConfigurationPatch,
  TenantConfigurationError,
} from "../src/lib/tenant-configuration";

const clientSource = readFileSync(
  new URL("../src/app/app/configure/configuration-client.tsx", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../src/app/api/app/configure/route.ts", import.meta.url),
  "utf8",
);
test("configuration parsing normalizes durable tenant values", () => {
  const configuration = parseTenantConfiguration({
    tenant: {
      tenant_id: "tenant-1",
      slug: "acme",
      display_name: "Acme",
      settings: {
        learningBot: {
          provider: "openai",
          model: "gpt-4o-mini",
          featureGates: { analytics: false },
        },
      },
      record_version: 4,
    },
    branding: {
      tenant_branding_id: "branding-1",
      record_version: 3,
      assistant_name: " Nova ",
      welcome_message: " Welcome back. ",
      primary_color: "#315f50",
      accent_color: "#d8a653",
      surface_color: "#fffdf8",
      text_color: "#17211d",
      voice_configuration: { enabled: true, voiceId: "harbor", guide: "Guide" },
    },
    role: "tenant_owner",
  });

  assert.equal(configuration.assistant.name, "Nova");
  assert.equal(configuration.assistant.primaryColor, "#315F50");
  assert.equal(configuration.featureGates.analytics, false);
});

test("configuration patch rejects raw credential writes", () => {
  assert.throws(
    () => validateTenantConfigurationPatch({ credentials: { value: "sk-never-store-this" } }),
    (error: unknown) =>
      error instanceof TenantConfigurationError &&
      error.code === "secret_write_not_supported",
  );
});

test("configuration patch validates provider and model", () => {
  const update = validateTenantConfigurationPatch({
    expectedTenantRevision: 4,
    expectedBrandingRevision: 3,
    provider: "openai",
    model: "gpt-4o-mini",
    voiceGuide: { enabled: true, voice: "harbor", guide: "Guide" },
    assistant: {
      name: "Nova",
      welcome: "Welcome",
      icon: "spark",
      primaryColor: "#315F50",
      accentColor: "#D8A653",
      surfaceColor: "#FFFDF8",
      textColor: "#17211D",
    },
    featureGates: { analytics: false, voice: true, uploads: true, contextMapping: true },
  });

  assert.equal(update.provider, "openai");
  assert.equal(update.expectedTenantRevision, 4);
  assert.equal(update.featureGates.analytics, false);
});

test("surface has the requested sections and no browser credential persistence", () => {
  for (const heading of [
    "Provider and model",
    "Voice guide",
    "Assistant",
    "Feature gates",
    "Icon",
  ]) {
    assert.match(clientSource, new RegExp(heading));
  }
  assert.doesNotMatch(clientSource, /localStorage|sessionStorage/iu);
  assert.match(clientSource, /credentials\.configured/iu);
  assert.match(clientSource, /server-side Vault boundary/iu);
  assert.match(clientSource, /type="password"/iu);
});

test("server boundary refuses raw credentials without echoing them", () => {
  assert.match(routeSource, /secret_write_not_supported/);
  assert.match(routeSource, /authenticatedLearningClient/);
  assert.match(routeSource, /updateTenantConfiguration/);
  assert.doesNotMatch(routeSource, /localStorage|sessionStorage/iu);
  assert.match(routeSource, /Cache-Control.*no-store/isu);
});
