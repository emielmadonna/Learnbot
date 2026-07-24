import assert from "node:assert/strict";
import test from "node:test";
import type {
  UploadCallbackReceipt,
  UploadIntent,
} from "@course-ai/learning-pipeline";
import {
  DurableAdapterError,
  PostgresUploadIntentRepository,
  type PostgresExecutor,
  type PostgresTransaction,
  type SqlQueryResult,
} from "../src/index.js";

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: QueryCall[] = [];

  constructor(private readonly results: SqlQueryResult<object>[]) {}

  async transaction<TResult>(
    work: (transaction: PostgresTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return work({
      query: async <TRow extends object>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> => {
        this.calls.push({ text, values });
        const result = this.results.shift();
        if (result === undefined) {
          throw new Error(`No scripted result for SQL: ${text}`);
        }
        return result as SqlQueryResult<TRow>;
      },
    });
  }
}

function rows(...items: object[]): SqlQueryResult<object> {
  return { rows: items, rowCount: items.length };
}

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "principal_actor_1";
const now = "2026-07-23T12:00:00.000Z";
const expiresAt = "2026-07-23T12:05:00.000Z";

function fixtureIntent(
  overrides: Partial<UploadIntent> = {},
): UploadIntent {
  return {
    intentId: "intent_opaque_1",
    tenantId,
    actorId,
    filename: "course.pdf",
    mediaType: "application/pdf",
    declaredSizeBytes: 1024,
    objectKey: "object_opaque_1",
    expiresAt,
    status: "quarantined",
    disposition: "quarantine",
    signedUpload: {
      url: "https://storage.example/upload",
      method: "PUT",
      expiresAt,
      requiredHeaders: {
        "content-length": "1024",
        "content-type": "application/pdf",
      },
    },
    scanResults: [],
    promotionAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function intentRow(intent: UploadIntent = fixtureIntent()): object {
  return {
    intent_id: intent.intentId,
    tenant_id: intent.tenantId,
    actor_id: intent.actorId,
    filename: intent.filename,
    media_type: intent.mediaType,
    declared_size_bytes: String(intent.declaredSizeBytes),
    object_key: intent.objectKey,
    expires_at: intent.expiresAt,
    status: intent.status,
    signed_upload: intent.signedUpload,
    scan_results: intent.scanResults,
    failure: intent.failure ?? null,
    promotion: intent.promotion ?? null,
    promotion_attempts: intent.promotionAttempts,
    record_version: "3",
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

test("create persists the complete immutable upload identity and reports conflicts", async () => {
  const database = new ScriptedExecutor([
    rows({ intent_id: "intent_opaque_1" }),
  ]);
  const created = await new PostgresUploadIntentRepository(database).create(
    fixtureIntent(),
  );

  assert.equal(created, true);
  assert.ok(/on conflict do nothing/.test(database.calls[0]!.text));
  assert.deepEqual(database.calls[0]!.values.slice(0, 9), [
    "intent_opaque_1",
    tenantId,
    actorId,
    "course.pdf",
    "application/pdf",
    1024,
    "object_opaque_1",
    expiresAt,
    "quarantined",
  ]);
  assert.equal(
    JSON.parse(database.calls[0]!.values[9] as string).url,
    "https://storage.example/upload",
  );

  const conflictDatabase = new ScriptedExecutor([{ rows: [], rowCount: 0 }]);
  assert.equal(
    await new PostgresUploadIntentRepository(conflictDatabase).create(
      fixtureIntent(),
    ),
    false,
  );
});

test("owned transaction locks exact scope and atomically consumes callback and state", async () => {
  const database = new ScriptedExecutor([
    rows(intentRow()),
    rows(),
    rows({ callback_id: "callback_1" }),
    rows({ intent_id: "intent_opaque_1" }),
  ]);
  const repository = new PostgresUploadIntentRepository(database);
  const result = await repository.transact(
    { tenantId, actorId },
    "intent_opaque_1",
    async (transaction) => {
      assert.equal(transaction.intent.filename, "course.pdf");
      assert.equal(transaction.getCallback("callback_1"), undefined);
      transaction.consumeCallback({
        callbackId: "callback_1",
        fingerprint: "sha256:callback-1",
      });
      transaction.replaceIntent({
        ...transaction.intent,
        status: "blocked",
        failure: {
          code: "MALWARE_DETECTED",
          message: "Malware was detected.",
          retryable: false,
        },
        scanResults: [{
          callbackId: "callback_1",
          intentId: "intent_opaque_1",
          objectKey: "object_opaque_1",
          observedSizeBytes: 1024,
          magicBytes: {
            detectedMediaType: "application/pdf",
            signature: "25504446",
            matchesDeclaredType: true,
          },
          malware: {
            status: "infected",
            engine: "scanner",
            signatureVersion: "2026.07",
            scannedAt: now,
            threatName: "test-signature",
          },
          recordedAt: now,
        }],
        updatedAt: now,
      });
      return "committed";
    },
  );

  assert.equal(result, "committed");
  assert.ok(/for update/.test(database.calls[0]!.text));
  assert.ok(
    /where tenant_id = \$1 and actor_id = \$2 and intent_id = \$3/.test(
      database.calls[0]!.text,
    ),
  );
  assert.deepEqual(database.calls[0]!.values, [
    tenantId,
    actorId,
    "intent_opaque_1",
  ]);
  assert.ok(/upload:callback\.consume/.test(database.calls[2]!.text));
  assert.ok(/record_version = \$10/.test(database.calls[3]!.text));
  assert.deepEqual(database.calls[3]!.values.slice(0, 4), [
    tenantId,
    actorId,
    "intent_opaque_1",
    "blocked",
  ]);
});

test("cross-tenant or cross-actor lookup is indistinguishable from missing", async () => {
  const database = new ScriptedExecutor([rows()]);
  const result = await new PostgresUploadIntentRepository(database).transact(
    { tenantId: "20000000-0000-4000-8000-000000000002", actorId },
    "intent_opaque_1",
    async () => "must-not-run",
  );

  assert.equal(result, undefined);
  assert.equal(database.calls.length, 1);
});

test("callback replay is visible and duplicate consumption fails before writes", async () => {
  const callback: UploadCallbackReceipt = {
    callbackId: "callback_1",
    fingerprint: "sha256:callback-1",
  };
  const database = new ScriptedExecutor([
    rows(intentRow()),
    rows({
      callback_id: callback.callbackId,
      fingerprint: callback.fingerprint,
    }),
  ]);
  await assert.rejects(
    () =>
      new PostgresUploadIntentRepository(database).transact(
        { tenantId, actorId },
        "intent_opaque_1",
        async (transaction) => {
          assert.deepEqual(transaction.getCallback("callback_1"), callback);
          transaction.consumeCallback(callback);
        },
      ),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.idempotency_conflict",
  );
  assert.equal(database.calls.length, 2);
});

test("transaction rejects immutable identity changes before persistence", async () => {
  const database = new ScriptedExecutor([rows(intentRow()), rows()]);
  await assert.rejects(
    () =>
      new PostgresUploadIntentRepository(database).transact(
        { tenantId, actorId },
        "intent_opaque_1",
        async (transaction) => {
          transaction.replaceIntent({
            ...transaction.intent,
            objectKey: "forged-object-key",
          });
        },
      ),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.invalid_row",
  );
  assert.equal(database.calls.length, 2);
});

test("malformed durable terminal state fails closed", async () => {
  const malformed = fixtureIntent({ status: "promoted" });
  const database = new ScriptedExecutor([rows(intentRow(malformed))]);
  await assert.rejects(
    () =>
      new PostgresUploadIntentRepository(database).transact(
        { tenantId, actorId },
        "intent_opaque_1",
        async () => undefined,
      ),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.invalid_row",
  );
  assert.equal(database.calls.length, 1);
});
