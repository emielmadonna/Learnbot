import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AuthenticationBoundaryError,
  getCurrentTenantContext,
} from "../supabase/auth-boundary";
import { readSupabasePublicConfig } from "../supabase/config";
import { authenticatedLearningClient } from "../supabase/learning-route";

const AUTHOR_ROLES = new Set(["tenant_owner", "tenant_admin", "creator"]);
const ADMIN_ROLES = new Set(["tenant_owner", "tenant_admin"]);

export class SourceConnectorError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = "SourceConnectorError";
  }
}

export async function connectorRequestContext(
  request: Request,
  options: { mutation?: boolean; admin?: boolean } = {},
) {
  const supabase = await authenticatedLearningClient(
    request,
    options.mutation === undefined ? {} : { mutation: options.mutation },
  );
  const [{ data: userData, error: userError }, context] = await Promise.all([
    supabase.auth.getUser(),
    getCurrentTenantContext(supabase),
  ]);
  if (userError || !userData.user) {
    throw new AuthenticationBoundaryError(
      "auth.authentication_required",
      "A verified sign-in is required.",
    );
  }
  if (!context.selected || !context.tenantId) {
    throw new SourceConnectorError("tenant_selection_required", 409);
  }
  const allowed = options.admin ? ADMIN_ROLES : AUTHOR_ROLES;
  if (!context.identityRole || !allowed.has(context.identityRole)) {
    throw new SourceConnectorError("access_denied", 403);
  }
  return {
    supabase,
    userId: userData.user.id,
    tenantId: context.tenantId,
    identityRole: context.identityRole,
  };
}

export function createSourceConnectorServiceClient(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const secret =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!secret) {
    throw new SourceConnectorError("server_secret_required", 503);
  }
  const config = readSupabasePublicConfig({
    ...(environment.NEXT_PUBLIC_SUPABASE_URL === undefined
      ? {}
      : { NEXT_PUBLIC_SUPABASE_URL: environment.NEXT_PUBLIC_SUPABASE_URL }),
    ...(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY === undefined
      ? {}
      : {
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
            environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        }),
  });
  return createClient(config.url, secret, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

export async function connectorRpc(
  client: SupabaseClient,
  name: string,
  input: Record<string, unknown>,
) {
  const response = await client.rpc(name, input);
  if (response.error) {
    throw new SourceConnectorError("connector_database_unavailable", 503);
  }
  const result = response.data as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    const code =
      result && typeof result.code === "string"
        ? result.code
        : "connector_request_failed";
    const status =
      code === "access_denied"
        ? 403
        : code === "tenant_credential_not_configured"
          ? 409
          : 400;
    throw new SourceConnectorError(code, status);
  }
  return result;
}

export function requiredUuid(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new SourceConnectorError("invalid_request");
  }
  return value;
}

export function connectorErrorResponse(error: unknown) {
  const resolved =
    error instanceof SourceConnectorError
      ? error
      : error instanceof AuthenticationBoundaryError
        ? new SourceConnectorError("authentication_required", 401)
        : new SourceConnectorError("connector_request_failed", 500);
  return Response.json(
    { ok: false, code: resolved.code },
    {
      status: resolved.status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
