import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableAdapterError,
  PostgresCommandReceiptStore,
  PostgresCourseRevisionStore,
  PostgresTelemetryOutboxStore,
  type PostgresExecutor,
  type PostgresTransaction,
  type SqlQueryResult,
} from "../src/index.js";

interface ReceiptState {
  readonly fingerprint: string;
  status: "pending" | "completed";
  result: unknown;
  committedAt: string | null;
}

interface RevisionState {
  readonly revisionId: string;
  readonly tenantId: string;
  readonly courseId: string;
  readonly revisionNumber: number;
  readonly revisionKind: "created" | "edited" | "published" | "rolled_back";
  readonly commandId: string;
  readonly contentHash: string;
  readonly snapshot: unknown;
  readonly createdAt: string;
}

interface OutboxState {
  readonly outboxId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  status: "pending" | "processing" | "delivered";
  attemptCount: number;
  availableAt: string;
  lockedBy: string | null;
  lockedAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  readonly createdAt: string;
}

interface FakeState {
  receipts: Map<string, ReceiptState>;
  heads: Map<string, number>;
  revisions: Map<string, RevisionState>;
  outbox: Map<string, OutboxState>;
}

function key(...parts: readonly unknown[]): string {
  return parts.join("\u0000");
}

function value(values: readonly unknown[] | undefined, index: number): unknown {
  return values?.[index];
}

function stringValue(
  values: readonly unknown[] | undefined,
  index: number,
): string {
  const current = value(values, index);
  if (typeof current !== "string") {
    throw new TypeError(`Expected SQL value ${index + 1} to be a string.`);
  }
  return current;
}

class FakeTransaction implements PostgresTransaction {
  constructor(private readonly state: FakeState) {}

