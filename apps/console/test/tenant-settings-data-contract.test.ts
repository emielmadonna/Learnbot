import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const migration = source(
  "../../../infra/supabase/migrations/20260731022153_tenant_privacy_and_usage_settings.sql",
);
const verification = source(
  "../../../infra/supabase/tests/tenant_privacy_and_usage_settings_verification.sql",
);
const policyRoute = source(
  "../src/app/api/settings/data-policy/route.ts",
);
const exportRoute = source(
  "../src/app/api/settings/data-export/route.ts",
);
const usageRoute = source(
  "../src/app/api/settings/plan-usage/route.ts",
);
const settingsPanel = source(
  "../src/components/sections/settings-panel.tsx",
);
const details = source(
  "../src/components/sections/settings-detail-views.tsx",
);

test("privacy policy is durable, forced-RLS and RPC-only", () => {
  assert.match(migration, /create table public\.tenant_data_policies/);
  assert.match(
    migration,
    /alter table public\.tenant_data_policies force row level security/,
  );
  assert.match(
    migration,
    /create policy tenant_data_policies_deny_all[\s\S]*using \(false\)[\s\S]*with check \(false\)/,
  );
  assert.match(
    migration,
    /revoke all on table public\.tenant_data_policies[\s\S]*from public, anon, authenticated/,
  );
  assert.match(migration, /retention_days between 30 and 3650/);
  assert.match(migration, /default_export_format in \('json', 'csv'\)/);
});

test("privacy reads and writes bind to verified selected tenant owners/admins", () => {
  for (const functionName of [
    "tenant_get_data_policy",
    "tenant_set_data_policy",
    "tenant_prepare_data_export",
  ]) {
    const start = migration.indexOf(`function public.${functionName}`);
    assert.notEqual(start, -1);
    const end = migration.indexOf("$$;", start);
    const body = migration.slice(start, end);
    assert.match(body, /app_private\.learning_rpc_context\(\)/);
    assert.match(
      body,
      /caller\.identity_role not in \('tenant_owner', 'tenant_admin'\)/,
    );
  }

  assert.match(migration, /expected_version bigint/);
  assert.match(migration, /'version_conflict'/);
  assert.match(migration, /tenant\.data_policy\.updated/);
});

test("tenant export is bounded, tenant-scoped, audited and omits secret references", () => {
  const start = migration.indexOf(
    "function public.tenant_prepare_data_export",
  );
  const end = migration.indexOf("$$;", start);
  const body = migration.slice(start, end);
  assert.match(body, /where m\.tenant_id = caller\.tenant_id/);
  assert.match(body, /limit 10000/);
  assert.match(body, /tenant\.data_export\.generated/);
  assert.doesNotMatch(body, /\.storage_key|\.provider_request_ref|\.credential_vault_ref/);
  assert.match(body, /'truncated', export_truncated/);
});

test("tenant plan usage reuses the tenant billing RPC without exposing cost or margin", () => {
  const start = migration.indexOf(
    "function public.tenant_get_billing_summary",
  );
  const end = migration.indexOf("$$;", start);
  const body = migration.slice(start, end);
  assert.match(body, /monthToDateBilledMicro/);
  assert.match(body, /dailyBudgetMicro/);
  assert.match(body, /maxCallsPerDay/);
  assert.match(body, /enabledSections/);
  assert.doesNotMatch(body, /windowTrueCostMicro|marginMultiplier|fixedMarkupMicro/);
});

test("settings APIs enforce session and origin boundaries and downloads are safe attachments", () => {
  assert.match(policyRoute, /authenticatedLearningClient/);
  assert.match(policyRoute, /assertSameOrigin\(request\)/);
  assert.match(usageRoute, /tenant_get_billing_summary| getTenantPlanUsage/);
  assert.match(exportRoute, /authenticatedLearningClient/);
  assert.match(exportRoute, /assertSameOrigin\(request\)/);
  assert.match(exportRoute, /Content-Disposition/);
  assert.match(exportRoute, /X-Content-Type-Options/);
  assert.match(exportRoute, /\^\[=\+\\-@\]/);
});

test("settings routes to owner views independently of the hidden platform panel", () => {
  assert.match(settingsPanel, /view: "plan-usage"/);
  assert.match(settingsPanel, /view: "privacy-data"/);
  assert.doesNotMatch(
    settingsPanel,
    /label: "Plan & usage"[\s\S]{0,300}payload\.sections\.platform/,
  );
  assert.match(details, /Download JSON/);
  assert.match(details, /Download CSV/);
  assert.match(details, /There is no destructive purge control/);
  assert.doesNotMatch(details, />\s*Purge\s*</);
});

test("the post-migration verification checks grants, RLS and sensitive boundaries", () => {
  assert.match(verification, /relforcerowsecurity/);
  assert.match(verification, /has_table_privilege/);
  assert.match(verification, /has_function_privilege/);
  assert.match(verification, /pg_get_functiondef/);
  assert.match(verification, /storage_key/);
});
