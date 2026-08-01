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
  assert.ok(
    appPage.indexOf("platform_admin_is_authorized") <
      appPage.indexOf('accessMode === "onboarding"'),
  );
  assert.match(appPage, /workspace: null/);
  assert.match(appPage, /platform: true/);
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
