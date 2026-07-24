import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  claimPreprovisionedTenantOwner,
  refreshClaimsWhenRequired,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";

function redirectWith(
  request: Request,
  kind: "error" | "status",
  value: string,
) {
  const url = new URL("/onboarding", request.url);
  url.searchParams.set(kind, value);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  let supabase;
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
    const operationId = crypto.randomUUID();
    await claimPreprovisionedTenantOwner(supabase, {
      slug: String(form.get("slug") ?? ""),
      claimToken: String(form.get("claimToken") ?? ""),
      requestId: `web-owner-claim:${operationId}`,
      traceId: `web:${operationId}`,
    });
    await refreshClaimsWhenRequired(supabase);
    return redirectWith(request, "status", "workspace_claimed");
  } catch {
    return redirectWith(request, "error", "owner_claim_failed");
  }
}
