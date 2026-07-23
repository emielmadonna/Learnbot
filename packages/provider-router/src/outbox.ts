import type {
  CostLedgerEntry,
  CostTelemetrySink,
  IsoTimestamp,
} from "@course-ai/contracts";
import type {
  ProviderAttemptTelemetry,
  ProviderTelemetrySink,
} from "./types.js";

export type TelemetryOutboxPayload =
  | {
      readonly type: "cost";
      readonly entry: CostLedgerEntry;
    }
  | {
      readonly type: "provider_attempt";
      readonly attempt: ProviderAttemptTelemetry;
    };

export interface TelemetryOutboxEnvelope {
  readonly outboxId: string;
  readonly idempotencyKey: string;
  readonly createdAt: IsoTimestamp;
  readonly payload: TelemetryOutboxPayload;
}

export type OutboxPutResult = "inserted" | "duplicate";

/**
 * Implement this atomically in the same database transaction as the owning
 * application fact. `idempotencyKey` must have a unique constraint.
 */
export interface TelemetryOutboxStore {
  put(envelope: TelemetryOutboxEnvelope): Promise<OutboxPutResult>;
}

export class InMemoryTelemetryOutboxStore implements TelemetryOutboxStore {
  readonly #byKey = new Map<string, TelemetryOutboxEnvelope>();

  async put(envelope: TelemetryOutboxEnvelope): Promise<OutboxPutResult> {
    if (this.#byKey.has(envelope.idempotencyKey)) {
      return "duplicate";
    }
    this.#byKey.set(envelope.idempotencyKey, envelope);
    return "inserted";
  }

  values(): readonly TelemetryOutboxEnvelope[] {
    return [...this.#byKey.values()];
  }
}

export class OutboxCostTelemetrySink implements CostTelemetrySink {
  constructor(
    private readonly store: TelemetryOutboxStore,
    private readonly now: () => IsoTimestamp = () => new Date().toISOString(),
  ) {}

  async record(entry: CostLedgerEntry): Promise<void> {
    await this.store.put({
      outboxId: `outbox:cost:${entry.costEntryId}`,
      idempotencyKey: `cost:${entry.costEntryId}`,
      createdAt: this.now(),
      payload: { type: "cost", entry },
    });
  }

  async recordMany(entries: readonly CostLedgerEntry[]): Promise<void> {
    await Promise.all(entries.map((entry) => this.record(entry)));
  }
}

export class OutboxProviderTelemetrySink
  implements ProviderTelemetrySink
{
  constructor(
    private readonly store: TelemetryOutboxStore,
    private readonly now: () => IsoTimestamp = () => new Date().toISOString(),
  ) {}

  async recordAttempt(attempt: ProviderAttemptTelemetry): Promise<void> {
    await this.store.put({
      outboxId: `outbox:attempt:${attempt.attemptId}`,
      idempotencyKey: `attempt:${attempt.attemptId}`,
      createdAt: this.now(),
      payload: { type: "provider_attempt", attempt },
    });
  }
}
