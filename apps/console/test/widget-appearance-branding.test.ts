import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731022131_widget_appearance_branding.sql",
    import.meta.url,
  ),
  "utf8",
);
const settingsRoute = readFileSync(
  new URL("../src/app/api/widget/settings/route.ts", import.meta.url),
  "utf8",
);
const configRoute = readFileSync(
  new URL("../src/app/api/widget/config/route.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/sections/widget-panel.tsx", import.meta.url),
  "utf8",
);
const hosted = readFileSync(
  new URL("../src/app/c/[slug]/hosted-assistant.tsx", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../../../packages/widget-runtime/src/index.ts", import.meta.url),
  "utf8",
);

test("appearance settings are durable, versioned, and origin-gated", () => {
  for (const field of [
    "launcherShape",
    "greetingBubbleEnabled",
    "greetingBubbleDelaySeconds",
    "showPoweredBy",
    "appearanceMode",
  ]) {
    assert.ok(migration.includes(`'${field}'`), `missing durable field: ${field}`);
  }
  assert.match(migration, /app_private\.widget_resolve\(widget_key, origin\)/u);
  assert.match(migration, /app_private\.onboarding_begin_command/u);
  assert.match(migration, /app_private\.onboarding_complete_command/u);
  assert.match(migration, /expected_version/u);
  assert.match(migration, /grant execute on function public\.widget_bootstrap\(text, text\) to anon/u);
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete|all)[\s\S]{0,80}tenant_branding[\s\S]{0,80}to anon/iu,
  );
});

test("console controls and both public surfaces consume the complete appearance contract", () => {
  for (const label of [
    "Launcher shape",
    "Greeting bubble",
    "Greeting delay (seconds)",
    "Show “Powered by Corso”",
    "Always light",
    "Always dark",
  ]) {
    assert.ok(panel.includes(label), `missing prototype control: ${label}`);
  }
  for (const field of [
    "launcherShape",
    "greetingBubbleEnabled",
    "greetingBubbleDelaySeconds",
    "showPoweredBy",
    "appearanceMode",
  ]) {
    assert.ok(settingsRoute.includes(field), `settings route omits ${field}`);
    assert.ok(configRoute.includes(field), `public config omits ${field}`);
    assert.ok(runtime.includes(field), `runtime omits ${field}`);
  }
  assert.match(runtime, /Powered by Corso/u);
  assert.match(runtime, /prefers-color-scheme: dark/u);
  assert.match(hosted, /bootstrap\.widget\.showPoweredBy/u);
  assert.match(hosted, /bootstrap\.widget\.appearanceMode/u);
});

test("appearance wiring does not weaken public request boundaries", () => {
  assert.match(configRoute, /requestOrigin\(request\)/u);
  assert.match(configRoute, /origin === null \|\| !isWidgetKey\(key\)/u);
  assert.match(configRoute, /widgetBootstrap\(supabase/u);
  assert.match(configRoute, /widgetRefusal\(\)/u);
  assert.doesNotMatch(configRoute, /credentials|cookie|service_role/iu);
});

test("dual platform and tenant owners retain widget administration", () => {
  assert.match(panel, /asWorkspace\(payload\)/u);
  assert.match(
    panel,
    /workspace\?\.identity\.role\s*\?\?\s*payload\.role/u,
  );
  assert.match(panel, /ADMIN_ROLES\.has\(role\)/u);
});
