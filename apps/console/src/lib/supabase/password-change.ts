import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Set a new password and PROVE it, in one step.
 *
 * `updateUser({ password })` answering ok is not enough for a person to act
 * on: the browser they are in is already signed in (by a recovery link, an
 * invitation, or a temporary password), so it keeps working whether or not
 * the new password does, and they discover the truth only on their next
 * device — locked out, with nothing to go on. That is exactly what happened
 * to the platform owner on 2026-09-09.
 *
 * So after the update this signs in again with the new password, on the
 * same account. If that fails, the change is reported as NOT done, with
 * Supabase's own reason, and the person stays on the page. If it succeeds,
 * the session in this browser is now a password session — which is also
 * what lets the proxy stop treating it as an unfinished recovery.
 */
export type PasswordChangeOutcome =
  | { ok: true }
  | { ok: false; stage: "update" | "verify"; reason: string };

function describe(error: { message?: unknown; code?: unknown } | null | undefined): string {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const code = typeof error?.code === "string" ? error.code : "";
  if (/reauthentication/i.test(message)) {
    return "Supabase requires a fresh sign-in before a password change on this project (Secure password change is on).";
  }
  if (/same password|different from the old/i.test(message)) {
    return "That is already the current password. Choose a different one.";
  }
  if (/weak|should contain|at least/i.test(message)) {
    return `Supabase refused the password: ${message}`;
  }
  return message || code || "no reason was given";
}

export async function setPasswordAndProve(
  supabase: SupabaseClient,
  password: string,
): Promise<PasswordChangeOutcome> {
  const current = await supabase.auth.getUser();
  const email = current.data.user?.email?.trim();
  if (current.error || !email) {
    return { ok: false, stage: "update", reason: "this browser is no longer signed in — open the link again" };
  }

  const updated = await supabase.auth.updateUser({ password });
  if (updated.error) {
    return { ok: false, stage: "update", reason: describe(updated.error) };
  }

  // The proof. A session established by a password is what every other
  // device will need, so establish one here, now, or say that it cannot be.
  const proven = await supabase.auth.signInWithPassword({ email, password });
  if (proven.error || !proven.data.session) {
    return {
      ok: false,
      stage: "verify",
      reason: describe(proven.error) || "sign-in with the new password was refused",
    };
  }
  return { ok: true };
}

/** Copy for the two stages, so both forms say the same true thing. */
export function passwordChangeMessage(outcome: Exclude<PasswordChangeOutcome, { ok: true }>): string {
  return outcome.stage === "update"
    ? `Your password was not changed: ${outcome.reason}. Keep this page open and try again.`
    : `Supabase accepted the new password but signing in with it failed: ${outcome.reason}. Your password is NOT usable yet — try again or choose a different one.`;
}
