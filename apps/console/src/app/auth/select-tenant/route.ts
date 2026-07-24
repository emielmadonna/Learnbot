import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  refreshClaimsWhenRequired,
  requireVerifiedUser,
  selectTenant,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

function redirectToOnboarding(request: Request, key: "error" | "status", value: string) {
  const url = new URL("/onboarding", request.url);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  let supabase;
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    const tenantId = String(form.get("tenantId") ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tenantId)) {
      return redirectToOnboarding(request, "error", "selection_failed");
    }
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
    const operationId = crypto.randomUUID();
    await selectTenant(supabase, {
      tenantId,
      requestId: `web-select:${operationId}`,
      traceId: `web:${operationId}`,
    });
  } catch {
    return redirectToOnboarding(request, "error", "selection_failed");
  }

  try {
    await refreshClaimsWhenRequired(supabase);
  } catch {
    return redirectToOnboarding(request, "error", "refresh_failed");
  }
  return redirectToOnboarding(request, "status", "tenant_selected");
}
