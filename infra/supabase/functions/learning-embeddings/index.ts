import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2";

const embeddingModel = "text-embedding-3-small";
const embeddingDimensions = 384;
const providerEndpoint = "https://api.openai.com/v1/embeddings";

type EmbeddingFailureCode =
  | "provider_not_configured"
  | "provider_authentication_failed"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_response_invalid"
  | "embedding_provider_failed";

class EmbeddingFailure extends Error {
  readonly code: EmbeddingFailureCode;
  readonly retryable: boolean;
  readonly providerStatus: number | null;

  constructor(
    code: EmbeddingFailureCode,
    retryable: boolean,
    providerStatus: number | null = null,
  ) {
    super(code);
    this.name = "EmbeddingFailure";
    this.code = code;
    this.retryable = retryable;
    this.providerStatus = providerStatus;
  }
}

function resolvePublishableKey() {
  const direct = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  if (direct) return direct;

  const configured = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")?.trim() ?? "";
  if (!configured) return "";
  try {
    const parsed = JSON.parse(configured) as Record<string, unknown>;
    return typeof parsed.default === "string" ? parsed.default.trim() : "";
  } catch {
    console.warn("learning-embeddings configuration invalid", {
      code: "publishable_key_config_invalid",
    });
    return "";
  }
}

function classifyProviderFailure(error: unknown): EmbeddingFailure {
  if (error instanceof EmbeddingFailure) return error;
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new EmbeddingFailure("provider_timeout", true);
  }
  return new EmbeddingFailure("embedding_provider_failed", false);
}

function classifyProviderStatus(status: number) {
  if (status === 401 || status === 403) {
    return new EmbeddingFailure("provider_authentication_failed", false, status);
  }
  if (status === 408 || status === 429) {
    return new EmbeddingFailure("provider_rate_limited", true, status);
  }
  if (status >= 500) {
    return new EmbeddingFailure("provider_unavailable", true, status);
  }
  return new EmbeddingFailure("embedding_provider_failed", false, status);
}

async function embed(query: string) {
  const credential = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  if (!credential) {
    throw new EmbeddingFailure("provider_not_configured", false);
  }

  try {
    const response = await fetch(providerEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: embeddingModel,
        input: query,
        dimensions: embeddingDimensions,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw classifyProviderStatus(response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmbeddingFailure("provider_response_invalid", false);
    }
    const vector = (body as { data?: Array<{ embedding?: unknown }> })?.data?.[0]
      ?.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== embeddingDimensions ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new EmbeddingFailure("provider_response_invalid", false);
    }
    return vector;
  } catch (error) {
    throw classifyProviderFailure(error);
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
    },
  });
}

function isSuccessfulSearchResult(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === true &&
    (value as Record<string, unknown>).dataMode === "durable" &&
    Array.isArray((value as Record<string, unknown>).matches)
  );
}

function lexicalDegradedResult(
  value: Record<string, unknown>,
  reason?: EmbeddingFailureCode,
) {
  return {
    ...value,
    retrievalMode: "lexical_degraded",
    embeddingProvider: null,
    embeddingModel: null,
    embeddingDimensions: null,
    ...(reason ? { degradedReason: reason } : {}),
  };
}

async function lexicalFallback(
  client: SupabaseClient<any>,
  query: string,
  courseId: string | null,
  limit: number,
  reason?: EmbeddingFailureCode,
) {
  try {
    const { data, error } = await client.rpc("learning_search_chunks", {
      search_query: query,
      target_course_id: courseId,
      match_limit: limit,
    });
    if (!error && isSuccessfulSearchResult(data)) {
      return lexicalDegradedResult(data, reason);
    }
  } catch {
    // The caller returns a bounded error if both semantic and lexical retrieval fail.
  }
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const publishableKey = resolvePublishableKey();
  if (!url || !publishableKey) {
    return json(
      {
        ok: false,
        code: "provider_not_configured",
        retrievalMode: "lexical_degraded",
      },
      503,
    );
  }

  const client = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: authorization } },
  });
  const token = authorization.slice("Bearer ".length);
  const { data: identity, error: identityError } =
    await client.auth.getUser(token);
  if (identityError || !identity.user || identity.user.is_anonymous) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  let input: {
    query?: unknown;
    courseId?: unknown;
    limit?: unknown;
  };
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const courseId =
    typeof input.courseId === "string" ? input.courseId : null;
  const limit = Number(input.limit ?? 6);
  if (
    query.length < 2 ||
    query.length > 512 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 12
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  try {
    let embedding: number[];
    try {
      embedding = await embed(query);
    } catch (error) {
      const failure = classifyProviderFailure(error);
      console.warn("learning-embeddings provider failure", {
        code: failure.code,
        retryable: failure.retryable,
        providerStatus: failure.providerStatus,
        model: embeddingModel,
        dimensions: embeddingDimensions,
      });
      const fallback = await lexicalFallback(
        client,
        query,
        courseId,
        limit,
        failure.code,
      );
      if (fallback) return json(fallback);
      return json(
        {
          ok: false,
          code: "retrieval_failed",
          retrievalMode: "lexical_unavailable",
          degradedReason: failure.code,
        },
        503,
      );
    }
    const { data, error } = await client.rpc(
      "learning_search_chunks_hybrid",
      {
        search_query: query,
        query_embedding: embedding,
        target_course_id: courseId,
        match_limit: limit,
      },
    );
    if (error || !isSuccessfulSearchResult(data)) {
      console.warn("learning-embeddings hybrid retrieval failure", {
        code: "retrieval_failed",
      });
      const fallback = await lexicalFallback(client, query, courseId, limit);
      if (fallback) return json(fallback);
      return json({ ok: false, code: "retrieval_failed" }, 503);
    }
    return json(data);
  } catch (error) {
    const failure = classifyProviderFailure(error);
    console.warn("learning-embeddings unexpected failure", {
      code: failure.code,
      retryable: failure.retryable,
      providerStatus: failure.providerStatus,
    });
    return json(
      {
        ok: false,
        code: "retrieval_failed",
        retrievalMode: "lexical_unavailable",
      },
      503,
    );
  }
});
