import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  bootstrapTenantOwner,
  refreshClaimsWhenRequired,
  requireVerifiedUser,
  validateTenantBootstrapInput,
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
  let created = false;
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    const input = validateTenantBootstrapInput({
      slug: String(form.get("slug") ?? ""),
      displayName: String(form.get("displayName") ?? ""),
      assistantName: String(form.get("assistantName") ?? "Corso"),
      primaryColor: String(form.get("primaryColor") ?? "#635BFF"),
      accentColor: String(form.get("accentColor") ?? "#00A88F"),
      region: String(form.get("region") ?? ""),
    });
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
    const operationId = crypto.randomUUID();
    const result = await bootstrapTenantOwner(supabase, {
      ...input,
      requestId: `web-bootstrap:${operationId}`,
      traceId: `web:${operationId}`,
    });
    created = result.created;
  } catch {
    return redirectWith(request, "error", "bootstrap_failed");
  }

  try {
    await refreshClaimsWhenRequired(supabase);
  } catch {
    return redirectWith(request, "error", "refresh_failed");
  }
  return redirectWith(
    request,
    "status",
    created ? "workspace_created" : "workspace_restored",
  );
}
