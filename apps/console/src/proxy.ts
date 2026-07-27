import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readSupabasePublicConfig } from "./lib/supabase/config";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  try {
    const config = readSupabasePublicConfig();
    const supabase = createServerClient(config.url, config.publishableKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    // getUser verifies the access token with Supabase Auth. Protected pages
    // repeat this check before loading any tenant context.
    const identity = await supabase.auth.getUser();
    const protectedWorkspace =
      request.nextUrl.pathname.startsWith("/app") ||
      request.nextUrl.pathname.startsWith("/onboarding");
    if (identity.data.user && !identity.error && protectedWorkspace) {
      const access = await supabase.rpc("auth_current_access_state");
      const row = Array.isArray(access.data) ? access.data[0] : access.data;
      if (
        !access.error &&
        row &&
        typeof row === "object" &&
        "must_change_password" in row &&
        row.must_change_password === true
      ) {
        const destination = request.nextUrl.clone();
        const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        destination.pathname = "/auth/change-password";
        destination.search = "";
        destination.searchParams.set("next", requestedPath);
        return NextResponse.redirect(destination);
      }
    }
  } catch {
    // Configuration and authentication errors are handled fail-closed by the
    // destination route, which can render a useful recovery state.
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/onboarding/:path*", "/auth/:path*"],
};
