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
  "../../../infra/supabase/migrations/20260724213536_managed_account_provisioning_final.sql",
);

test("managed account provisioning keeps credentials server-side", () => {
  assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(edgeFunction, /auth\.admin\.createUser/);
  assert.match(edgeFunction, /passwordReturnedOnce: true/);
  assert.match(edgeFunction, /cache-control.*private, no-store/s);
  assert.doesNotMatch(edgeFunction, /localStorage|sessionStorage/);
  assert.doesNotMatch(edgeFunction, /error\.message.*json|json.*error\.message/i);
});

test("failed provisioning cleans up Auth users and keeps diagnostics safe", () => {
  assert.match(edgeFunction, /rpcDiagnostic/);
  assert.match(edgeFunction, /providerCode/);
  assert.match(edgeFunction, /account_cleanup_failed/);
  assert.match(edgeFunction, /for \(let attempt = 0; attempt < 2/);
  assert.match(edgeFunction, /deleteUser\(\s*created\.data\.user\.id,\s*true,?\s*\)/s);
});

test("the live provisioning SQL is staged, locked, idempotent, and fixes account status", () => {
  assert.match(migration, /'status', m\.status/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /idempotentReplay/);
  assert.match(migration, /'sqlstate', SQLSTATE/);
  assert.match(migration, /get stacked diagnostics/);
  assert.match(migration, /grant execute on function public\.admin_provision_auth_user/);
});
