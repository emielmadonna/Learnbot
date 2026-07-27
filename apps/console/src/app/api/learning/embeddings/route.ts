import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { ProviderRequestContext } from "@course-ai/contracts";
import { OpenAIEmbeddingsAdapter } from "@course-ai/provider-router";
import { readSupabasePublicConfig } from "../../../../lib/supabase/config";

/**
 * The embedding producer.
 *
 * `learning_claim_embedding_batch` and `learning_commit_embedding_batch` have
 * existed since migration 0023 and had no caller anywhere: half a loop with no
 * loop. This route is the other half. It claims a lease on chunks whose vector
 * is missing, embeds them through the same provider router the answer path
 * uses, commits them, and hands the lease back if the provider fails.
 *
 * It is deliberately not a public route and deliberately not session
 * authenticated. Authority is the `knowledge.embedding.worker` operation
 * secret — the same mechanism that gates `learning_get_agent_directive` — so a
 * scheduler can call it with no user and a browser cannot call it at all. The
 * secret is checked here before any work starts and is checked again, against
 * its stored digest, inside every RPC it reaches.
 *
 * Nothing here is on the critical path for answering. Lexical retrieval works
 * the instant a course is projected; embeddings only improve ranking, and the
 * hybrid RPC reports `lexical_degraded` and still returns matches while this
 * queue drains.
 */

const EMBEDDING_DIMENSIONS = 384;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_PROVIDER = "openai";
const MAX_BATCHES = 8;
const RUN_BUDGET_MS = 45_000;
const MAX_INPUT_CHARACTERS = 20_000;

type JsonRecord = Record<string, unknown>;

type ClaimedChunk = {
  chunkId: string;
  contentHash: string;
  body: string;
};

const workerRuntime = globalThis as typeof globalThis & {
  __learningBotOpenAIEmbeddingsAdapter?: OpenAIEmbeddingsAdapter;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: JsonRecord, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Constant-time for equal-length inputs; length is not itself a secret. */
function tokensMatch(presented: string, expected: string) {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function presentedToken(request: Request) {
  const header = request.headers.get("x-learningbot-operation-token");
  if (header) return header.trim();
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return "";
}

function claimedChunks(value: unknown): ClaimedChunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const chunkId = candidate.chunkId;
    const contentHash = candidate.contentHash;
    const body = candidate.body;
    if (
      typeof chunkId !== "string" ||
      typeof contentHash !== "string" ||
      typeof body !== "string" ||
      body.trim() === ""
    ) {
      return [];
    }
    return [
      { chunkId, contentHash, body: body.slice(0, MAX_INPUT_CHARACTERS) },
    ];
  });
}

/**
 * The retrieval index is `vector_ip_ops`, so ranking is inner product and only
 * agrees with cosine similarity for unit vectors. OpenAI returns normalized
 * vectors; normalizing again is idempotent and removes the assumption.
 */
