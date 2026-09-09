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

test("an unknown type or a missing token is the same opaque failure", () => {
  assert.match(source, /otpTypes\.has\(type\)/);
  assert.match(source, /error", "callback_failed"/);
});
