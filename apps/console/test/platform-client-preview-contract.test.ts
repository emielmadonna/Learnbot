import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const panel = source("../src/components/sections/platform-panel.tsx");
const banner = source(
  "../src/components/app-shell/platform-client-preview-banner.tsx",
);
const shell = source("../src/components/app-shell/app-shell.tsx");
const migration = source(
  "../../../infra/supabase/migrations/20260725123000_tenant_section_control.sql",
);

test("client preview enters through the existing durable audited platform session", () => {
  assert.match(panel, /platformWrite\(\{ action: "enter", tenantId \}\)/);
  assert.match(panel, /parsePlatformTenantEntry/);
  assert.match(panel, /refreshBrowserClaims/);
  assert.match(panel, /destination = "\/app"/);
  assert.match(panel, /window\.location\.assign\(destination\)/);
  assert.match(panel, /knowledgeStartDestination\(issued\.knowledgeStart\)/);
  assert.match(panel, /platform-client-preview/);
  assert.match(migration, /platform_admin_enter_tenant/);
  assert.match(migration, /platform\.tenant\.enter/);
  assert.match(migration, /platform_admin_entered_client_workspace/);
});

test("preview is explicitly the platform operator, never an impersonated client identity", () => {
  assert.match(panel, /No client user is impersonated/);
  assert.match(panel, /host-provisioned tenant-admin\s+membership/);
  assert.match(banner, /You are still signed in as yourself/);
  assert.match(banner, /No client user is being impersonated/);
  assert.doesNotMatch(panel, /impersonatedUserId|assumeUser|userToImpersonate/);
  assert.doesNotMatch(banner, /impersonatedUserId|assumeUser|userToImpersonate/);
});

test("the global banner verifies the durable session and always exposes an exit", () => {
  assert.match(shell, /PlatformClientPreviewBanner/);
  assert.match(banner, /activePlatformSessions/);
  assert.match(banner, /candidate\.isCaller === true/);
  assert.match(banner, /JSON\.stringify\(\{ action: "exit" \}\)/);
  assert.match(banner, /supabase\.auth\.refreshSession\(\)/);
  assert.match(banner, /Return to platform/);
  assert.match(banner, /window\.location\.assign\("\/app"\)/);
  assert.match(migration, /platform_admin_exit_tenant/);
  assert.match(migration, /platform\.tenant\.exit/);
});

test("ordinary tenant sessions do not probe platform detail", () => {
  // The probe is gated on the SERVER-DERIVED role, never on browser storage.
  //
  // `sessionStorage` was the original gate and it was wrong twice over. It is
  // ephemeral, so a second tab or a browser restart lost the key while the
  // durable server-side entry stayed open — and because
  // `resolveAppAccessMode` returns `tenant_workspace` for as long as a tenant
  // is selected, the operator was then stranded inside the client workspace
  // with no route back to the control plane. It is also writable from
  // devtools, so it never actually stopped a curious tenant member from
  // probing. `role` resolves from `platform_admin_is_authorized` on the
  // server and does neither.
  assert.match(banner, /role !== "platform_owner"/);
  assert.doesNotMatch(banner, /sessionStorage\.getItem/);
  // The shell must hand the role down, or the gate silently hides the exit
  // from everyone — the exact failure this test now guards.
  assert.match(shell, /<PlatformClientPreviewBanner[\s\S]*?role=\{payload\.role\}/);
  // Exiting still clears the marker the platform panel writes on entry.
  assert.match(banner, /sessionStorage\.removeItem\("platform-client-preview"\)/);
});
