import { NextResponse } from "next/server";
import {
  requireVerifiedUser,
  safeRelativePath,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const nextPath = safeRelativePath(requestUrl.searchParams.get("next"));
  const code = requestUrl.searchParams.get("code");
  const failureUrl = new URL("/auth/sign-in", requestUrl.origin);
  failureUrl.searchParams.set("error", "callback_failed");
  failureUrl.searchParams.set("next", nextPath);

  if (!code) {
    return NextResponse.redirect(failureUrl);
  }

  try {
    const supabase = await createServerSupabaseClient();
    const exchange = await supabase.auth.exchangeCodeForSession(code);
    if (exchange.error) {
      return NextResponse.redirect(failureUrl);
    }
    await requireVerifiedUser(supabase);
    return NextResponse.redirect(new URL(nextPath, requestUrl.origin));
  } catch {
    return NextResponse.redirect(failureUrl);
  }
}
