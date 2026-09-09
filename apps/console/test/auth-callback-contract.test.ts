import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/**
 * The emailed-link callback must accept both link shapes. The PKCE `code`
 * shape only works in the browser that requested it; the `token_hash` shape
 * works anywhere and is the one an operator can mint for a locked-out
 * account. Losing either silently locks people out with a message that says
 * "expired" when nothing expired.
 */
const source = readFileSync(
  resolve(process.cwd(), "src/app/auth/callback/route.ts"),
  "utf8",
);

test("the callback exchanges a PKCE code", () => {
  assert.match(source, /searchParams\.get\("code"\)/);
  assert.match(source, /exchangeCodeForSession\(code\)/);
});

test("the callback verifies a token_hash link server-side", () => {
  assert.match(source, /searchParams\.get\("token_hash"\)/);
  assert.match(source, /verifyOtp\(\{\s*token_hash/);
  for (const otpType of ["recovery", "invite", "magiclink"]) {
    assert.match(source, new RegExp(`"${otpType}"`), `${otpType} links must be accepted`);
  }
});

test("failures are kept apart so the person can act on them", () => {
  assert.match(source, /otpTypes\.has\(type\)/);
  for (const reason of ["link_expired", "link_other_browser", "link_incomplete", "link_rejected"]) {
    assert.match(source, new RegExp(`"${reason}"`), `${reason} must be a distinct outcome`);
  }
  assert.match(source, /error_code/, "Supabase's own error_code on the redirect is read");
  const signIn = readFileSync(resolve(process.cwd(), "src/app/auth/sign-in/page.tsx"), "utf8");
  for (const reason of ["link_expired", "link_other_browser", "link_incomplete", "link_rejected"]) {
    assert.match(signIn, new RegExp(`${reason}:`), `${reason} must have sign-in copy`);
  }
});
