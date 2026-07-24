import type {
  PostgresExecutor,
  PostgresTransaction,
} from "./database.js";
import { readIsoTimestamp } from "./database.js";
import { DurableAdapterError } from "./errors.js";
import { serializeDurableJson } from "./json.js";

interface OutboxIdentityRow {
  readonly topic: string;
  readonly payload_fingerprint: string;
}

interface OutboxRow {
  readonly outbox_id: string;
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payload_fingerprint: string;
  readonly attempt_count: number;
  readonly available_at: string | Date;
  readonly locked_by: string | null;
  readonly locked_at: string | Date | null;
}

export interface EnqueueTelemetryInput {
  readonly outboxId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly availableAt: string;
}

export interface ClaimedTelemetry {
  readonly outboxId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly lockedBy: string;
  readonly lockedAt: string;
}

export class PostgresTelemetryOutboxStore {
  constructor(private readonly database: PostgresExecutor) {}

  async put(input: EnqueueTelemetryInput): Promise<"inserted" | "duplicate"> {
    return this.database.transaction((transaction) =>
      this.putInTransaction(transaction, input),
    );
  }

  async putInTransaction(
    transaction: PostgresTransaction,
    input: EnqueueTelemetryInput,
  ): Promise<"inserted" | "duplicate"> {
    const durablePayload = serializeDurableJson(
      input.payload,
      "Telemetry outbox payload",
    );
    const inserted = await transaction.query(
      `/* durable:outbox.insert */
      insert into public.telemetry_outbox (
        outbox_id, tenant_id, idempotency_key, topic, payload,
        payload_fingerprint, available_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
      on conflict (tenant_id, idempotency_key) do nothing
      returning outbox_id`,
      [
        input.outboxId,
        input.tenantId,
        input.idempotencyKey,
        input.topic,
        durablePayload.text,
        input.payloadFingerprint,
        input.availableAt,
      ],
    );
    if (inserted.rowCount === 1) return "inserted";

    const existing = await transaction.query<OutboxIdentityRow>(
      `/* durable:outbox.identity */
      select topic, payload_fingerprint
      from public.telemetry_outbox
      where tenant_id = $1 and idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (
      row === undefined ||
      row.topic !== input.topic ||
      row.payload_fingerprint !== input.payloadFingerprint
    ) {
      throw new DurableAdapterError(
        "durable.outbox_conflict",
        "The outbox idempotency key was used for a different payload.",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    return "duplicate";
  }

  async claim(
    tenantId: string,
    workerId: string,
    limit: number,
    now: string,
  ): Promise<readonly ClaimedTelemetry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Outbox claim limit must be between 1 and 500.");
    }
    return this.database.transaction(async (transaction) => {
      const claimed = await transaction.query<OutboxRow>(
        `/* durable:outbox.claim */
        with candidates as (
          select outbox_id
          from public.telemetry_outbox
          where tenant_id = $1
            and status = 'pending'
            and available_at <= $4::timestamptz
          order by available_at, created_at, outbox_id
          for update skip locked
          limit $3
        )
        update public.telemetry_outbox as outbox
        set status = 'processing',
            locked_by = $2,
            locked_at = $4::timestamptz,
            attempt_count = outbox.attempt_count + 1,
            updated_at = clock_timestamp(),
            record_version = outbox.record_version + 1
        from candidates
        where outbox.outbox_id = candidates.outbox_id
          and outbox.tenant_id = $1
        returning outbox.outbox_id, outbox.tenant_id,
          outbox.idempotency_key, outbox.topic, outbox.payload,
          outbox.payload_fingerprint, outbox.attempt_count,
          outbox.available_at, outbox.locked_by, outbox.locked_at`,
        [tenantId, workerId, limit, now],
      );
      return claimed.rows.map((row) => this.#toClaimed(row));
    });
  }

  async acknowledge(
    tenantId: string,
    outboxId: string,
    workerId: string,
    deliveredAt: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `/* durable:outbox.ack */
        update public.telemetry_outbox
        set status = 'delivered',
            delivered_at = $4::timestamptz,
            locked_by = null,
            locked_at = null,
            last_error = null,
            updated_at = clock_timestamp(),
            record_version = record_version + 1
        where tenant_id = $1 and outbox_id = $2
          and status = 'processing' and locked_by = $3
        returning outbox_id`,
        [tenantId, outboxId, workerId, deliveredAt],
      );
      this.#requireLease(result.rowCount, outboxId);
    });
  }

  async retry(
    tenantId: string,
    outboxId: string,
    workerId: string,
    availableAt: string,
    safeError: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `/* durable:outbox.retry */
        update public.telemetry_outbox
        set status = 'pending',
            available_at = $4::timestamptz,
            locked_by = null,
            locked_at = null,
            last_error = $5,
            updated_at = clock_timestamp(),
            record_version = record_version + 1
        where tenant_id = $1 and outbox_id = $2
          and status = 'processing' and locked_by = $3
        returning outbox_id`,
        [tenantId, outboxId, workerId, availableAt, safeError],
      );
      this.#requireLease(result.rowCount, outboxId);
    });
  }

  #requireLease(rowCount: number, outboxId: string): void {
    if (rowCount !== 1) {
      throw new DurableAdapterError(
        "durable.outbox_lease_lost",
        "The outbox item is no longer leased by this worker.",
        { outboxId },
      );
    }
  }

  #toClaimed(row: OutboxRow): ClaimedTelemetry {
    if (row.locked_by === null || row.locked_at === null) {
      throw new DurableAdapterError(
        "durable.invalid_row",
        "A claimed outbox row has no lease.",
      );
    }
    return {
      outboxId: row.outbox_id,
      tenantId: row.tenant_id,
      idempotencyKey: row.idempotency_key,
      topic: row.topic,
      payload: row.payload,
      payloadFingerprint: row.payload_fingerprint,
      attemptCount: row.attempt_count,
      availableAt: readIsoTimestamp(row.available_at, "outbox available_at"),
      lockedBy: row.locked_by,
      lockedAt: readIsoTimestamp(row.locked_at, "outbox locked_at"),
    };
  }
}
