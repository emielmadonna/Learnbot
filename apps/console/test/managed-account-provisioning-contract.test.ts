import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const edgeFunction = source(
  "../../../infra/supabase/functions/learning-admin-users/index.ts",
);
const migration = source(
  "../../../infra/supabase/migrations/20260724212622_managed_account_provisioning_diagnostics.sql",
);
const adminRoute = source("../src/app/api/admin/users/route.ts");

test("managed account failures expose safe diagnostics and retry cleanup", () => {
  assert.match(edgeFunction, /rpcDiagnostic/);
  assert.match(edgeFunction, /providerCode/);
  assert.match(edgeFunction, /account_cleanup_failed/);
  assert.match(edgeFunction, /deleteUser\(/);
  assert.match(edgeFunction, /for \(let attempt = 0; attempt < 2/);
  assert.doesNotMatch(edgeFunction, /temporaryPassword.*diagnostic/i);
  assert.doesNotMatch(edgeFunction, /error\.message.*json|json.*error\.message/i);
});

test("managed account RPC is staged, locked, and idempotent", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /idempotentReplay/);
  assert.match(migration, /stage := 'identity_principal'/);
  assert.match(migration, /stage := 'access_account'/);
  assert.match(migration, /'sqlstate', SQLSTATE/);
  assert.match(migration, /get stacked diagnostics/);
  assert.match(migration, /grant execute on function public\.admin_provision_auth_user/);
});

test("admin route keeps provisioning failures tenant-admin protected", () => {
  assert.match(adminRoute, /getCurrentTenantContext/);
  assert.match(adminRoute, /tenant_owner/,);
  assert.match(adminRoute, /tenant_admin/);
  assert.match(adminRoute, /learning-admin-users/);
  assert.match(adminRoute, /getSession\(\)/);
  assert.match(adminRoute, /Authorization: `Bearer \$\{accessToken\}`/);
});
