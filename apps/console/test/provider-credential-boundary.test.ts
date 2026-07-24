import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const credentialsFunction = source(
  "../../../infra/supabase/functions/learning-provider-credentials/index.ts",
);
const completionFunction = source(
  "../../../infra/supabase/functions/learning-provider-complete/index.ts",
);
const migration = source(
  "../../../infra/supabase/migrations/20260724212700_tenant_provider_vault_boundary.sql",
);
const provider = source("../src/lib/learning-provider.ts");

test("Vault credential writes and resolution are server-only", () => {
  assert.match(credentialsFunction, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(credentialsFunction, /learning_provider_set_credential/);
  assert.match(completionFunction, /learning_provider_runtime_credential/);
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /vault\.update_secret/);
  assert.match(migration, /grant execute .*to service_role/isu);
  assert.doesNotMatch(`${credentialsFunction}\n${completionFunction}`, /console\.(log|error)/iu);
  assert.doesNotMatch(credentialsFunction, /credential[^\n]*return/iu);
  assert.match(completionFunction, /store: false/);
});

test("deployment key remains the explicit fallback when tenant Vault is absent", () => {
  assert.match(provider, /tenant_credential_not_configured/);
  assert.match(provider, /configuredAdapter/);
  assert.match(provider, /process\.env\.OPENAI_API_KEY/);
});
