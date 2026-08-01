import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  getManagedAccessState,
  requireVerifiedUser,
} from "./auth-boundary";
import {
  LearningRpcError,
  requireLearningRpcSuccess,
} from "./learning-rpc";
import {
  createRequestSupabaseClient,
  createServerSupabaseClient,
} from "./server";

const safeCodes = new Set([
  "access_denied",
  "invalid_request",
  "request_denied",
  "tenant_selection_required",
]);

export async function authenticatedLearningClient(
  request: Request,
  options: { mutation?: boolean } = {},
) {
  const requestClient = createRequestSupabaseClient(request);
  // Cookie-authenticated mutations require same-origin CSRF protection.
  // A standard bearer token is not ambient browser authority, so authenticated
  // MCP/automation clients may mutate without fabricating an Origin header.
  if (options.mutation && requestClient === null) assertSameOrigin(request);
  const supabase = requestClient ?? (await createServerSupabaseClient());
  await requireVerifiedUser(supabase);
  const access = await getManagedAccessState(supabase);
  if (access.managed && access.mustChangePassword) {
    throw new AuthenticationBoundaryError(
      "auth.password_change_required",
      "The temporary password must be replaced before using this account.",
    );
  }
  return supabase;
}

export async function executeLearningRpc(
  supabase: SupabaseClient,
  name: string,
  input: Record<string, unknown> = {},
) {
  const response = await supabase.rpc(name, input);
  if (response.error) {
    throw new LearningRpcError("request_failed");
  }
  return requireLearningRpcSuccess(response.data);
}

export function learningRedirect(
  request: Request,
  kind: "error" | "status",
  value: string,
) {
  const requestUrl = new URL(request.url);
  const referer = request.headers.get("referer");
  let url = new URL("/app", requestUrl);
  if (referer) {
    try {
      const candidate = new URL(referer);
      if (
        candidate.origin === requestUrl.origin &&
        candidate.pathname === "/app"
      ) {
        url = candidate;
      }
    } catch {
      // A malformed or cross-origin Referer never controls the redirect.
    }
  }
  url.searchParams.set(kind, value);
  return NextResponse.redirect(url, 303);
}

export function safeLearningError(error: unknown) {
  if (error instanceof LearningRpcError && safeCodes.has(error.code)) {
    return error.code;
  }
  return "request_failed";
}
