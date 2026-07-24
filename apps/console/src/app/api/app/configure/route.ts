import { NextResponse } from "next/server";

import {
  getCurrentTenantContext,
} from "../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  TenantConfigurationError,
  getTenantConfiguration,
  updateTenantConfiguration,
  validateTenantConfigurationPatch,
} from "../../../../lib/tenant-configuration";

function errorResponse(error: unknown) {
  if (error instanceof TenantConfigurationError) {
    const status =
      error.code === "access_denied"
        ? 403
        : error.code === "version_conflict"
          ? 409
          : error.code === "secret_write_not_supported"
            ? 422
            : error.code === "invalid_credential"
              ? 400
              : error.code === "credential_boundary_unavailable"
                ? 503
            : error.code === "tenant_selection_required"
              ? 401
              : error.code === "invalid_request" || error.code === "invalid_model"
                ? 400
                : 500;
    const messages: Record<string, string> = {
      access_denied: "Your current role cannot change tenant configuration.",
      version_conflict: "This configuration changed elsewhere. Reload and review it before saving again.",
      secret_write_not_supported:
        "Credential writes are not enabled until a durable server-side secret store is connected.",
      invalid_credential:
        "Enter a valid provider key. It is sent once to the server-side Vault boundary and is never returned.",
      credential_boundary_unavailable:
        "The secure provider credential boundary is temporarily unavailable.",
      tenant_selection_required: "Select a tenant before managing configuration.",
      invalid_request: "The configuration request was invalid.",
      invalid_model: "Choose a model using letters, numbers, dots, underscores, colons, or hyphens.",
    };
    return NextResponse.json(
      { code: error.code, message: messages[error.code] ?? "Configuration could not be loaded." },
      { status },
    );
  }
  return NextResponse.json(
    { code: "configuration_unavailable", message: "Tenant configuration is temporarily unavailable." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const context = await getCurrentTenantContext(supabase);
    const configuration = await getTenantConfiguration(supabase, context);
    return NextResponse.json(configuration, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, { mutation: true });
    const context = await getCurrentTenantContext(supabase);
    const patch = validateTenantConfigurationPatch(await request.json());
    const session = await supabase.auth.getSession();
    const authorization = request.headers.get("authorization") ??
      (session.data.session?.access_token
        ? `Bearer ${session.data.session.access_token}`
        : undefined);
    const configuration = await updateTenantConfiguration(
      supabase,
      context,
      patch,
      authorization ? { authorization } : {},
    );
    return NextResponse.json(configuration, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
