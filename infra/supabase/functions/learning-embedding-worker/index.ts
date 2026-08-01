import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

const MODEL = "text-embedding-3-small";
const PROVIDER = "openai";
const DIMENSIONS = 384;
const MAX_INPUT_CHARACTERS = 20_000;
const RUN_BUDGET_MS = 50_000;
const INPUT_PRICE_MICRO_PER_MILLION = 20_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type JsonRecord = Record<string, unknown>;
type ClaimedChunk = {
  chunkId: string;
  tenantId: string;
  contentHash: string;
  body: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Constant-time for equal-length strings; token length is not secret. */
function tokensMatch(presented: string, expected: string) {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function presentedOperationToken(request: Request) {
  const explicit = request.headers.get("x-learningbot-operation-token")?.trim();
  if (explicit) return explicit;
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (legacy) return legacy;
  try {
    const values = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}",
    ) as Record<string, unknown>;
    return typeof values.default === "string" ? values.default : "";
  } catch {
    return "";
  }
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const key = serviceKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function integerBetween(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function claimedChunks(value: unknown): ClaimedChunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const chunkId = candidate.chunkId;
    const tenantId = candidate.tenantId;
    const contentHash = candidate.contentHash;
    const body = candidate.body;
    if (
      typeof chunkId !== "string" ||
      !uuidPattern.test(chunkId) ||
      typeof tenantId !== "string" ||
      !uuidPattern.test(tenantId) ||
      typeof contentHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(contentHash) ||
      typeof body !== "string" ||
      body.trim() === ""
    ) {
      return [];
    }
    return [{
      chunkId,
      tenantId,
      contentHash,
      body: body.slice(0, MAX_INPUT_CHARACTERS),
    }];
  });
}

function unitVector(vector: unknown) {
  if (
    !Array.isArray(vector) ||
    vector.length !== DIMENSIONS ||
    !vector.every((component) =>
      typeof component === "number" && Number.isFinite(component)
    )
  ) {
    return null;
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, component) => sum + component * component, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  return vector.map((component) => component / magnitude);
}

function byTenant(chunks: ClaimedChunk[]) {
  const groups = new Map<string, ClaimedChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.tenantId) ?? [];
    group.push(chunk);
    groups.set(chunk.tenantId, group);
  }
  return groups;
}

async function batchFingerprint(chunks: ClaimedChunk[]) {
  const content = chunks
    .map((chunk) => `${chunk.chunkId}:${chunk.contentHash}`)
    .sort()
    .join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function embedBatch(credential: string, chunks: ClaimedChunk[]) {
  const startedAt = Date.now();
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: chunks.map((chunk) => chunk.body),
      dimensions: DIMENSIONS,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const retryable = response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500;
    throw new EmbeddingWorkerError("embedding_provider_failed", retryable);
  }
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    payload.object !== "list" ||
    payload.model !== MODEL ||
    !Array.isArray(payload.data) ||
    payload.data.length !== chunks.length ||
    !isRecord(payload.usage) ||
    typeof payload.usage.prompt_tokens !== "number" ||
    !Number.isSafeInteger(payload.usage.prompt_tokens) ||
    payload.usage.prompt_tokens < 0
  ) {
    throw new EmbeddingWorkerError("invalid_embedding_response", false);
  }
  const vectors: Array<number[] | null> = Array.from(
    { length: chunks.length },
    () => null,
  );
  for (const item of payload.data) {
    if (
      !isRecord(item) ||
      typeof item.index !== "number" ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= chunks.length
    ) {
      throw new EmbeddingWorkerError("invalid_embedding_response", false);
    }
    const normalized = unitVector(item.embedding);
    if (!normalized || vectors[item.index] !== null) {
      throw new EmbeddingWorkerError("invalid_embedding_response", false);
    }
    vectors[item.index] = normalized;
  }
  if (vectors.some((vector) => vector === null)) {
    throw new EmbeddingWorkerError("invalid_embedding_response", false);
  }
  return {
    vectors: vectors as number[][],
    promptTokens: payload.usage.prompt_tokens,
    latencyMs: Date.now() - startedAt,
  };
}

class EmbeddingWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "EmbeddingWorkerError";
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const expectedToken =
    Deno.env.get("LEARNINGBOT_EMBEDDING_OPERATION_TOKEN")?.trim() ?? "";
  const presentedToken = presentedOperationToken(request);
  if (
    expectedToken.length < 32 ||
    !presentedToken ||
    !tokensMatch(presentedToken, expectedToken)
  ) {
    return json({ ok: false, code: "access_denied" }, 401);
  }
  const openAIKey = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  const supabase = serviceClient();
  if (!openAIKey || !supabase) {
    return json({ ok: false, code: "worker_not_configured" }, 503);
  }

  let input: JsonRecord = {};
  try {
    const parsed: unknown = await request.json();
    if (!isRecord(parsed)) {
      return json({ ok: false, code: "invalid_request" }, 400);
    }
    input = parsed;
  } catch {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const batchLimit = integerBetween(input.limit, 64, 1, 64);
  const maxBatches = integerBetween(input.maxBatches, 8, 1, 8);
  const deadline = Date.now() + RUN_BUDGET_MS;
  let batches = 0;
  let claimed = 0;
  let committed = 0;
  let remaining = 0;
  let promptTokens = 0;
  let meteredCalls = 0;
  let meteringFailures = 0;

  while (batches < maxBatches && Date.now() < deadline) {
    const claim = await supabase.rpc("learning_claim_embedding_work", {
      operation_token: expectedToken,
      batch_limit: batchLimit,
    });
    if (claim.error || !isRecord(claim.data) || claim.data.ok !== true) {
      return json({
        ok: false,
        code: "claim_failed",
        claimed,
        committed,
        batches,
        remaining,
      }, 502);
    }
    remaining = typeof claim.data.remaining === "number"
      ? claim.data.remaining
      : 0;
    const chunks = claimedChunks(claim.data.items);
    if (chunks.length === 0) break;
    batches += 1;
    claimed += chunks.length;

    for (const [tenantId, tenantChunks] of byTenant(chunks)) {
      const leased = tenantChunks.map((chunk) => ({
        chunk_id: chunk.chunkId,
      }));
      const fingerprint = await batchFingerprint(tenantChunks);
      const reservation = await supabase.rpc(
        "learning_reserve_embedding_worker_call",
        {
          operation_token: expectedToken,
          target_tenant_id: tenantId,
          // The durable tenant limit still applies to every provider call.
          // A content-derived subject avoids treating unrelated batches as
          // one end-user burst while remaining stable on safe retries.
          subject_key: `managed-edge-embedding-worker:${fingerprint}`,
        },
      );
      if (
        reservation.error ||
        !isRecord(reservation.data) ||
        reservation.data.ok !== true ||
        reservation.data.allowed !== true
      ) {
        await supabase.rpc("learning_release_embedding_work", {
          operation_token: expectedToken,
          chunk_ids: leased,
          retryable: true,
        });
        return json({
          ok: false,
          code: isRecord(reservation.data) &&
              typeof reservation.data.code === "string"
            ? reservation.data.code
            : "embedding_spend_refused",
          claimed,
          committed,
          batches,
          remaining,
        }, reservation.error ? 502 : 429);
      }

      try {
        const outcome = await embedBatch(openAIKey, tenantChunks);
        const items = tenantChunks.map((chunk, index) => ({
          chunk_id: chunk.chunkId,
          content_hash: chunk.contentHash,
          embedding: JSON.stringify(outcome.vectors[index]),
        }));
        const commit = await supabase.rpc("learning_commit_embedding_work", {
          operation_token: expectedToken,
          items,
          provider_key: PROVIDER,
          model_key: MODEL,
        });
        if (commit.error || !isRecord(commit.data) || commit.data.ok !== true) {
          throw new EmbeddingWorkerError("commit_failed", true);
        }
        const committedNow = typeof commit.data.committed === "number"
          ? commit.data.committed
          : 0;
        committed += committedNow;
        remaining = Math.max(0, remaining - committedNow);
        promptTokens += outcome.promptTokens;

        const traceId = `embedding-worker:${crypto.randomUUID()}`;
        const costMicro = Math.ceil(
          outcome.promptTokens * INPUT_PRICE_MICRO_PER_MILLION / 1_000_000,
        );
        const meter = await supabase.rpc(
          "learning_record_embedding_worker_cost",
          {
            operation_token: expectedToken,
            target_tenant_id: tenantId,
            prompt_tokens: outcome.promptTokens,
            estimated_cost_micro: costMicro,
            trace_id: traceId,
            idempotency_key: `embedding-worker:${fingerprint}`,
            item_count: tenantChunks.length,
            latency_ms: outcome.latencyMs,
          },
        );
        if (meter.error || !isRecord(meter.data) || meter.data.ok !== true) {
          meteringFailures += 1;
        } else {
          meteredCalls += 1;
        }
      } catch (error) {
        const workerError = error instanceof EmbeddingWorkerError
          ? error
          : new EmbeddingWorkerError("embedding_provider_failed", true);
        await supabase.rpc("learning_release_embedding_work", {
          operation_token: expectedToken,
          chunk_ids: leased,
          retryable: workerError.retryable,
        });
        return json({
          ok: false,
          code: workerError.code,
          retryable: workerError.retryable,
          claimed,
          committed,
          batches,
          remaining,
        }, workerError.code === "commit_failed" ? 502 : 503);
      }
    }
    if (chunks.length < batchLimit) break;
  }

  return json({
    ok: true,
    dataMode: "durable",
    claimed,
    committed,
    batches,
    remaining,
    promptTokens,
    meteredCalls,
    meteringFailures,
    drained: remaining === 0,
  });
});
