import { NextResponse } from "next/server";
import { assertSameOrigin } from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const supabase = await createServerSupabaseClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The response intentionally reveals no session/configuration details.
  }
  return NextResponse.redirect(
    new URL("/auth/sign-in?status=signed_out", request.url),
    303,
  );
}
