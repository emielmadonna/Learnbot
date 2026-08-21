import type { SupabaseClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "./config";

/**
 * Calls the managed voice Edge boundary with the already-verified user's JWT.
 *
 * The publishable key identifies the Supabase project; it is not provider
 * authority. The OpenAI credential remains exclusively in Supabase Vault or
 * the Edge Function's encrypted secrets and is never copied into this process.
 */
export async function invokeManagedVoice(
  request: Request,
  supabase: SupabaseClient,
  body: BodyInit,
  contentType?: string,
  additions: Record<string, string> = {},
) {
  let authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ")) {
    const { data, error } = await supabase.auth.getSession();
    const accessToken = error ? "" : data.session?.access_token?.trim() ?? "";
    authorization = accessToken ? `Bearer ${accessToken}` : "";
  }
  if (!authorization.startsWith("Bearer ")) {
    return Response.json(
      { ok: false, code: "authentication_required" },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  const config = readSupabasePublicConfig();
  const headers = new Headers({
    accept: "*/*",
    apikey: config.publishableKey,
    authorization,
    ...additions,
  });
  if (contentType) headers.set("content-type", contentType);

  return fetch(`${config.url}/functions/v1/learning-provider-voice`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(50_000),
  });
}

/** Forwards only safe, voice-specific response headers from the Edge boundary. */
export function managedVoiceHeaders(
  response: Response,
  additions: Record<string, string> = {},
) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...additions,
  });
  for (const name of [
    "content-type",
    "retry-after",
    "x-ai-generated-voice",
    "x-voice-name",
    "x-voice-profile",
    "x-voice-ratelimit-scope",
    "x-voice-transport",
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function forwardManagedVoiceFailure(
  response: Response,
  fallbackMessage: string,
) {
  if (response.headers.get("content-type")?.includes("application/json")) {
    return new Response(response.body, {
      status: response.status,
      headers: managedVoiceHeaders(response, {
        "Content-Type": "application/json",
      }),
    });
  }
  return Response.json(
    {
      ok: false,
      code: "voice_provider_unavailable",
      message: fallbackMessage,
      retryable: response.status === 429 || response.status >= 500,
    },
    {
      status: response.status >= 400 ? response.status : 502,
      headers: managedVoiceHeaders(response, {
        "Content-Type": "application/json",
      }),
    },
  );
}
