import type {
  PostgresExecutor,
  PostgresTransaction,
} from "./database.js";
import { DurableAdapterError } from "./errors.js";
import { serializeDurableJson } from "./json.js";

interface ReceiptRow {
  readonly request_fingerprint: string;
  readonly status: "pending" | "completed";
  readonly result: unknown;
  readonly committed_at: string | null;
}

export interface DurableCommandInput {
  readonly tenantId: string;
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly commandName: string;
  readonly actorId?: string;
}

export type DurableCommandResult<TResult> =
  | { readonly disposition: "committed"; readonly result: TResult }
  | { readonly disposition: "replayed"; readonly result: TResult };

export class PostgresCommandReceiptStore {
  constructor(private readonly database: PostgresExecutor) {}

  async execute<TResult>(
    input: DurableCommandInput,
    operation: (transaction: PostgresTransaction) => Promise<TResult>,
  ): Promise<DurableCommandResult<TResult>> {
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction.query<{ readonly inserted: boolean }>(
        `/* durable:receipt.insert */
        insert into public.command_receipts (
          tenant_id, scope, idempotency_key, request_fingerprint,
          command_name, actor_id, status
        ) values ($1, $2, $3, $4, $5, $6, 'pending')
        on conflict (tenant_id, scope, idempotency_key) do nothing
        returning true as inserted`,
        [
          input.tenantId,
          input.scope,
          input.idempotencyKey,
          input.requestFingerprint,
          input.commandName,
          input.actorId ?? null,
        ],
      );

      const receipt = await transaction.query<ReceiptRow>(
        `/* durable:receipt.lock */
        select request_fingerprint, status, result, committed_at
        from public.command_receipts
        where tenant_id = $1 and scope = $2 and idempotency_key = $3
        for update`,
        [input.tenantId, input.scope, input.idempotencyKey],
      );
      const row = receipt.rows[0];
      if (row === undefined) {
        throw new DurableAdapterError(
          "durable.invalid_row",
          "The command receipt insert could not be read back.",
        );
      }
      if (row.request_fingerprint !== input.requestFingerprint) {
        throw new DurableAdapterError(
          "durable.idempotency_conflict",
          "The idempotency key was already used for a different request.",
          { scope: input.scope, idempotencyKey: input.idempotencyKey },
        );
      }
      if (row.status === "completed") {
        return {
          disposition: "replayed",
          result: row.result as TResult,
        };
      }
      if (inserted.rowCount !== 1) {
        // A pending row cannot normally survive because it is written and
        // completed in one transaction. Fail closed if external SQL created
        // an invalid partial state.
        throw new DurableAdapterError(
          "durable.receipt_invalid_state",
          "An incomplete command receipt already exists.",
          { scope: input.scope, idempotencyKey: input.idempotencyKey },
        );
      }

      const result = await operation(transaction);
      const durableResult = serializeDurableJson(result, "Command result");
      const completed = await transaction.query<{ readonly committed_at: string }>(
        `/* durable:receipt.complete */
        update public.command_receipts
        set status = 'completed',
            result = $4::jsonb,
            committed_at = clock_timestamp(),
            updated_at = clock_timestamp(),
            record_version = record_version + 1
        where tenant_id = $1
          and scope = $2
          and idempotency_key = $3
          and status = 'pending'
        returning committed_at`,
        [
          input.tenantId,
          input.scope,
          input.idempotencyKey,
          durableResult.text,
        ],
      );
      if (completed.rowCount !== 1) {
        throw new DurableAdapterError(
          "durable.receipt_invalid_state",
          "The command receipt could not be completed exactly once.",
        );
      }
      return {
        disposition: "committed",
        result: durableResult.value as TResult,
      };
    });
  }
}