function unitVector(vector: readonly number[]) {
  if (vector.length !== EMBEDDING_DIMENSIONS) return null;
  let sumOfSquares = 0;
  for (const component of vector) {
    if (!Number.isFinite(component)) return null;
    sumOfSquares += component * component;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  return vector.map((component) => component / magnitude);
}

function configuredAdapter(credential: string) {
  workerRuntime.__learningBotOpenAIEmbeddingsAdapter ??=
    new OpenAIEmbeddingsAdapter({
      id: "openai-embeddings-production-v1",
      credentialResolver: async () => credential,
    });
  return workerRuntime.__learningBotOpenAIEmbeddingsAdapter;
}

function boundedLimit(value: string | null) {
  const requested = Number(value ?? "32");
  if (!Number.isSafeInteger(requested)) return 32;
  return Math.min(Math.max(requested, 1), 64);
}

export async function POST(request: Request) {
  const expectedToken =
    process.env.LEARNINGBOT_EMBEDDING_OPERATION_TOKEN?.trim() ?? "";
  // Fail closed: an unconfigured worker is not an open worker.
  if (expectedToken.length < 32) {
    return json({ ok: false, code: "worker_not_configured" }, 503);
  }
  const presented = presentedToken(request);
  if (!presented || !tokensMatch(presented, expectedToken)) {
    return json({ ok: false, code: "access_denied" }, 401);
  }

  const credential = process.env.OPENAI_API_KEY?.trim();
  if (!credential) {
    return json({ ok: false, code: "provider_not_configured" }, 503);
  }

  let supabaseUrl: string;
  let publishableKey: string;
  try {
    const config = readSupabasePublicConfig();
    supabaseUrl = config.url;
    publishableKey = config.publishableKey;
  } catch {
    return json({ ok: false, code: "provider_not_configured" }, 503);
  }

  const batchLimit = boundedLimit(new URL(request.url).searchParams.get("limit"));
  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  const adapter = configuredAdapter(credential);
  const runDeadline = Date.now() + RUN_BUDGET_MS;

  let claimedCount = 0;
  let committedCount = 0;
  let batchCount = 0;
  let remaining = 0;

  while (batchCount < MAX_BATCHES && Date.now() < runDeadline) {
    const claim = await supabase.rpc("learning_claim_embedding_work", {
      operation_token: expectedToken,
      batch_limit: batchLimit,
    });
    if (claim.error || !isRecord(claim.data) || claim.data.ok !== true) {
      return json({ ok: false, code: "claim_failed" }, 502);
    }
    remaining =
      typeof claim.data.remaining === "number" ? claim.data.remaining : 0;
    const chunks = claimedChunks(claim.data.items);
    if (chunks.length === 0) break;

    batchCount += 1;
    claimedCount += chunks.length;
    const leased = chunks.map((chunk) => ({ chunk_id: chunk.chunkId }));

    const context: ProviderRequestContext = {
      tenantId: "platform",
      actorId: "knowledge-embedding-worker",
      requestId: crypto.randomUUID(),
      traceId: `learning-embedding:${crypto.randomUUID()}`,
      idempotencyKey: `embedding-batch:${chunks[0]?.contentHash ?? ""}`,
      fundingSource: "platform",
      deadlineMs: Math.min(Date.now() + 30_000, runDeadline),
    };
    const outcome = await adapter.embed(context, {
      model:
        typeof claim.data.model === "string"
          ? claim.data.model
          : EMBEDDING_MODEL,
      texts: chunks.map((chunk) => chunk.body),
      dimensions:
        typeof claim.data.dimensions === "number"
          ? claim.data.dimensions
          : EMBEDDING_DIMENSIONS,
    });
    if (!outcome.ok) {
      // A provider outage must not spend the chunks' retry budget.
      await supabase.rpc("learning_release_embedding_work", {
        operation_token: expectedToken,
        chunk_ids: leased,
        retryable: outcome.error.retryable,
      });
      return json(
        {
          ok: false,
          code: "embedding_provider_failed",
          retryable: outcome.error.retryable,
          claimed: claimedCount,
          committed: committedCount,
          batches: batchCount,
          remaining,
        },
        503,
      );
    }

    const vectors = outcome.result.value.vectors;
    const items = chunks.flatMap((chunk, index) => {
      const normalized = unitVector(vectors[index] ?? []);
      if (normalized === null) return [];
      return [
        {
          chunk_id: chunk.chunkId,
          content_hash: chunk.contentHash,
          // The commit RPC casts this text to extensions.vector(384); a JSON
          // string keeps jsonb_to_recordset from reshaping the array.
          embedding: JSON.stringify(normalized),
        },
      ];
    });
    if (items.length === 0) {
      await supabase.rpc("learning_release_embedding_work", {
        operation_token: expectedToken,
        chunk_ids: leased,
        retryable: false,
      });
      return json({ ok: false, code: "invalid_embedding_response" }, 502);
    }

    const commit = await supabase.rpc("learning_commit_embedding_work", {
      operation_token: expectedToken,
      items,
      provider_key: EMBEDDING_PROVIDER,
      model_key: EMBEDDING_MODEL,
    });
    if (commit.error || !isRecord(commit.data) || commit.data.ok !== true) {
      await supabase.rpc("learning_release_embedding_work", {
        operation_token: expectedToken,
        chunk_ids: leased,
        retryable: true,
      });
      return json({ ok: false, code: "commit_failed" }, 502);
    }
    committedCount +=
      typeof commit.data.committed === "number" ? commit.data.committed : 0;
    remaining = Math.max(0, remaining - chunks.length);
    if (chunks.length < batchLimit) break;
  }

  return json({
    ok: true,
    dataMode: "durable",
    claimed: claimedCount,
    committed: committedCount,
    batches: batchCount,
    remaining,
  });
}
