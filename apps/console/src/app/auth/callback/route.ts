import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  requireVerifiedUser,
  safeRelativePath,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

/**
 * GET /auth/callback
 *
 * The landing point for every emailed link (password reset, invitation,
 * magic link, email change). Two link shapes are accepted, because they fail
 * in different ways and a person locked out of their account needs at least
 * one of them to work:
 *
 *   1. `?code=…` — the PKCE flow `resetPasswordForEmail` starts in the
 *      browser. It can ONLY be exchanged by the browser that requested it,
 *      because the code verifier lives in that browser's cookies. Opening
 *      the email on a phone, in another profile, or after clearing cookies
 *      bounces to "invalid or has expired" even though the link is fine.
 *
 *   2. `?token_hash=…&type=recovery` — the server-verifiable shape Supabase
 *      recommends for server-rendered apps. It carries no browser state, so
 *      the link works wherever it is opened, and it is also what an operator
 *      can mint for a locked-out account (`generate_link` returns the hashed
 *      token). The email template must be pointed at this shape for it to
 *      arrive by mail: see docs/TESTING.md § OPS.
 *
 * Either way the session is written to cookies here (a Route Handler may),
 * the account is re-checked with `requireVerifiedUser`, and the person is
 * sent to `next` — for a reset, /auth/reset-password.
 */
const otpTypes: ReadonlySet<string> = new Set<EmailOtpType>([
  "recovery",
  "invite",
  "magiclink",
  "email",
  "signup",
  "email_change",
]);

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const nextPath = safeRelativePath(requestUrl.searchParams.get("next"));
  const code = requestUrl.searchParams.get("code");
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const type = requestUrl.searchParams.get("type");
  const failureUrl = new URL("/auth/sign-in", requestUrl.origin);
  failureUrl.searchParams.set("error", "callback_failed");
  failureUrl.searchParams.set("next", nextPath);

  if (!code && !(tokenHash && type && otpTypes.has(type))) {
    return NextResponse.redirect(failureUrl);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({
          token_hash: tokenHash as string,
          type: type as EmailOtpType,
        });
    if (result.error) {
      return NextResponse.redirect(failureUrl);
    }
    await requireVerifiedUser(supabase);
    return NextResponse.redirect(new URL(nextPath, requestUrl.origin));
  } catch {
    return NextResponse.redirect(failureUrl);
  }
}
