import type {
  CostLedgerEntry,
  CostQuantity,
  CostTelemetrySink,
  UsageQuantity,
} from "@course-ai/contracts";
import type {
  CostEntryFactoryInput,
  IdempotentCostRecorder,
  ProviderAttemptTelemetry,
  ProviderTelemetrySink,
} from "./types.js";

const COST_UNITS = new Set<CostQuantity["unit"]>([
  "input_token",
  "output_token",
  "cached_token",
  "embedding_token",
  "audio_second",
  "realtime_second",
  "character",
  "image",
  "request",
  "byte",
  "other",
]);

function costQuantities(
  usage: readonly UsageQuantity[],
): readonly CostQuantity[] {
  return usage.map(({ quantity, unit }) => ({
    quantity,
    unit: COST_UNITS.has(unit as CostQuantity["unit"])
      ? (unit as CostQuantity["unit"])
      : "other",
  }));
}

/**
 * Process-local dedupe protects retries and request replays. Production sinks
 * must additionally enforce a unique attemptId/costEntryId constraint.
 */
export class InMemoryIdempotentCostRecorder implements IdempotentCostRecorder {
  readonly #recorded = new Map<string, Promise<CostLedgerEntry>>();

  constructor(private readonly sink: CostTelemetrySink) {}

  async recordAttempt(input: CostEntryFactoryInput): Promise<CostLedgerEntry> {
    const existing = this.#recorded.get(input.attemptId);
    if (existing !== undefined) {
      return await existing;
    }

    const entry: CostLedgerEntry = {
      costEntryId: `cost:${input.attemptId}`,
      tenantId: input.context.tenantId,
      requestId: input.context.requestId,
      ...(input.context.actorId === undefined
        ? {}
        : { actorId: input.context.actorId }),
      referenceType: "request",
      referenceId: input.context.requestId,
      attemptId: input.attemptId,
      feature: input.feature,
      capability: input.capability,
      provider: input.provider,
      adapterId: input.adapterId,
      ...(input.modelOrSku === undefined
        ? {}
        : { modelOrSku: input.modelOrSku }),
      quantities: costQuantities(input.usage),
      cost: {
        amount: input.estimatedCost.amount,
        currency: input.estimatedCost.currency,
        status: "estimated",
      },
      fundingSource: input.context.fundingSource,
      occurredAt: input.occurredAt,
      recordedAt: new Date().toISOString(),
      traceId: input.context.traceId,
    };

    const pending = this.sink.record(entry).then(() => entry);
    this.#recorded.set(input.attemptId, pending);
    try {
      return await pending;
    } catch (recordError) {
      this.#recorded.delete(input.attemptId);
      throw recordError;
    }
  }
}

export class MemoryCostTelemetrySink implements CostTelemetrySink {
  readonly entries: CostLedgerEntry[] = [];

  async record(entry: CostLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  async recordMany(entries: readonly CostLedgerEntry[]): Promise<void> {
    this.entries.push(...entries);
  }
}

export class MemoryProviderTelemetrySink implements ProviderTelemetrySink {
  readonly attempts: ProviderAttemptTelemetry[] = [];

  async recordAttempt(attempt: ProviderAttemptTelemetry): Promise<void> {
    this.attempts.push(attempt);
  }
}
