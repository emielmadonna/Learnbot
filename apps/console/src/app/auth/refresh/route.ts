import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  refreshClaimsWhenRequired,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export async function POST(request: Request) {
  const url = new URL("/onboarding", request.url);
  try {
    assertSameOrigin(request);
    const supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
    await refreshClaimsWhenRequired(supabase);
    url.searchParams.set("status", "session_refreshed");
  } catch {
    url.searchParams.set("error", "refresh_failed");
  }
  return NextResponse.redirect(url, 303);
}
