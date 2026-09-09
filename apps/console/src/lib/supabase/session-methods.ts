type AuthenticationMethod = { method?: unknown };

/**
 * True when every authentication method on the token is an emailed one-time
 * link and none is a password (or an external provider, which has no
 * password to set). `amr` is what Supabase records at sign-in; a session
 * whose `amr` is absent is treated as complete, never as unfinished, so a
 * token shape this code does not recognise cannot lock anyone out.
 */
export function sessionLacksPassword(claims: unknown): boolean {
  const amr = (claims as { amr?: unknown } | null | undefined)?.amr;
  if (!Array.isArray(amr) || amr.length === 0) return false;
  const methods = amr
    .map((entry: AuthenticationMethod) => (typeof entry?.method === "string" ? entry.method : ""))
    .filter(Boolean);
  if (methods.length === 0) return false;
  const linkOnly = new Set(["otp", "magiclink", "recovery", "invite"]);
  return methods.every((method) => linkOnly.has(method));
}

