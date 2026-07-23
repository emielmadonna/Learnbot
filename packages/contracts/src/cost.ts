import type {
  ActorId,
  CurrencyCode,
  IsoTimestamp,
  JsonObject,
  RequestId,
  TenantId,
  TraceId,
} from "./common.js";
import type { FundingSource } from "./context.js";
import type { Capability } from "./providers.js";

export type CostStatus = "estimated" | "final" | "reconciled" | "voided";
export type CostReferenceType =
  | "request"
  | "job"
  | "message"
  | "conversation"
  | "tool_invocation";

export interface CostQuantity {
  readonly quantity: number;
  readonly unit:
    | "input_token"
    | "output_token"
    | "cached_token"
    | "embedding_token"
    | "audio_second"
    | "realtime_second"
    | "character"
    | "image"
    | "request"
    | "byte"
    | "other";
}

/** Append-only cost fact for every materially variable operation/attempt. */
export interface CostLedgerEntry {
  readonly costEntryId: string;
  readonly tenantId: TenantId;
  readonly requestId?: RequestId;
  readonly actorId?: ActorId;
  readonly studentId?: string;
  readonly referenceType: CostReferenceType;
  readonly referenceId: string;
  readonly attemptId?: string;
  readonly feature: string;
  readonly capability: Capability;
  readonly provider: string;
  readonly adapterId: string;
  readonly modelOrSku?: string;
  readonly quantities: readonly CostQuantity[];
  readonly cost: {
    readonly amount: number;
    readonly currency: CurrencyCode;
    readonly status: CostStatus;
  };
  readonly fundingSource: FundingSource;
  readonly occurredAt: IsoTimestamp;
  readonly recordedAt: IsoTimestamp;
  readonly traceId: TraceId;
  readonly providerInvoiceRef?: string;
  readonly safeMetadata?: JsonObject;
}

export interface CostBudget {
  readonly tenantId: TenantId;
  readonly scope: "tenant" | "feature" | "student";
  readonly scopeId: string;
  readonly period: "request" | "day" | "month";
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly warningThresholdPercent: number;
  readonly hardLimit: boolean;
}

export interface CostSummary {
  readonly tenantId: TenantId;
  readonly from: IsoTimestamp;
  readonly through: IsoTimestamp;
  readonly currency: CurrencyCode;
  readonly estimatedCost: number;
  readonly finalCost: number;
  readonly invoicedCost: number;
  readonly entryCount: number;
  readonly partial: boolean;
}

export interface CostTelemetrySink {
  record(entry: CostLedgerEntry): Promise<void>;
  recordMany(entries: readonly CostLedgerEntry[]): Promise<void>;
}
