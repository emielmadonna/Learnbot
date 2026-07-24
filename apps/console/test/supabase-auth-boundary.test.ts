import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  assertSameOrigin,
  refreshClaimsWhenRequired,
  requireVerifiedUser,
  safeRelativePath,
  validateTenantBootstrapInput,
} from "../src/lib/supabase/auth-boundary";
import {
  readSupabasePublicConfig,
  SupabaseConfigurationError,
} from "../src/lib/supabase/config";
import {
  OnboardingRpcError,
  parseOnboardingSnapshot,
  requireOnboardingRpcSuccess,
} from "../src/lib/supabase/onboarding-rpc";

test("public Supabase configuration requires an allowed URL and publishable key", () => {
  assert.throws(
    () => readSupabasePublicConfig({}),
    SupabaseConfigurationError,
  );
  assert.throws(
    () =>
      readSupabasePublicConfig({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "service-role-value",
      }),
    SupabaseConfigurationError,
  );
  assert.deepEqual(
    readSupabasePublicConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-only",
    }),
    {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test-only",
    },
  );
});

test("post-auth redirects only accept local relative paths", () => {
  assert.equal(safeRelativePath("/app?tab=learning"), "/app?tab=learning");
  assert.equal(safeRelativePath("https://attacker.test"), "/onboarding");
  assert.equal(safeRelativePath("//attacker.test/path"), "/onboarding");
  assert.equal(safeRelativePath("/\\attacker.test"), "/onboarding");
  assert.equal(safeRelativePath("/app\u0000evil"), "/onboarding");
});

test("bootstrap input is bounded and normalized before the RPC", () => {
  assert.deepEqual(
    validateTenantBootstrapInput({
      slug: "  Northstar-Labs ",
      displayName: " Northstar Labs ",
      assistantName: " Estie ",
      primaryColor: "#635bff",
      accentColor: "#00a88f",
      region: "",
    }),
    {
      slug: "northstar-labs",
      displayName: "Northstar Labs",
      assistantName: "Estie",
      primaryColor: "#635BFF",
      accentColor: "#00A88F",
      region: null,
    },
  );
  assert.throws(
    () =>
      validateTenantBootstrapInput({
        slug: "No spaces allowed",
        displayName: "Tenant",
        assistantName: "Estie",
        primaryColor: "#635BFF",
        accentColor: "#00A88F",
      }),
    /workspace URL/i,
  );
});

test("mutating auth routes require an exact same-origin POST", () => {
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request("https://learning.example/auth/bootstrap", {
        method: "POST",
        headers: { origin: "https://learning.example" },
      }),
    ),
  );
  assert.throws(
    () =>
      assertSameOrigin(
        new Request("https://learning.example/auth/bootstrap", {
          method: "POST",
          headers: { origin: "https://attacker.test" },
        }),
      ),
    /origin/i,
  );
});

test("verified-user guard rejects anonymous and unverified identities", async () => {
  const anonymousClient = {
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: "anonymous",
            is_anonymous: true,
            email_confirmed_at: null,
            phone_confirmed_at: null,
          },
        },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;

  await assert.rejects(
    () => requireVerifiedUser(anonymousClient),
    /verified sign-in/i,
  );
});

test("stale tenant claims trigger and verify one authenticated refresh", async () => {
  let refreshed = false;
  let contextReads = 0;
  const client = {
    auth: {
      refreshSession: async () => {
        refreshed = true;
        return { data: {}, error: null };
      },
      getUser: async () => ({
        data: {
          user: {
            id: "user-1",
            is_anonymous: false,
            email_confirmed_at: "2026-07-24T00:00:00Z",
          },
        },
        error: null,
      }),
    },
    rpc: async (name: string) => {
      assert.equal(name, "auth_current_tenant_context");
      contextReads += 1;
      return {
        data: [
          {
            selected: true,
            tenant_id: "16d80756-d5c7-4780-985b-e278b94e46ee",
            membership_id: "membership-1",
            principal_id: "principal-1",
            identity_role: "tenant_owner",
            app_role: "owner",
            selection_version: 1,
            claims_refresh_required: contextReads === 1,
          },
        ],
        error: null,
      };
    },
  } as unknown as SupabaseClient;

  const context = await refreshClaimsWhenRequired(client);
  assert.equal(refreshed, true);
  assert.equal(context.claimsRefreshRequired, false);
  assert.equal(context.identityRole, "tenant_owner");
});

test("production auth surface uses managed password access and no privileged key", () => {
  const boundary = readFileSync(
    new URL("../src/lib/supabase/auth-boundary.ts", import.meta.url),
    "utf8",
  );
  const signIn = readFileSync(
    new URL("../src/app/auth/sign-in/sign-in-form.tsx", import.meta.url),
    "utf8",
  );
  const callback = readFileSync(
    new URL("../src/app/auth/callback/route.ts", import.meta.url),
    "utf8",
  );

  for (const rpc of [
    "auth_bootstrap_tenant_owner",
    "auth_list_tenant_memberships",
    "auth_select_tenant",
    "auth_current_tenant_context",
  ]) {
    assert.match(boundary, new RegExp(rpc));
  }
  assert.match(signIn, /signInWithPassword/);
  assert.doesNotMatch(signIn, /signInWithOtp|signUp/);
  assert.match(callback, /exchangeCodeForSession/);
  assert.doesNotMatch(
    `${boundary}\n${signIn}\n${callback}`,
    /SERVICE_ROLE|sb_secret_/,
  );
});

test("durable onboarding parser branches on application denials", () => {
  assert.throws(
    () =>
      requireOnboardingRpcSuccess({
        ok: false,
        code: "policy_decision_required",
      }),
    (error: unknown) =>
      error instanceof OnboardingRpcError &&
      error.code === "policy_decision_required",
  );

  const snapshot = parseOnboardingSnapshot({
    ok: true,
    dataMode: "durable",
    tenant: {},
    onboarding: {},
    branding: {},
    identity: {},
    steps: [],
    invitations: [],
    launch: { ready: false, blockers: ["O-07", "O-13"] },
    audit: [],
  });
  assert.equal(snapshot.dataMode, "durable");
  assert.deepEqual(snapshot.launch.blockers, ["O-07", "O-13"]);
});

test("production onboarding uses exact 0012 RPCs and preserves policy gates", () => {
  const sources = [
    "../src/app/onboarding/profile/route.ts",
    "../src/app/onboarding/step/route.ts",
    "../src/app/onboarding/invitation/create/route.ts",
    "../src/app/onboarding/invitation/revoke/route.ts",
    "../src/app/onboarding/invitation/accept/route.ts",
    "../src/app/onboarding/durable-workspace.tsx",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  const combined = sources.join("\n");

  for (const rpc of [
    "onboarding_update_tenant_profile",
    "onboarding_update_step",
    "onboarding_create_invitation",
    "onboarding_revoke_invitation",
    "onboarding_accept_invitation",
  ]) {
    assert.match(combined, new RegExp(rpc));
  }
  assert.match(combined, /policy_decision_required|approved human policy decision/);
  assert.match(combined, /expected_version/);
  assert.match(combined, /target_invitation_id/);
  assert.match(combined, /refreshClaimsWhenRequired/);
});

test("invitation acceptance derives email and tenant from the authenticated RPC", () => {
  const acceptance = readFileSync(
    new URL(
      "../src/app/onboarding/invitation/accept/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(acceptance, /invited_email|tenant_id|actor|form\.get\("email"\)/);
  assert.match(acceptance, /target_invitation_id/);
});
