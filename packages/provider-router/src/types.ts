import type {
  Capability,
  CostLedgerEntry,
  CostTelemetrySink,
  FundingSource,
  IsoTimestamp,
  JsonObject,
  Money,
  ProviderAdapter,
  ProviderAttempt,
  ProviderError,
  ProviderOutcome,
  ProviderRequestContext,
  ProviderResult,
  RouteOptions,
  RoutePolicy,
  TenantId,
  UsageQuantity,
} from "@course-ai/contracts";

export interface ExecutableAdapter<TInput, TOutput> extends ProviderAdapter {
  readonly provider: string;
  /**
   * Side-effect-free estimate used for pre-spend policy checks. A route with
   * maxEstimatedCost is ineligible when this function is absent.
   */
  estimateCost?(
    context: ProviderRequestContext,
    input: TInput,
    options: CostEstimateOptions,
  ): Promise<ProviderCostEstimate>;
  execute(
    context: ProviderRequestContext,
    input: TInput,
    options: AdapterExecutionOptions,
  ): Promise<ProviderOutcome<TOutput>>;
}

export interface CostEstimateOptions {
  readonly modelOrSku?: string;
  /** Opaque Vault handle. It is never included in telemetry. */
  readonly secretRef?: string;
}

export interface ProviderCostEstimate {
  readonly estimatedCost: Money;
  readonly usage: readonly UsageQuantity[];
  readonly modelOrSku?: string;
  readonly validUntil?: IsoTimestamp;
}

export interface AdapterExecutionOptions {
  readonly signal: AbortSignal;
  readonly modelOrSku?: string;
  /** Opaque Vault handle. It is never included in result metadata or telemetry. */
  readonly secretRef?: string;
}

export interface AdapterRegistration<TInput, TOutput> {
  readonly adapter: ExecutableAdapter<TInput, TOutput>;
  readonly enabled: boolean;
  readonly allowedFundingSources: readonly FundingSource[];
  /** Opaque Vault handles configured for this adapter. */
  readonly secretRefs?: readonly string[];
}

export interface RoutePolicyResolution {
  readonly policy: RoutePolicy;
  readonly policyVersion: string;
  readonly source: "tenant" | "platform_default";
}

export interface RoutePolicyResolver {
  resolve(
    tenantId: TenantId,
    capability: Capability,
    fundingSource: FundingSource,
  ): Promise<RoutePolicyResolution | undefined>;
}

export interface RouterClock {
  nowMs(): number;
}

export interface AttemptTimer {
  run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<TimerOutcome<T>>;
}

export type TimerOutcome<T> =
  | { readonly type: "completed"; readonly value: T }
  | { readonly type: "timed_out" };

export type AttemptTelemetryOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped";

export interface ProviderAttemptTelemetry {
  readonly attemptId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly tenantId: TenantId;
  readonly capability: Capability;
  readonly adapterId: string;
  readonly provider: string;
  readonly policyVersion: string;
  readonly fundingSource: FundingSource;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly outcome: AttemptTelemetryOutcome;
  readonly errorCode?: ProviderError["code"];
  readonly estimatedCost?: Money;
  readonly safeMetadata: JsonObject;
}

export interface ProviderTelemetrySink {
  recordAttempt(attempt: ProviderAttemptTelemetry): Promise<void>;
}

export interface CircuitState {
  readonly failures: number;
  readonly openedAtMs?: number;
}

export interface CircuitStateStore {
  get(key: string): CircuitState | undefined;
  set(key: string, state: CircuitState): void;
  delete(key: string): void;
}

export interface DegradationContext<TInput> {
  readonly context: ProviderRequestContext;
  readonly input: TInput;
  readonly capability: Capability;
  readonly attemptedAdapters: readonly string[];
  readonly lastError: ProviderError;
}

export type GracefulDegradation<TInput, TOutput> = (
  degradation: DegradationContext<TInput>,
) => Promise<ProviderResult<TOutput> | undefined>;

export interface ProviderRouterDependencies<TInput, TOutput> {
  readonly capability: Capability;
  readonly policyResolver: RoutePolicyResolver;
  readonly adapters: readonly AdapterRegistration<TInput, TOutput>[];
  readonly costTelemetry: CostTelemetrySink;
  readonly attemptTelemetry: ProviderTelemetrySink;
  readonly policyFeature?: string;
  readonly clock?: RouterClock;
  readonly timer?: AttemptTimer;
  readonly circuitStore?: CircuitStateStore;
  readonly costReservations?: CostReservationService;
  readonly fundingTransitions?: FundingTransitionAuthorizer;
  readonly degrade?: GracefulDegradation<TInput, TOutput>;
}

export interface RecordedAttempt {
  readonly attempt: ProviderAttempt;
  readonly attemptId: string;
  readonly provider: string;
  readonly usage: readonly UsageQuantity[];
  readonly modelOrSku?: string;
}

export interface CostEntryFactoryInput {
  readonly context: ProviderRequestContext;
  readonly capability: Capability;
  readonly feature: string;
  readonly attemptId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly modelOrSku?: string;
  readonly usage: readonly UsageQuantity[];
  readonly estimatedCost: Money;
  readonly occurredAt: IsoTimestamp;
}

export interface IdempotentCostRecorder {
  recordAttempt(input: CostEntryFactoryInput): Promise<CostLedgerEntry>;
}

export interface ExecuteRouteOptions extends RouteOptions {
  /**
   * Retries are prohibited unless true. This refines the shared RouteOptions
   * contract without changing it.
   */
  readonly idempotent?: boolean;
  /** Explicit request to use a pre-authorized alternate funding source. */
  readonly fundingTransition?: FundingTransitionRequest;
}

export interface CostReservationRequest {
  readonly reservationId: string;
  readonly tenantId: TenantId;
  readonly requestId: string;
  readonly traceId: string;
  readonly capability: Capability;
  readonly adapterId: string;
  readonly fundingSource: FundingSource;
  readonly estimatedCost: Money;
  readonly expiresAt: IsoTimestamp;
}

export interface CostReservation {
  readonly reservationId: string;
  readonly reservedCost: Money;
  readonly status: "reserved" | "committed" | "released";
}

export type CostReservationDecision =
  | { readonly authorized: true; readonly reservation: CostReservation }
  | {
      readonly authorized: false;
      readonly reasonCode: "budget_exceeded" | "currency_mismatch" | "conflict";
    };

export interface CostReservationService {
  reserve(request: CostReservationRequest): Promise<CostReservationDecision>;
  commit(reservationId: string, actualCost: Money): Promise<void>;
  release(reservationId: string, reason: string): Promise<void>;
}

export interface FundingTransitionRequest {
  readonly grantId: string;
  readonly targetFundingSource: FundingSource;
}

export interface FundingTransitionGrant {
  readonly grantId: string;
  readonly tenantId: TenantId;
  readonly capability: Capability;
  readonly fromFundingSource: FundingSource;
  readonly toFundingSource: FundingSource;
  readonly expiresAt: IsoTimestamp;
  readonly policyVersion: string;
}

export type FundingTransitionDecision =
  | { readonly authorized: true; readonly grant: FundingTransitionGrant }
  | {
      readonly authorized: false;
      readonly reasonCode:
        | "grant_not_found"
        | "scope_mismatch"
        | "expired"
        | "same_funding_source";
    };

export interface FundingTransitionAuthorizer {
  authorize(input: {
    readonly request: FundingTransitionRequest;
    readonly tenantId: TenantId;
    readonly capability: Capability;
    readonly fromFundingSource: FundingSource;
    readonly now: IsoTimestamp;
  }): Promise<FundingTransitionDecision>;
}
