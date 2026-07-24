import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  developmentFixturesAllowed,
  fixturePreviewEnabled,
} from "./lib/deployment-mode";
import { readSupabasePublicConfig } from "./lib/supabase/config";

export async function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname.startsWith("/dev") &&
    !developmentFixturesAllowed()
  ) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  if (
    request.nextUrl.pathname.startsWith("/dev") &&
    process.env.NODE_ENV === "production" &&
    fixturePreviewEnabled()
  ) {
    const authorization = request.headers.get("authorization");
    const expected = process.env.LEARNINGBOT_FIXTURE_PREVIEW_AUTHORIZATION;
    if (!expected || authorization !== `Bearer ${expected}`) {
      return new NextResponse("Not found", {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }

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
    await supabase.auth.getUser();
  } catch {
    // Configuration and authentication errors are handled fail-closed by the
    // destination route, which can render a useful recovery state.
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/onboarding/:path*", "/auth/:path*", "/dev/:path*"],
};