  async query<TRow extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    const result = this.#execute(text, values);
    return {
      rows: result.rows as readonly TRow[],
      rowCount: result.rowCount,
    };
  }

  #execute(
    text: string,
    values: readonly unknown[] | undefined,
  ): SqlQueryResult<object> {
    if (text.includes("durable:receipt.insert")) {
      const receiptKey = key(value(values, 0), value(values, 1), value(values, 2));
      if (this.state.receipts.has(receiptKey)) {
        return { rows: [], rowCount: 0 };
      }
      this.state.receipts.set(receiptKey, {
        fingerprint: stringValue(values, 3),
        status: "pending",
        result: null,
        committedAt: null,
      });
      return { rows: [{ inserted: true }], rowCount: 1 };
    }
    if (text.includes("durable:receipt.lock")) {
      const receipt = this.state.receipts.get(
        key(value(values, 0), value(values, 1), value(values, 2)),
      );
      return receipt === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{
              request_fingerprint: receipt.fingerprint,
              status: receipt.status,
              result: receipt.result,
              committed_at: receipt.committedAt,
            }],
            rowCount: 1,
          };
    }
    if (text.includes("durable:receipt.complete")) {
      const receipt = this.state.receipts.get(
        key(value(values, 0), value(values, 1), value(values, 2)),
      );
      if (receipt === undefined || receipt.status !== "pending") {
        return { rows: [], rowCount: 0 };
      }
      receipt.status = "completed";
      receipt.result = JSON.parse(stringValue(values, 3)) as unknown;
      receipt.committedAt = "2026-07-23T12:00:00.000Z";
      return {
        rows: [{ committed_at: receipt.committedAt }],
        rowCount: 1,
      };
    }
    if (text.includes("durable:revision.ensure_head")) {
      const headKey = key(value(values, 0), value(values, 1));
      if (!this.state.heads.has(headKey)) this.state.heads.set(headKey, 0);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("durable:revision.lock_head")) {
      const current = this.state.heads.get(key(value(values, 0), value(values, 1)));
      return current === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ current_revision_number: current }],
            rowCount: 1,
          };
    }
    if (text.includes("durable:revision.insert")) {
      const revision: RevisionState = {
        revisionId: stringValue(values, 0),
        tenantId: stringValue(values, 1),
        courseId: stringValue(values, 2),
        revisionNumber: Number(value(values, 3)),
        revisionKind: stringValue(values, 4) as RevisionState["revisionKind"],
        commandId: stringValue(values, 5),
        contentHash: stringValue(values, 10),
        snapshot: JSON.parse(stringValue(values, 11)) as unknown,
        createdAt: "2026-07-23T12:00:00.000Z",
      };
      const revisionKey = key(
        revision.tenantId,
        revision.courseId,
        revision.revisionNumber,
      );
      if (this.state.revisions.has(revisionKey)) {
        throw new Error("unique revision violation");
      }
      this.state.revisions.set(revisionKey, revision);
      return {
        rows: [{
          revision_id: revision.revisionId,
          tenant_id: revision.tenantId,
          course_id: revision.courseId,
          revision_number: revision.revisionNumber,
          revision_kind: revision.revisionKind,
          command_id: revision.commandId,
          content_hash: revision.contentHash,
          snapshot: revision.snapshot,
          created_at: revision.createdAt,
        }],
        rowCount: 1,
      };
    }
    if (text.includes("durable:revision.advance_head")) {
      const headKey = key(value(values, 0), value(values, 1));
      const expected = Number(value(values, 4));
      if (this.state.heads.get(headKey) !== expected) {
        return { rows: [], rowCount: 0 };
      }
      const next = Number(value(values, 2));
      this.state.heads.set(headKey, next);
      return {
        rows: [{ current_revision_number: next }],
        rowCount: 1,
      };
    }
    if (text.includes("durable:outbox.insert")) {
      const outboxKey = key(value(values, 1), value(values, 2));
      if ([...this.state.outbox.values()].some(
        (item) => key(item.tenantId, item.idempotencyKey) === outboxKey,
      )) {
        return { rows: [], rowCount: 0 };
      }
      const item: OutboxState = {
        outboxId: stringValue(values, 0),
        tenantId: stringValue(values, 1),
        idempotencyKey: stringValue(values, 2),
        topic: stringValue(values, 3),
        payload: JSON.parse(stringValue(values, 4)) as unknown,
        payloadFingerprint: stringValue(values, 5),
        status: "pending",
        attemptCount: 0,
        availableAt: stringValue(values, 6),
        lockedBy: null,
        lockedAt: null,
        deliveredAt: null,
        lastError: null,
        createdAt: `2026-07-23T12:00:0${this.state.outbox.size}.000Z`,
      };
      this.state.outbox.set(key(item.tenantId, item.outboxId), item);
      return { rows: [{ outbox_id: item.outboxId }], rowCount: 1 };
    }
    if (text.includes("durable:outbox.identity")) {
      const item = [...this.state.outbox.values()].find(
        (candidate) =>
          candidate.tenantId === value(values, 0) &&
          candidate.idempotencyKey === value(values, 1),
      );
      return item === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{
              topic: item.topic,
              payload_fingerprint: item.payloadFingerprint,
            }],
            rowCount: 1,
          };
    }
    if (text.includes("durable:outbox.claim")) {
      const tenantId = stringValue(values, 0);
      const workerId = stringValue(values, 1);
      const limit = Number(value(values, 2));
      const now = stringValue(values, 3);
      const items = [...this.state.outbox.values()]
        .filter(
          (item) =>
            item.tenantId === tenantId &&
            item.status === "pending" &&
            item.availableAt <= now,
        )
        .sort(
          (left, right) =>
            left.availableAt.localeCompare(right.availableAt) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.outboxId.localeCompare(right.outboxId),
        )
        .slice(0, limit);
      for (const item of items) {
        item.status = "processing";
        item.lockedBy = workerId;
        item.lockedAt = now;
        item.attemptCount += 1;
      }
      return {
        rows: items.map((item) => ({
          outbox_id: item.outboxId,
          tenant_id: item.tenantId,
          idempotency_key: item.idempotencyKey,
          topic: item.topic,
          payload: item.payload,
          payload_fingerprint: item.payloadFingerprint,
          attempt_count: item.attemptCount,
          available_at: item.availableAt,
          locked_by: item.lockedBy,
          locked_at: item.lockedAt,
        })),
        rowCount: items.length,
      };
    }
    if (text.includes("durable:outbox.ack")) {
      const item = this.state.outbox.get(key(value(values, 0), value(values, 1)));
      if (
        item === undefined ||
        item.status !== "processing" ||
        item.lockedBy !== value(values, 2)
      ) {
        return { rows: [], rowCount: 0 };
      }
      item.status = "delivered";
      item.deliveredAt = stringValue(values, 3);
      item.lockedBy = null;
      item.lockedAt = null;
      item.lastError = null;
      return { rows: [{ outbox_id: item.outboxId }], rowCount: 1 };
    }
    if (text.includes("durable:outbox.retry")) {
      const item = this.state.outbox.get(key(value(values, 0), value(values, 1)));
      if (
        item === undefined ||
        item.status !== "processing" ||
        item.lockedBy !== value(values, 2)
      ) {
        return { rows: [], rowCount: 0 };
      }
      item.status = "pending";
      item.availableAt = stringValue(values, 3);
      item.lastError = stringValue(values, 4);
      item.lockedBy = null;
      item.lockedAt = null;
      return { rows: [{ outbox_id: item.outboxId }], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL query: ${text}`);
  }
}

class FakeExecutor implements PostgresExecutor {
  #state: FakeState = {
    receipts: new Map(),
    heads: new Map(),
    revisions: new Map(),
    outbox: new Map(),
  };

  async transaction<TResult>(
    work: (transaction: PostgresTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const candidate = structuredClone(this.#state);
    const result = await work(new FakeTransaction(candidate));
    this.#state = candidate;
    return result;
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof DurableAdapterError && error.code === code;
}

test("same key and fingerprint replays the committed command result", async () => {
  const database = new FakeExecutor();
  const receipts = new PostgresCommandReceiptStore(database);
  let executions = 0;
  const command = {
    tenantId: "tenant-a",
    scope: "course-authoring",
    idempotencyKey: "create-1",
    requestFingerprint: "sha256:same",
    commandName: "course.create",
  };
  const first = await receipts.execute(command, async () => {
    executions += 1;
    return { courseId: "course-a", revision: 1 };
  });
  const replay = await receipts.execute(command, async () => {
    executions += 1;
    return { courseId: "wrong", revision: 99 };
  });

  assert.equal(first.disposition, "committed");
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.result, { courseId: "course-a", revision: 1 });
  assert.equal(executions, 1);
});

test("same key with a conflicting fingerprint fails closed", async () => {
  const database = new FakeExecutor();
  const receipts = new PostgresCommandReceiptStore(database);
  const base = {
    tenantId: "tenant-a",
    scope: "privacy",
    idempotencyKey: "delete-1",
    requestFingerprint: "sha256:first",
    commandName: "privacy.delete",
  };
  await receipts.execute(base, async () => ({ jobId: "job-a" }));
  await assert.rejects(
    receipts.execute(
      { ...base, requestFingerprint: "sha256:different" },
      async () => ({ jobId: "job-b" }),
    ),
    hasCode("durable.idempotency_conflict"),
  );
});

test("non-JSON command results fail and leave no partial receipt", async () => {
  const database = new FakeExecutor();
  const receipts = new PostgresCommandReceiptStore(database);
  const command = {
    tenantId: "tenant-a",
    scope: "course-authoring",
    idempotencyKey: "invalid-result",
    requestFingerprint: "sha256:invalid-result",
    commandName: "course.create",
  };
  await assert.rejects(
    receipts.execute(command, async () => undefined),
    hasCode("durable.invalid_json"),
  );
  const retry = await receipts.execute(command, async () => ({ ok: true }));
  assert.equal(retry.disposition, "committed");
  assert.deepEqual(retry.result, { ok: true });
});

test("course revision commits use a locked head and optimistic CAS", async () => {
  const database = new FakeExecutor();
  const revisions = new PostgresCourseRevisionStore(database);
  const base = {
    tenantId: "tenant-a",
    courseId: "course-a",
    expectedRevisionNumber: 0,
    revisionKind: "created" as const,
    commandId: "command-1",
    idempotencyKey: "revision-1",
    contentHash: "sha256:one",
    snapshot: { title: "One" },
  };
  const first = await revisions.commit({ ...base, revisionId: "revision-a-1" });
  assert.equal(first.revisionNumber, 1);

  await assert.rejects(
    revisions.commit({
      ...base,
      revisionId: "stale-revision",
      idempotencyKey: "stale",
    }),
    hasCode("durable.revision_conflict"),
  );

  const second = await revisions.commit({
    ...base,
    revisionId: "revision-a-2",
    expectedRevisionNumber: 1,
    revisionKind: "edited",
    commandId: "command-2",
    idempotencyKey: "revision-2",
    contentHash: "sha256:two",
    snapshot: { title: "Two" },
  });
  assert.equal(second.revisionNumber, 2);
  assert.deepEqual(second.snapshot, { title: "Two" });
});

test("receipt, revision and outbox writes roll back together on failure", async () => {
  const database = new FakeExecutor();
  const receipts = new PostgresCommandReceiptStore(database);
  const revisions = new PostgresCourseRevisionStore(database);
  const outbox = new PostgresTelemetryOutboxStore(database);
  const command = {
    tenantId: "tenant-a",
    scope: "course-authoring",
    idempotencyKey: "atomic-command",
    requestFingerprint: "sha256:atomic",
    commandName: "course.commit",
  };
  await assert.rejects(async () => {
    await receipts.execute(command, async (transaction) => {
      await revisions.commitInTransaction(transaction, {
        tenantId: "tenant-a",
        courseId: "course-rollback",
        revisionId: "rolled-back-revision",
        expectedRevisionNumber: 0,
        revisionKind: "created",
        commandId: "atomic-command",
        idempotencyKey: "rolled-back-revision-key",
        contentHash: "sha256:rollback",
        snapshot: { title: "Rollback" },
      });
      await outbox.putInTransaction(transaction, {
        outboxId: "rolled-back-outbox",
        tenantId: "tenant-a",
        idempotencyKey: "rolled-back-outbox-key",
        topic: "course.committed",
        payload: { courseId: "course-rollback" },
        payloadFingerprint: "sha256:outbox",
        availableAt: "2026-07-23T12:00:00.000Z",
      });
      throw new Error("simulated owner transaction failure");
    });
  });

  const retry = await receipts.execute(command, async (transaction) => {
    const revision = await revisions.commitInTransaction(transaction, {
      tenantId: "tenant-a",
      courseId: "course-rollback",
      revisionId: "committed-revision",
      expectedRevisionNumber: 0,
      revisionKind: "created",
      commandId: "atomic-command",
      idempotencyKey: "committed-revision-key",
      contentHash: "sha256:commit",
      snapshot: { title: "Committed" },
    });
    const disposition = await outbox.putInTransaction(transaction, {
      outboxId: "committed-outbox",
      tenantId: "tenant-a",
      idempotencyKey: "rolled-back-outbox-key",
      topic: "course.committed",
      payload: { courseId: "course-rollback" },
      payloadFingerprint: "sha256:outbox",
      availableAt: "2026-07-23T12:00:00.000Z",
    });
    return { revision: revision.revisionNumber, disposition };
  });
  assert.deepEqual(retry.result, { revision: 1, disposition: "inserted" });
});

test("outbox supports deterministic claim, retry, lease checks and dedupe", async () => {
  const database = new FakeExecutor();
  const outbox = new PostgresTelemetryOutboxStore(database);
  const first = {
    outboxId: "outbox-1",
    tenantId: "tenant-a",
    idempotencyKey: "attempt-1",
    topic: "provider.attempt",
    payload: { attemptId: "attempt-1" },
    payloadFingerprint: "sha256:attempt-1",
    availableAt: "2026-07-23T12:00:00.000Z",
  };
  assert.equal(await outbox.put(first), "inserted");
  assert.equal(await outbox.put(first), "duplicate");
  await assert.rejects(
    outbox.put({
      ...first,
      payload: { attemptId: "changed" },
      payloadFingerprint: "sha256:changed",
    }),
    hasCode("durable.outbox_conflict"),
  );
  await outbox.put({
    ...first,
    outboxId: "outbox-2",
    idempotencyKey: "attempt-2",
    payload: { attemptId: "attempt-2" },
    payloadFingerprint: "sha256:attempt-2",
  });

  const claimed = await outbox.claim(
    "tenant-a",
    "worker-a",
    10,
    "2026-07-23T12:00:00.000Z",
  );
  assert.deepEqual(
    claimed.map((item) => [item.outboxId, item.attemptCount]),
    [["outbox-1", 1], ["outbox-2", 1]],
  );

  await outbox.retry(
    "tenant-a",
    "outbox-1",
    "worker-a",
    "2026-07-23T12:05:00.000Z",
    "provider unavailable",
  );
  await outbox.acknowledge(
    "tenant-a",
    "outbox-2",
    "worker-a",
    "2026-07-23T12:00:01.000Z",
  );
  assert.equal(
    (
      await outbox.claim(
        "tenant-a",
        "worker-b",
        10,
        "2026-07-23T12:04:59.000Z",
      )
    ).length,
    0,
  );
  const retried = await outbox.claim(
    "tenant-a",
    "worker-b",
    10,
    "2026-07-23T12:05:00.000Z",
  );
  assert.equal(retried[0]?.attemptCount, 2);
  await assert.rejects(
    outbox.acknowledge(
      "tenant-a",
      "outbox-1",
      "worker-a",
      "2026-07-23T12:05:01.000Z",
    ),
    hasCode("durable.outbox_lease_lost"),
  );
  await outbox.acknowledge(
    "tenant-a",
    "outbox-1",
    "worker-b",
    "2026-07-23T12:05:01.000Z",
  );
});
