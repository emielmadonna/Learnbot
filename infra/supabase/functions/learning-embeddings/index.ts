import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const embeddingModel = "text-embedding-3-small";

async function embed(query: string) {
  const credential = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  if (!credential) throw new Error("embedding_provider_not_configured");
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: query,
      dimensions: 384,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("embedding_provider_failed");
  const body = await response.json();
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 384) {
    throw new Error("invalid_embedding_response");
  }
  return vector;
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

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const keyMap = JSON.parse(
    Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}",
  ) as Record<string, string>;
  const publishableKey = keyMap.default ?? "";
  if (!url || !publishableKey) {
    return json({ ok: false, code: "provider_not_configured" }, 503);
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
    const embedding = await embed(query);
    const { data, error } = await client.rpc(
      "learning_search_chunks_hybrid",
      {
        search_query: query,
        query_embedding: embedding,
        target_course_id: courseId,
        match_limit: limit,
      },
    );
    if (error || !data) {
      return json({ ok: false, code: "retrieval_failed" }, 503);
    }
    return json(data);
  } catch {
    return json({ ok: false, code: "embedding_provider_failed" }, 503);
  }
});
