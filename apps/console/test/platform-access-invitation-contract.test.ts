import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveAppAccessMode } from "../src/app/app/access-mode";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string) {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing contract start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing contract end: ${end}`);
  return value.slice(startIndex, endIndex);
}

test("platform authorization takes precedence when no tenant is selected", () => {
  assert.equal(
    resolveAppAccessMode({
      platformAuthorized: true,
      selectedTenant: false,
    }),
    "platform_control_plane",
  );
  assert.equal(
    resolveAppAccessMode({
      platformAuthorized: false,
      selectedTenant: false,
    }),
    "onboarding",
  );
  assert.equal(
    resolveAppAccessMode({
      platformAuthorized: true,
      selectedTenant: true,
    }),
    "tenant_workspace",
  );

  const appPage = source("../src/app/app/page.tsx");
  // Both indices must be guarded before they are compared. Without the
  // `> -1` checks a missing `platform_admin_is_authorized` yields -1, and
  // `-1 < someRealIndex` is true — so this assertion passed even if the
  // platform-authorization check were deleted outright. The sibling test
  // below already guards its own lookup; this one did not.
  const authorizationCheck = appPage.indexOf("platform_admin_is_authorized");
  const onboardingBranch = appPage.indexOf('accessMode === "onboarding"');
  assert.ok(
    authorizationCheck > -1,
    "the platform authorization check must exist",
  );
  assert.ok(onboardingBranch > -1, "the onboarding access branch must exist");
  assert.ok(
    authorizationCheck < onboardingBranch,
    "platform authorization must be resolved before the onboarding branch",
  );
  assert.match(appPage, /workspace: null/);
  assert.match(appPage, /platform: true/);
});

test("operator entitlements survive a client's own section catalogue", () => {
  const appPage = source("../src/app/app/page.tsx");

  // The carve-out has to be applied AFTER the tenant catalogue loop so it also
  // holds on the paths where that loop never runs — `tenant_get_sections`
  // erroring, or returning an empty catalogue. Ordering is the whole contract
  // here: an operator who loses `platform` is stranded inside the client
  // workspace with no route back, and one who loses `insights` cannot see the
  // learner questions they need in order to support the account.
  const tenantLoop = appPage.indexOf(
    "permitted[key] = permitted[key] && section.enabled",
  );
  const carveOut = appPage.indexOf("if (access.canManagePlatform) {");
  assert.ok(tenantLoop > -1, "tenant section gate must exist");
  assert.ok(
    carveOut > tenantLoop,
    "operator carve-out must be applied after the tenant catalogue loop",
  );
  assert.match(
    appPage,
    /permitted\.platform = true;\s*permitted\.insights = true;/,
  );

  // ...and it must only ever WIDEN the operator's view. A client switching
  // results off still has to hide results from that client.
  assert.match(
    appPage,
    /permitted\[key\] = permitted\[key\] && section\.enabled/,
  );
});

test("the widget section became flaggable without darkening it for anyone", () => {
  const migration = source(
    "../../../infra/supabase/migrations/20260731081000_tenant_capability_control.sql",
  );
  const platformRpc = source("../src/lib/supabase/platform-rpc.ts");

  // `widget` was a console PanelKey with no catalogue row and no place in the
  // table's own six-key check constraint, so it could not be flagged at all.
  assert.match(migration, /\('widget'::text, true, 6\)/u);
  assert.match(platformRpc, /"platform",\s*(?:\/\/[^\n]*\n\s*)*"widget",/u);

  // The unnamed inline constraint from 20260725123000 has to go, or every
  // widget write fails a check the definitions function says is valid.
  assert.match(migration, /drop constraint %I/u);
  assert.match(
    migration,
    /add constraint tenant_sections_section_key_check[\s\S]*?'widget'/u,
  );

  // `billing_apply_plan_entitlements` switches off every catalogue key that is
  // not entitled. A new key that is not core would go dark on the next plan
  // projection for every tenant.
  assert.match(
    migration,
    /billing_core_sections[\s\S]*?array\['agent', 'course', 'people', 'settings', 'widget'\]/u,
  );
});

test("client capabilities are a durable, audited, platform-only record", () => {
  const migration = source(
    "../../../infra/supabase/migrations/20260731081000_tenant_capability_control.sql",
  );
  const platformRoute = source("../src/app/api/platform/route.ts");
  const panel = source("../src/components/sections/platform-panel.tsx");
  const providerRoute = source("../src/app/api/agent/provider/route.ts");
  const providerBoundary = source(
    "../../../infra/supabase/functions/learning-provider-credentials/index.ts",
  );
  const providerCapabilityMigration = source(
    "../../../infra/supabase/migrations/20260801090000_provider_key_capability_and_published_avatar.sql",
  );

  // Mirrors the section pattern: tenant-readable table, no write policy for
  // authenticated callers, writes only through the definer RPC.
  assert.match(migration, /create table public\.tenant_capability_grants/u);
  assert.match(
    migration,
    /alter table public\.tenant_capability_grants force row level security/u,
  );
  assert.match(migration, /tenant_capability_grants_deny_anon/u);
  assert.doesNotMatch(
    migration,
    /create policy [\s\S]*?on public\.tenant_capability_grants\s+for (insert|update|delete)/u,
  );
  assert.match(
    migration,
    /grant select on public\.tenant_capability_grants to authenticated/u,
  );

  const setter = between(
    migration,
    "create or replace function public.platform_admin_set_tenant_capability(",
    "-- 6. Execution boundary",
  );
  assert.match(setter, /platform_admin_is_authorized\(\)/u);
  assert.match(setter, /platform_admin_write_audit/u);
  assert.match(setter, /'platform\.tenant\.capability\.set'/u);

  // Model choice is the only capability that changes what an answer costs, so
  // it is granted explicitly rather than by omission.
  assert.match(migration, /\('model_choice'::text, false, 4\)/u);

  // The whole path is wired: API action, panel toggle, panel read.
  assert.match(platformRoute, /action === "capability"/u);
  assert.match(platformRoute, /isPlatformCapabilityKey\(input\.capabilityKey\)/u);
  assert.match(platformRoute, /getPlatformTenantCapabilities/u);
  assert.match(panel, /void toggleCapability\(/u);
  assert.match(panel, /action: "capability"/u);

  // Provider-key management is now one of the grants and is enforced on both
  // server boundaries. The panel stays honest that the older grants are not
  // all enforced yet.
  assert.match(providerCapabilityMigration, /'provider_api_key'::text, false/u);
  assert.match(providerRoute, /provider_api_key/u);
  assert.match(providerBoundary, /provider_api_key/u);
  assert.match(panel, /capabilityEnforcementNote/u);
  assert.match(panel, /Provider API-key access is enforced/u);
});

test("managed access uses provider invitations and never returns a password", () => {
  const edgeFunction = source(
    "../../../infra/supabase/functions/learning-admin-users/index.ts",
  );
  const accessManager = source(
    "../src/app/app/admin/users/user-access-manager.tsx",
  );
  const inviteBridge = source("../src/app/auth/invite/session-bridge.tsx");
  const changePasswordPage = source(
    "../src/app/auth/change-password/page.tsx",
  );
  const changePasswordForm = source(
    "../src/app/auth/change-password/password-form.tsx",
  );
  const migration = source(
    "../../../infra/supabase/migrations/20260731011747_auth_invitation_delivery.sql",
  );

  assert.match(edgeFunction, /auth\.admin\.inviteUserByEmail/);
  assert.doesNotMatch(edgeFunction, /generateTemporaryPassword|temporaryPassword/);
  assert.doesNotMatch(edgeFunction, /auth\.admin\.createUser/);
  assert.doesNotMatch(accessManager, /temporaryPassword|Copy sign-in details/);
  assert.match(accessManager, /Send invitation/);
  assert.match(inviteBridge, /auth\.setSession/);
  assert.match(inviteBridge, /auth\.exchangeCodeForSession/);
  assert.match(inviteBridge, /mode=invitation/);
  assert.match(changePasswordPage, /parameters\.mode === "invitation"/);
  assert.match(
    changePasswordPage,
    /state\.mustChangePassword \|\| invitationChange/,
  );
  assert.match(changePasswordForm, /auth_complete_password_change/);
  assert.match(migration, /auth_invitation_delivery_events/);
  assert.match(migration, /'provider_failed'/);
  assert.match(migration, /platform_administrators/);
  assert.match(migration, /owner_identity_conflict/);
  assert.match(migration, /auth_complete_password_change/);
});

test("provider delivery is resumable and cannot activate tenant privilege", () => {
  const edgeFunction = source(
    "../../../infra/supabase/functions/learning-admin-users/index.ts",
  );
  const migration = source(
    "../../../infra/supabase/migrations/20260731011747_auth_invitation_delivery.sql",
  );
  const providerCompletion = between(
    migration,
    "create or replace function public.admin_complete_auth_invitation(",
    "create or replace function public.auth_current_access_state()",
  );
  const acceptance = between(
    migration,
    "create or replace function public.auth_complete_password_change(",
    "revoke execute on function public.admin_prepare_auth_invitation(",
  );

  assert.match(migration, /request_fingerprint text not null/);
  assert.match(migration, /'idempotency_conflict'/);
  assert.match(migration, /'provider_sending'/);
  assert.match(migration, /'provider_created'/);
  assert.match(migration, /'expired'/);
  assert.match(migration, /admin_revoke_auth_invitation/);
  assert.match(
    migration,
    /initiated_by_auth_user_id uuid references auth\.users\(id\) on delete set null/,
  );
  assert.match(
    migration,
    /Immutable audit rows retain the actor UUID as a historical snapshot/,
  );
  assert.doesNotMatch(
    migration,
    /actor_auth_user_id uuid references auth\.users/,
  );
  assert.doesNotMatch(
    providerCompletion,
    /insert into public\.identity_memberships/,
  );
  assert.doesNotMatch(
    providerCompletion,
    /insert into public\.memberships/,
  );
  assert.doesNotMatch(
    providerCompletion,
    /insert into app_private\.user_access_accounts/,
  );
  assert.doesNotMatch(providerCompletion, /tenant_owner_claims/);
  assert.match(acceptance, /insert into public\.identity_memberships/);
  assert.match(acceptance, /nullif\(u\.encrypted_password, ''\) is not null/);
  assert.match(acceptance, /'active'/);
  assert.match(acceptance, /'invitation'/);
  assert.match(acceptance, /tenant_owner_claims/);
  assert.match(acceptance, /'auth\.invitation\.accept'/);

  assert.match(
    edgeFunction,
    /admin_begin_auth_invitation_provider_attempt/,
  );
  assert.match(
    edgeFunction,
    /admin_resolve_auth_invitation_provider_user/,
  );
  assert.match(
    edgeFunction,
    /admin_record_auth_invitation_provider_user/,
  );
  assert.match(edgeFunction, /resetPasswordForEmail/);
  assert.match(edgeFunction, /invitation_audit_failed/);
  assert.match(edgeFunction, /invitation_cleanup_failed/);
});

test("workspace people includes active owners and safe pending invitations", () => {
  const accessManager = source(
    "../src/app/app/admin/users/user-access-manager.tsx",
  );
  const migration = source(
    "../../../infra/supabase/migrations/20260731054000_admin_people_invitation_visibility.sql",
  );

  assert.match(accessManager, /Everyone active or invited/);
  assert.match(accessManager, /pendingInvitations/);
  assert.match(accessManager, /Invitation pending/);
  assert.match(migration, /public\.identity_memberships m/);
  assert.match(migration, /app_private\.supabase_auth_principal_links l/);
  assert.match(migration, /app_private\.auth_invitation_deliveries d/);
  assert.match(migration, /d\.tenant_id = caller\.tenant_id/);
  assert.match(migration, /i\.status = 'pending'/);
  assert.match(migration, /'pendingInvitations'/);
  assert.doesNotMatch(migration, /provider_error_(code|message)/);
  assert.doesNotMatch(migration, /'invitationId'/);
});

test("platform creation invites a separate owner and leaves learning empty", () => {
  const panel = source("../src/components/sections/platform-panel.tsx");
  const platformRoute = source("../src/app/api/platform/route.ts");
  const provisioning = source(
    "../../../infra/supabase/migrations/20260726090000_platform_admin_client_provisioning.sql",
  );

  assert.match(panel, /ownerDisplayName/);
  assert.match(panel, /ownerEmail/);
  assert.match(panel, /client\.inviteOwner/);
  assert.match(panel, /No temporary password or owner code needs to be shared/);
  assert.match(platformRoute, /role: "tenant_owner"/);
  assert.doesNotMatch(
    provisioning,
    /insert into public\.(courses|learning_sources|learning_chunks)/,
  );
});
