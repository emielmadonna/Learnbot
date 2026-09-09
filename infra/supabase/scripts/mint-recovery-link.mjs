#!/usr/bin/env node
/**
 * Mint a one-time sign-in link for an existing account, without email.
 *
 *   node infra/supabase/scripts/mint-recovery-link.mjs someone@example.com
 *
 * For the operator who is locked out while Supabase's built-in mailer is
 * rate-limited (`over_email_send_rate_limit`, a few emails per hour), or whose
 * emailed link keeps failing on another device. Reads `SUPABASE_SECRET_KEY`
 * and `NEXT_PUBLIC_SUPABASE_URL` from apps/console/.env.local and asks the
 * Auth admin API for a recovery token; it prints the console URL that
 * `/auth/callback` verifies server-side (the `token_hash` shape), which works
 * in any browser.
 *
 * The printed link IS a credential: it signs that account in once, expires
 * (Auth → Email OTP expiry, one hour by default), and must not be pasted into
 * chat, tickets or logs. Nothing here reads or sets a password — the person
 * chooses their own on /auth/reset-password.
 *
 * Optional second argument: the public console origin (default
 * https://clone.stack-labs.ai).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The console app owns the Supabase client dependency; borrow its resolver so
// this runs from any working directory without its own package.json.
const consoleDirectory = fileURLToPath(new URL("../../../apps/console/", import.meta.url));
const { createClient } = createRequire(resolve(consoleDirectory, "package.json"))("@supabase/supabase-js");

const email = process.argv[2]?.trim();
const origin = (process.argv[3]?.trim() || "https://clone.stack-labs.ai").replace(/\/$/, "");
if (!email || !email.includes("@")) {
  console.error("usage: node infra/supabase/scripts/mint-recovery-link.mjs <email> [console-origin]");
  process.exit(2);
}

const envPath = resolve(consoleDirectory, ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^"|"$/g, "")];
    }),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error(`NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in ${envPath}`);
  process.exit(2);
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const result = await admin.auth.admin.generateLink({ type: "recovery", email });
if (result.error) {
  console.error(`Supabase refused: ${result.error.message}`);
  process.exit(1);
}
const hashed = result.data.properties?.hashed_token;
if (!hashed) {
  console.error("Supabase returned no hashed token; nothing to print.");
  process.exit(1);
}
const link = new URL("/auth/callback", origin);
link.searchParams.set("token_hash", hashed);
link.searchParams.set("type", "recovery");
link.searchParams.set("next", "/auth/reset-password");

console.log("");
console.log("One-time sign-in link for " + email + " (works in any browser, once, for a limited time):");
console.log("");
console.log(link.toString());
console.log("");
console.log("Open it, choose a new password on the page it lands on, then sign in normally.");
