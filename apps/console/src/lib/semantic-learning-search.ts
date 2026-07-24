import type { SupabaseClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "./supabase/config";
import { executeLearningRpc } from "./supabase/learning-route";

async function requestAuthorization(
  request: Request,
  supabase: SupabaseClient,
) {
  const supplied = request.headers.get("authorization");
  if (supplied?.startsWith("Bearer ")) return supplied;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) return null;
  return `Bearer ${data.session.access_token}`;
}

function isDurableResult(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === true &&
    (value as Record<string, unknown>).dataMode === "durable" &&
    Array.isArray((value as Record<string, unknown>).matches)
  );
}

export async function searchPublishedLearning(input: {
  request: Request;
  supabase: SupabaseClient;
  query: string;
  courseId: string | null;
  limit: number;
}) {
  const authorization = await requestAuthorization(
    input.request,
    input.supabase,
  );
  if (authorization) {
    try {
      const config = readSupabasePublicConfig();
      const response = await fetch(
        `${config.url}/functions/v1/learning-embeddings`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            apikey: config.publishableKey,
            authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: input.query,
            courseId: input.courseId,
            limit: input.limit,
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        },
      );
      const body = (await response.json()) as unknown;
      if (response.ok && isDurableResult(body)) return body;
    } catch {
      // Lexical retrieval remains a real, tenant-bound degraded mode.
    }
  }

  const result = await executeLearningRpc(
    input.supabase,
    "learning_search_chunks",
    {
      search_query: input.query,
      target_course_id: input.courseId,
      match_limit: input.limit,
    },
  );
  return {
    ...result,
    retrievalMode: "lexical_degraded",
    embeddingProvider: null,
    embeddingModel: null,
  };
}
