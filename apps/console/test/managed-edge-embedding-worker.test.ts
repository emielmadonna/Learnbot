import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const worker = source(
  "../../../infra/supabase/functions/learning-embedding-worker/index.ts",
);
const migration = source(
  "../../../infra/supabase/migrations/20260731042443_managed_edge_embedding_worker.sql",
);
const config = source("../../../infra/supabase/config.toml");

test("the managed embedding worker uses an Edge-only, operation-scoped credential", () => {
  assert.match(
    config,
    /\[functions\.learning-embedding-worker\][\s\S]*?verify_jwt = false/u,
  );
  assert.match(
    worker,
    /Deno\.env\.get\("LEARNINGBOT_EMBEDDING_OPERATION_TOKEN"\)/,
  );
  assert.match(worker, /expectedToken\.length < 32/);
  assert.match(worker, /difference \|= presented\.charCodeAt/);
  assert.match(worker, /"access_denied"/);
  assert.doesNotMatch(worker, /console\.(?:log|debug|info|warn|error)/);
});

test("provider and database authority stay inside the Edge runtime", () => {
  assert.match(worker, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.match(worker, /Deno\.env\.get\("SUPABASE_SECRET_KEYS"\)/);
  assert.match(worker, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.match(worker, /npm:@supabase\/supabase-js@2\.110\.8/);
  assert.match(worker, /https:\/\/api\.openai\.com\/v1\/embeddings/);
  assert.doesNotMatch(worker, /NextRequest|next\/server/);
});

test("each batch is leased, tenant-reserved, committed, released on failure, and metered", () => {
  assert.match(worker, /learning_claim_embedding_work/);
  assert.match(worker, /learning_reserve_embedding_worker_call/);
  assert.match(worker, /subject_key: `managed-edge-embedding-worker:\$\{fingerprint\}`/);
  assert.match(worker, /learning_commit_embedding_work/);
  assert.match(worker, /learning_release_embedding_work/);
  assert.match(worker, /learning_record_embedding_worker_cost/);
  assert.match(worker, /idempotency_key: `embedding-worker:\$\{fingerprint\}`/);
  assert.match(worker, /for \(const \[tenantId, tenantChunks\] of byTenant\(chunks\)\)/);
});

test("OpenAI input and vectors are bounded for the existing vector index", () => {
  assert.match(worker, /const DIMENSIONS = 384/);
  assert.match(worker, /const MAX_INPUT_CHARACTERS = 20_000/);
  assert.match(worker, /input: chunks\.map\(\(chunk\) => chunk\.body\)/);
  assert.match(worker, /dimensions: DIMENSIONS/);
  assert.match(worker, /AbortSignal\.timeout\(30_000\)/);
  assert.match(worker, /component \/ magnitude/);
  assert.match(worker, /chunks\.length !== DIMENSIONS|vector\.length !== DIMENSIONS/);
});

test("the SQL companions require the worker token and remain service-role only", () => {
  assert.match(
    migration,
    /learning_operation_token_is_valid\(\s*'knowledge\.embedding\.worker'/,
  );
  assert.match(migration, /app_private\.provider_call_decision\(/);
  assert.match(migration, /'conversation\.embed'/);
  assert.match(migration, /insert into public\.cost_ledger/);
  assert.match(migration, /'text-embedding-3-small'/);
  assert.match(migration, /'itemCount', item_count/);
  assert.match(
    migration,
    /grant execute on function public\.learning_reserve_embedding_worker_call\([\s\S]*?\) to service_role/,
  );
  assert.match(
    migration,
    /grant execute on function public\.learning_record_embedding_worker_cost\([\s\S]*?\) to service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.learning_(?:reserve|record)_embedding_worker[\s\S]*?to (?:anon|authenticated)/,
  );
});
