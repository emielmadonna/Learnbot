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

    // `getClaims` verifies the access token the same way `getUser` did, but it
    // prefers to do it locally: it reads the session (which is also what
    // refreshes an expiring token and writes the cookies back through `setAll`
    // above), then verifies the JWT signature with WebCrypto against the
    // project's published JWKS, which auth-js caches at module scope and so
    // reuses across every request on a warm instance.
    //
    // This runs on EVERY /app, /onboarding and /auth request, so it was the
    // single most repeated network round trip in the product. It is never
    // slower than what it replaces: on a project still signing with the legacy
    // shared HS256 secret there is no public key to verify against, and auth-js
    // falls back to exactly the `getUser` call that used to be here. The
    // speed-up arrives on its own once the project's JWT signing keys are
    // migrated to an asymmetric algorithm — no code change needed for that.
    //
    // Protected pages repeat this check before loading any tenant context.
    const identity = await supabase.auth.getClaims();
    const signedIn = Boolean(identity.data?.claims && !identity.error);
    const protectedWorkspace =
      request.nextUrl.pathname.startsWith("/app") ||
      request.nextUrl.pathname.startsWith("/onboarding");
    if (signedIn && protectedWorkspace) {
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
