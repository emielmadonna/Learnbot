import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731015921_tenant_provider_management_state.sql",
    import.meta.url,
  ),
  "utf8",
);
const route = readFileSync(
  new URL("../src/app/api/agent/provider/route.ts", import.meta.url),
  "utf8",
);
const component = readFileSync(
  new URL(
    "../src/components/sections/provider-credential-card.tsx",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedProvider = readFileSync(
  new URL(
    "../../../infra/supabase/functions/learning-provider-complete/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const widgetProvider = readFileSync(
  new URL(
    "../../../infra/supabase/functions/learning-provider-widget-complete/index.ts",
    import.meta.url,
  ),
  "utf8",
);

test("provider state exposes metadata but never decrypted credential material", () => {
  assert.match(migration, /learning_provider_credential_state/u);
  assert.match(migration, /keyLast4/u);
  assert.doesNotMatch(
    migration.slice(migration.indexOf("learning_provider_credential_state")),
    /decrypted_secret/u,
  );
  assert.match(
    migration,
    /revoke execute on function public\.learning_provider_credential_state\(\)\s+from public, anon, service_role/u,
  );
});

test("clearing a tenant provider key removes the Vault secret and keeps fallback", () => {
  assert.match(migration, /delete from vault\.secrets/u);
  assert.match(migration, /learning\.provider\.credential\.clear/u);
  assert.match(component, /Use platform-managed key/u);
  assert.match(component, /Supabase Vault/u);
});

test("provider mutations remain same-origin and server-mediated", () => {
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /learning-provider-credentials/u);
  assert.doesNotMatch(component, /learning-provider-credentials/u);
  assert.doesNotMatch(component, /SUPABASE_SERVICE_ROLE_KEY/u);
});

test("provider functions reject model IDs outside the billed tenant catalog", () => {
  for (const provider of [authenticatedProvider, widgetProvider]) {
    assert.match(provider, /const allowedModels = new Set/u);
    assert.match(provider, /"gpt-5\.6-sol"/u);
    assert.match(provider, /"gpt-5\.6-terra"/u);
    assert.match(provider, /"gpt-5\.6-luna"/u);
    assert.match(provider, /!allowedModels\.has\(model\)/u);
  }
});
