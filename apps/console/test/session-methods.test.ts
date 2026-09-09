import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { sessionLacksPassword } from "../src/lib/supabase/session-methods";

/**
 * A session that only an emailed link established must not reach the
 * workspace; every other shape must. Getting the second half wrong locks
 * people out, so the unknown cases are asserted as "complete".
 */
test("a recovery-link session lacks a password", () => {
  assert.equal(sessionLacksPassword({ amr: [{ method: "otp", timestamp: 1 }] }), true);
  assert.equal(sessionLacksPassword({ amr: [{ method: "magiclink" }] }), true);
  assert.equal(sessionLacksPassword({ amr: [{ method: "recovery" }, { method: "otp" }] }), true);
});

test("a password, OAuth, SSO or unknown session is complete", () => {
  assert.equal(sessionLacksPassword({ amr: [{ method: "password", timestamp: 1 }] }), false);
  assert.equal(sessionLacksPassword({ amr: [{ method: "otp" }, { method: "password" }] }), false);
  assert.equal(sessionLacksPassword({ amr: [{ method: "oauth" }] }), false);
  assert.equal(sessionLacksPassword({ amr: [{ method: "sso/saml" }] }), false);
  assert.equal(sessionLacksPassword({ amr: [] }), false);
  assert.equal(sessionLacksPassword({}), false);
  assert.equal(sessionLacksPassword(null), false);
  assert.equal(sessionLacksPassword({ amr: "otp" }), false);
  assert.equal(sessionLacksPassword({ amr: [{ nope: true }] }), false);
});

test("the proxy sends link-only sessions to the reset page, after the managed-account check", () => {
  const proxy = readFileSync(resolve(process.cwd(), "src/proxy.ts"), "utf8");
  const managed = proxy.indexOf("must_change_password === true");
  const linkOnly = proxy.indexOf("sessionLacksPassword(identity.data?.claims)");
  assert.ok(managed > 0 && linkOnly > managed, "managed accounts still go to change-password first");
  assert.match(proxy.slice(linkOnly), /destination\.pathname = "\/auth\/reset-password"/);
});

test("both password forms set the password and prove it before moving on", () => {
  for (const file of ["src/app/auth/reset-password/reset-password-form.tsx", "src/app/auth/change-password/password-form.tsx"]) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.match(source, /setPasswordAndProve\(supabase, password\)/, `${file} must prove the password`);
    assert.doesNotMatch(source, /supabase\.auth\.updateUser\(/, `${file} must not update without proving`);
  }
  const helper = readFileSync(resolve(process.cwd(), "src/lib/supabase/password-change.ts"), "utf8");
  assert.match(helper, /signInWithPassword\(\{ email, password \}\)/);
});
