import type {
  Capability,
  CapabilityDescriptor,
  CapabilityRouter,
  Money,
  ProviderAttempt,
  ProviderError,
  ProviderOutcome,
  ProviderRequestContext,
  ProviderResult,
  RouteDecision,
  RouteOptions,
  RoutePolicy,
  UsageQuantity,
} from "@course-ai/contracts";
import { CircuitBreaker, InMemoryCircuitStateStore } from "./circuit-breaker.js";
import { InMemoryCostReservationService } from "./budgeting.js";
import { InMemoryIdempotentCostRecorder } from "./telemetry.js";
import { SystemAttemptTimer } from "./timer.js";
import type {
  AdapterRegistration,
  CostReservationService,
  ExecuteRouteOptions,
  FundingTransitionDecision,
  ProviderCostEstimate,
  ProviderRouterDependencies,
  RoutePolicyResolution,
} from "./types.js";

const ZERO_COST: Money = { amount: 0, currency: "USD" };

const error = (
  code: ProviderError["code"],
  message: string,
  retryable = false,
  adapterId?: string,
): ProviderError => ({
  code,
  message,
  retryable,
  ...(adapterId === undefined ? {} : { adapterId }),
});

function failure<T>(
  providerError: ProviderError,
  attempts: readonly ProviderAttempt[],
): ProviderOutcome<T> {
  return { ok: false, error: providerError, attempts };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function supports(
  descriptors: readonly CapabilityDescriptor[],
  capability: Capability,
  requiredFeatures: readonly string[],
): boolean {
  const descriptor = descriptors.find(
    (candidate) => candidate.capability === capability,
  );
  return (
    descriptor !== undefined &&
    requiredFeatures.every((feature) => descriptor.features.includes(feature))
  );
}

function breakerFailure(providerError: ProviderError): boolean {
  return (
    providerError.code === "deadline_exceeded" ||
    providerError.code === "provider_unavailable" ||
    providerError.code === "provider_error" ||
    providerError.code === "rate_limited" ||
    providerError.code === "response_invalid"
  );
}

export class ProviderRouter<TInput, TOutput>
  implements CapabilityRouter<TInput, TOutput>
{
  readonly capability: Capability;
  readonly #adapters: ReadonlyMap<
    string,
    AdapterRegistration<TInput, TOutput>
  >;
  readonly #clock;
  readonly #timer;
  readonly #circuit;
  readonly #costRecorder;
  readonly #reservations: CostReservationService;

  constructor(
    private readonly dependencies: ProviderRouterDependencies<TInput, TOutput>,
  ) {
    this.capability = dependencies.capability;
    this.#adapters = new Map(
      dependencies.adapters.map((registration) => [
        registration.adapter.id,
        registration,
      ]),
    );
    this.#clock = dependencies.clock ?? { nowMs: () => Date.now() };
    this.#timer = dependencies.timer ?? new SystemAttemptTimer();
    this.#circuit = new CircuitBreaker(
      dependencies.circuitStore ?? new InMemoryCircuitStateStore(),
      () => this.#clock.nowMs(),
    );
    this.#costRecorder = new InMemoryIdempotentCostRecorder(
      dependencies.costTelemetry,
    );
    this.#reservations =
      dependencies.costReservations ?? new InMemoryCostReservationService();
  }

  async route(
    context: ProviderRequestContext,
    options: RouteOptions = {},
  ): Promise<ProviderOutcome<RouteDecision>> {
    const resolved = await this.resolvePolicy(context);
    if (!resolved.ok) {
      return resolved;
    }
    const candidates = await this.compatibleCandidates(
      context,
      resolved.result.value.policy,
      options,
    );
    if (!candidates.ok) {
      return candidates;
    }
    const first = candidates.result.value.registrations[0];
    if (first === undefined) {
      return failure(
        error(
          "capability_unavailable",
          `No compatible ${this.capability} adapter is available.`,
        ),
        [],
      );
    }
    const decision: RouteDecision = {
      capability: this.capability,
      adapterId: first.adapter.id,
      policyVersion: resolved.result.value.policyVersion,
      fundingSource: context.fundingSource,
      ...(candidates.result.value.degradedFrom.length === 0
        ? {}
        : { degradedFrom: candidates.result.value.degradedFrom }),
    };
    return {
      ok: true,
      result: {
        value: decision,
        provider: first.adapter.provider,
        adapterId: first.adapter.id,
        latencyMs: 0,
        usage: [],
        estimatedCost: ZERO_COST,
        providerMetadata: {},
        ...(decision.degradedFrom === undefined
          ? {}
          : { degradedFrom: decision.degradedFrom }),
      },
    };
  }

  async execute(
    context: ProviderRequestContext,
    input: TInput,
    options: ExecuteRouteOptions = {},
  ): Promise<ProviderOutcome<TOutput>> {
    const resolved = await this.resolvePolicy(context);
    if (!resolved.ok) {
      return resolved;
    }
    const { policy, policyVersion } = resolved.result.value;
    const candidates = await this.compatibleCandidates(
      context,
      policy,
      options,
    );
    if (!candidates.ok) {
      return candidates;
    }

    const attempts: ProviderAttempt[] = [];
    const degradedFrom = [...candidates.result.value.degradedFrom];
    let lastError = error(
      "capability_unavailable",
      `No compatible ${this.capability} adapter is available.`,
    );
    let attemptOrdinal = 0;

    for (const registration of candidates.result.value.registrations) {
      const adapter = registration.adapter;
      const maxAdapterAttempts = options.idempotent === true ? 2 : 1;
      for (
        let adapterAttempt = 0;
        adapterAttempt < maxAdapterAttempts &&
        attemptOrdinal < policy.maxAttempts;
        adapterAttempt += 1
      ) {
        const remainingMs = context.deadlineMs - this.#clock.nowMs();
        if (remainingMs <= 0) {
          lastError = error(
            "deadline_exceeded",
            "The shared provider deadline was exhausted.",
            false,
            adapter.id,
          );
          break;
        }

        attemptOrdinal += 1;
        const attemptId = this.attemptId(
          context,
          adapter.id,
          attemptOrdinal,
        );
        const startedMs = this.#clock.nowMs();
        const preflight = await this.prepareCostReservation({
          context,
          input,
          options,
          policy,
          adapter: registration,
          attemptId,
        });
        if (!preflight.ok) {
          const endedMs = this.#clock.nowMs();
          lastError = preflight.error;
          degradedFrom.push(adapter.id);
          await this.dependencies.attemptTelemetry.recordAttempt({
            attemptId,
            requestId: context.requestId,
            traceId: context.traceId,
            tenantId: context.tenantId,
            capability: this.capability,
            adapterId: adapter.id,
            provider: adapter.provider,
            policyVersion,
            fundingSource: context.fundingSource,
            startedAt: iso(startedMs),
            endedAt: iso(endedMs),
            outcome: "skipped",
            errorCode: lastError.code,
            ...(preflight.estimate === undefined
              ? {}
              : { estimatedCost: preflight.estimate.estimatedCost }),
            safeMetadata: { phase: "cost_preflight" },
          });
          continue;
        }
        const executionRemainingMs =
          context.deadlineMs - this.#clock.nowMs();
        if (executionRemainingMs <= 0) {
          await this.releaseReservation(
            preflight.reservationId,
            "deadline_exceeded_before_execution",
          );
          lastError = error(
            "deadline_exceeded",
            "The shared provider deadline elapsed during cost preflight.",
            false,
            adapter.id,
          );
          degradedFrom.push(adapter.id);
          await this.dependencies.attemptTelemetry.recordAttempt({
            attemptId,
            requestId: context.requestId,
            traceId: context.traceId,
            tenantId: context.tenantId,
            capability: this.capability,
            adapterId: adapter.id,
            provider: adapter.provider,
            policyVersion,
            fundingSource: context.fundingSource,
            startedAt: iso(startedMs),
            endedAt: iso(this.#clock.nowMs()),
            outcome: "skipped",
            errorCode: "deadline_exceeded",
            ...(preflight.estimate === undefined
              ? {}
              : { estimatedCost: preflight.estimate.estimatedCost }),
            safeMetadata: { phase: "cost_preflight" },
          });
          break;
        }
        let outcome;
        try {
          outcome = await this.#timer.run(
            (signal) =>
              adapter.execute(context, input, {
                signal,
                ...(options.modelOrSku === undefined
                  ? {}
                  : { modelOrSku: options.modelOrSku }),
                ...(policy.secretRef === undefined
                  ? {}
                  : { secretRef: policy.secretRef }),
              }),
            Math.min(policy.timeoutMs, executionRemainingMs),
          );
        } catch {
          const endedMs = this.#clock.nowMs();
          lastError = error(
            "provider_error",
            `Adapter ${adapter.id} failed without a normalized outcome.`,
            true,
            adapter.id,
          );
          attempts.push({
            adapterId: adapter.id,
            startedAt: iso(startedMs),
            endedAt: iso(endedMs),
            outcome: "failed",
            errorCode: lastError.code,
            estimatedCost: ZERO_COST,
          });
          await this.commitReservation(
            preflight.reservationId,
            ZERO_COST,
          );
          await this.recordAttempt({
            context,
            policyVersion,
            attemptId,
            adapterId: adapter.id,
            provider: adapter.provider,
            startedMs,
            endedMs,
            outcome: "failed",
            providerError: lastError,
            cost: ZERO_COST,
            usage: [],
          });
          this.#circuit.failure(
            this.circuitKey(context, adapter.id),
            policy.circuitBreaker,
          );
          degradedFrom.push(adapter.id);
          continue;
        }
        const endedMs = this.#clock.nowMs();

        if (outcome.type === "timed_out") {
          lastError = error(
            "deadline_exceeded",
            `Adapter ${adapter.id} exceeded its attempt timeout.`,
            true,
            adapter.id,
          );
          const providerAttempt: ProviderAttempt = {
            adapterId: adapter.id,
            startedAt: iso(startedMs),
            endedAt: iso(endedMs),
            outcome: "timed_out",
            errorCode: lastError.code,
            estimatedCost: ZERO_COST,
          };
          attempts.push(providerAttempt);
          await this.commitReservation(
            preflight.reservationId,
            ZERO_COST,
          );
          await this.recordAttempt({
            context,
            policyVersion,
            attemptId,
            adapterId: adapter.id,
            provider: adapter.provider,
            startedMs,
            endedMs,
            outcome: "timed_out",
            providerError: lastError,
            cost: ZERO_COST,
            usage: [],
          });
          this.#circuit.failure(
            this.circuitKey(context, adapter.id),
            policy.circuitBreaker,
          );
          degradedFrom.push(adapter.id);
          continue;
        }

        const adapterOutcome = outcome.value;
        if (adapterOutcome.ok) {
          const result = adapterOutcome.result;
          if (
            result.adapterId !== adapter.id ||
            result.provider.trim().length === 0
          ) {
            lastError = error(
              "response_invalid",
              `Adapter ${adapter.id} returned invalid provider identity metadata.`,
              true,
              adapter.id,
            );
            attempts.push({
              adapterId: adapter.id,
              startedAt: iso(startedMs),
              endedAt: iso(endedMs),
              outcome: "failed",
              errorCode: lastError.code,
              estimatedCost: result.estimatedCost,
            });
            await this.commitReservation(
              preflight.reservationId,
              result.estimatedCost,
            );
            await this.recordAttempt({
              context,
              policyVersion,
              attemptId,
              adapterId: adapter.id,
              provider: adapter.provider,
              startedMs,
              endedMs,
              outcome: "failed",
              providerError: lastError,
              cost: result.estimatedCost,
              usage: result.usage,
              ...(result.modelOrSku === undefined
                ? {}
                : { modelOrSku: result.modelOrSku }),
            });
            this.#circuit.failure(
              this.circuitKey(context, adapter.id),
              policy.circuitBreaker,
            );
            degradedFrom.push(adapter.id);
            continue;
          }
          const providerAttempt: ProviderAttempt = {
            adapterId: adapter.id,
            startedAt: iso(startedMs),
            endedAt: iso(endedMs),
            outcome: "succeeded",
            estimatedCost: result.estimatedCost,
          };
          attempts.push(providerAttempt);
          await this.commitReservation(
            preflight.reservationId,
            result.estimatedCost,
          );
          await this.recordAttempt({
            context,
            policyVersion,
            attemptId,
            adapterId: adapter.id,
            provider: result.provider,
            startedMs,
            endedMs,
            outcome: "succeeded",
            cost: result.estimatedCost,
            usage: result.usage,
            ...(result.modelOrSku === undefined
              ? {}
              : { modelOrSku: result.modelOrSku }),
          });
          this.#circuit.success(this.circuitKey(context, adapter.id));
          return {
            ok: true,
            result: {
              ...result,
              ...(degradedFrom.length === 0
                ? {}
                : {
                    degradedFrom: unique([
                      ...degradedFrom,
                      ...(result.degradedFrom ?? []),
                    ]),
                  }),
            },
          };
        }

        lastError = {
          ...adapterOutcome.error,
          adapterId: adapter.id,
        };
        const sourceAttempt =
          adapterOutcome.attempts[adapterOutcome.attempts.length - 1];
        const attemptCost = sourceAttempt?.estimatedCost ?? ZERO_COST;
        const providerAttempt: ProviderAttempt = {
          adapterId: adapter.id,
          startedAt: iso(startedMs),
          endedAt: iso(endedMs),
          outcome:
            lastError.code === "deadline_exceeded" ? "timed_out" : "failed",
          errorCode: lastError.code,
          estimatedCost: attemptCost,
        };
        attempts.push(providerAttempt);
        await this.commitReservation(
          preflight.reservationId,
          attemptCost,
        );
        await this.recordAttempt({
          context,
          policyVersion,
          attemptId,
          adapterId: adapter.id,
          provider: adapter.provider,
          startedMs,
          endedMs,
          outcome: providerAttempt.outcome,
          providerError: lastError,
          cost: attemptCost,
          usage: [],
        });
        if (breakerFailure(lastError)) {
          this.#circuit.failure(
            this.circuitKey(context, adapter.id),
            policy.circuitBreaker,
          );
        }
        degradedFrom.push(adapter.id);
        if (!lastError.retryable) {
          break;
        }
      }

      if (
        attemptOrdinal >= policy.maxAttempts ||
        context.deadlineMs <= this.#clock.nowMs()
      ) {
        break;
      }
    }

    const transitioned = await this.tryFundingTransition({
      context,
      input,
      options,
      policy,
      policyVersion,
      attempts,
      degradedFrom,
      lastError,
    });
    if (transitioned !== undefined) {
      return transitioned;
    }

    if (this.dependencies.degrade !== undefined) {
      const degraded = await this.dependencies.degrade({
        context,
        input,
        capability: this.capability,
        attemptedAdapters: unique(degradedFrom),
        lastError,
      });
      if (degraded !== undefined) {
        return {
          ok: true,
          result: {
            ...degraded,
            degradedFrom: unique([
              ...degradedFrom,
              ...(degraded.degradedFrom ?? []),
            ]),
          },
        };
      }
    }

    return failure(lastError, attempts);
  }

  private async resolvePolicy(
    context: ProviderRequestContext,
  ): Promise<ProviderOutcome<RoutePolicyResolution>> {
    if (context.deadlineMs <= this.#clock.nowMs()) {
      return failure(
        error("deadline_exceeded", "The provider deadline has elapsed."),
        [],
      );
    }
    let resolution;
    try {
      resolution = await this.dependencies.policyResolver.resolve(
        context.tenantId,
        this.capability,
        context.fundingSource,
      );
    } catch {
      return failure(
        error(
          "provider_error",
          "Route policy resolution failed.",
          true,
        ),
        [],
      );
    }
    if (context.deadlineMs <= this.#clock.nowMs()) {
      return failure(
        error(
          "deadline_exceeded",
          "The shared provider deadline elapsed during policy resolution.",
        ),
        [],
      );
    }
    if (resolution === undefined) {
      return failure(
        error(
          "capability_unavailable",
          `No ${context.fundingSource} route policy exists for this tenant.`,
        ),
        [],
      );
    }
    if (
      resolution.policy.tenantId !== context.tenantId ||
      resolution.policy.capability !== this.capability ||
      resolution.policy.fundingSource !== context.fundingSource
    ) {
      return failure(
        error(
          "permission_denied",
          "Resolved route policy does not match request scope or funding.",
        ),
        [],
      );
    }
    if (
      resolution.policy.fundingSource === "tenant_byok" &&
      resolution.policy.secretRef === undefined
    ) {
      return failure(
        error(
          "authentication_failed",
          "Tenant-funded routing requires a configured Vault handle.",
        ),
        [],
      );
    }
    return {
      ok: true,
      result: {
        value: resolution,
        provider: "policy",
        adapterId: "policy-resolver",
        latencyMs: 0,
        usage: [],
        estimatedCost: ZERO_COST,
        providerMetadata: {},
      },
    };
  }

  private async compatibleCandidates(
    context: ProviderRequestContext,
    policy: RoutePolicy,
    options: RouteOptions,
  ): Promise<
    ProviderOutcome<
      {
        readonly registrations: readonly AdapterRegistration<TInput, TOutput>[];
        readonly degradedFrom: readonly string[];
      }
    >
  > {
    const registrations: AdapterRegistration<TInput, TOutput>[] = [];
    const degradedFrom: string[] = [];
    const requiredFeatures = unique([
      ...policy.requiredFeatures,
      ...(options.requiredFeatures ?? []),
    ]);

    for (const adapterId of unique([
      policy.primaryAdapter,
      ...policy.fallbackAdapters,
    ])) {
      const registration = this.#adapters.get(adapterId);
      if (
        registration === undefined ||
        !registration.enabled ||
        !registration.allowedFundingSources.includes(context.fundingSource)
      ) {
        degradedFrom.push(adapterId);
        continue;
      }
      if (
        policy.secretRef !== undefined &&
        !(registration.secretRefs ?? []).includes(policy.secretRef)
      ) {
        degradedFrom.push(adapterId);
        continue;
      }
      const circuitKey = this.circuitKey(context, adapterId);
      if (this.#circuit.isOpen(circuitKey, policy.circuitBreaker)) {
        degradedFrom.push(adapterId);
        continue;
      }
      let descriptors;
      let health;
      try {
        [descriptors, health] = await Promise.all([
          registration.adapter.capabilities(),
          registration.adapter.health(this.capability),
        ]);
      } catch {
        degradedFrom.push(adapterId);
        continue;
      }
      if (context.deadlineMs <= this.#clock.nowMs()) {
        return failure(
          error(
            "deadline_exceeded",
            "The shared provider deadline elapsed during route resolution.",
          ),
          [],
        );
      }
      if (
        !supports(descriptors, this.capability, requiredFeatures) ||
        health.status === "unavailable"
      ) {
        degradedFrom.push(adapterId);
        continue;
      }
      registrations.push(registration);
    }

    if (registrations.length === 0) {
      return failure(
        error(
          "capability_unavailable",
          `No enabled, healthy adapter satisfies ${this.capability}.`,
        ),
        [],
      );
    }
    return {
      ok: true,
      result: {
        value: { registrations, degradedFrom },
        provider: "router",
        adapterId: "provider-router",
        latencyMs: 0,
        usage: [],
        estimatedCost: ZERO_COST,
        providerMetadata: {},
      },
    };
  }

  private circuitKey(
    context: ProviderRequestContext,
    adapterId: string,
  ): string {
    return [
      context.tenantId,
      context.fundingSource,
      this.capability,
      adapterId,
    ].join("\u0000");
  }

  private attemptId(
    context: ProviderRequestContext,
    adapterId: string,
    ordinal: number,
  ): string {
    return [
      context.tenantId,
      context.requestId,
      context.idempotencyKey ?? context.requestId,
      this.capability,
      context.fundingSource,
      adapterId,
      String(ordinal),
    ].join(":");
  }

  private async recordAttempt(input: {
    readonly context: ProviderRequestContext;
    readonly policyVersion: string;
    readonly attemptId: string;
    readonly adapterId: string;
    readonly provider: string;
    readonly startedMs: number;
    readonly endedMs: number;
    readonly outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
    readonly providerError?: ProviderError;
    readonly cost: Money;
    readonly usage: readonly UsageQuantity[];
    readonly modelOrSku?: string;
  }): Promise<void> {
    const occurredAt = iso(input.endedMs);
    await this.#costRecorder.recordAttempt({
      context: input.context,
      capability: this.capability,
      feature: this.dependencies.policyFeature ?? this.capability,
      attemptId: input.attemptId,
      adapterId: input.adapterId,
      provider: input.provider,
      ...(input.modelOrSku === undefined
        ? {}
        : { modelOrSku: input.modelOrSku }),
      usage: input.usage,
      estimatedCost: input.cost,
      occurredAt,
    });
    await this.dependencies.attemptTelemetry.recordAttempt({
      attemptId: input.attemptId,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      tenantId: input.context.tenantId,
      capability: this.capability,
      adapterId: input.adapterId,
      provider: input.provider,
      policyVersion: input.policyVersion,
      fundingSource: input.context.fundingSource,
      startedAt: iso(input.startedMs),
      endedAt: occurredAt,
      outcome: input.outcome,
      ...(input.providerError === undefined
        ? {}
        : { errorCode: input.providerError.code }),
      estimatedCost: input.cost,
      safeMetadata: {},
    });
  }

  private async prepareCostReservation(input: {
    readonly context: ProviderRequestContext;
    readonly input: TInput;
    readonly options: ExecuteRouteOptions;
    readonly policy: RoutePolicy;
    readonly adapter: AdapterRegistration<TInput, TOutput>;
    readonly attemptId: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly estimate?: ProviderCostEstimate;
        readonly reservationId?: string;
      }
    | {
        readonly ok: false;
        readonly error: ProviderError;
        readonly estimate?: ProviderCostEstimate;
      }
  > {
    const estimateCost = input.adapter.adapter.estimateCost;
    if (estimateCost === undefined) {
      if (input.policy.maxEstimatedCost !== undefined) {
        return {
          ok: false,
          error: error(
            "budget_exceeded",
            `Adapter ${input.adapter.adapter.id} cannot prove cost before execution.`,
            false,
            input.adapter.adapter.id,
          ),
        };
      }
      return { ok: true };
    }

    let estimate: ProviderCostEstimate;
    try {
      estimate = await estimateCost.call(
        input.adapter.adapter,
        input.context,
        input.input,
        {
          ...(input.options.modelOrSku === undefined
            ? {}
            : { modelOrSku: input.options.modelOrSku }),
          ...(input.policy.secretRef === undefined
            ? {}
            : { secretRef: input.policy.secretRef }),
        },
      );
    } catch {
      return {
        ok: false,
        error: error(
          "provider_error",
          `Adapter ${input.adapter.adapter.id} cost estimation failed.`,
          true,
          input.adapter.adapter.id,
        ),
      };
    }

    if (
      !Number.isFinite(estimate.estimatedCost.amount) ||
      estimate.estimatedCost.amount < 0 ||
      estimate.estimatedCost.currency.trim().length === 0 ||
      (estimate.validUntil !== undefined &&
        (!Number.isFinite(Date.parse(estimate.validUntil)) ||
          Date.parse(estimate.validUntil) <= this.#clock.nowMs()))
    ) {
      return {
        ok: false,
        error: error(
          "response_invalid",
          `Adapter ${input.adapter.adapter.id} returned an invalid cost estimate.`,
          false,
          input.adapter.adapter.id,
        ),
        estimate,
      };
    }

    const cap = input.policy.maxEstimatedCost;
    if (
      cap !== undefined &&
      (cap.currency !== estimate.estimatedCost.currency ||
        estimate.estimatedCost.amount > cap.amount)
    ) {
      return {
        ok: false,
        error: error(
          "budget_exceeded",
          `Adapter ${input.adapter.adapter.id} exceeds the route cost cap.`,
          false,
          input.adapter.adapter.id,
        ),
        estimate,
      };
    }

    let decision;
    try {
      decision = await this.#reservations.reserve({
        reservationId: input.attemptId,
        tenantId: input.context.tenantId,
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        capability: this.capability,
        adapterId: input.adapter.adapter.id,
        fundingSource: input.context.fundingSource,
        estimatedCost: estimate.estimatedCost,
        expiresAt: iso(input.context.deadlineMs),
      });
    } catch {
      return {
        ok: false,
        error: error(
          "provider_error",
          `Cost reservation failed for adapter ${input.adapter.adapter.id}.`,
          true,
          input.adapter.adapter.id,
        ),
        estimate,
      };
    }
    if (!decision.authorized) {
      return {
        ok: false,
        error: error(
          "budget_exceeded",
          `Cost reservation denied for adapter ${input.adapter.adapter.id}.`,
          false,
          input.adapter.adapter.id,
        ),
        estimate,
      };
    }
    return {
      ok: true,
      estimate,
      reservationId: decision.reservation.reservationId,
    };
  }

  private async commitReservation(
    reservationId: string | undefined,
    actualCost: Money,
  ): Promise<void> {
    if (reservationId !== undefined) {
      await this.#reservations.commit(reservationId, actualCost);
    }
  }

  private async releaseReservation(
    reservationId: string | undefined,
    reason: string,
  ): Promise<void> {
    if (reservationId !== undefined) {
      await this.#reservations.release(reservationId, reason);
    }
  }

  private async tryFundingTransition(input: {
    readonly context: ProviderRequestContext;
    readonly input: TInput;
    readonly options: ExecuteRouteOptions;
    readonly policy: RoutePolicy;
    readonly policyVersion: string;
    readonly attempts: readonly ProviderAttempt[];
    readonly degradedFrom: readonly string[];
    readonly lastError: ProviderError;
  }): Promise<ProviderOutcome<TOutput> | undefined> {
    const request = input.options.fundingTransition;
    if (request === undefined) {
      return undefined;
    }
    if (
      !input.policy.allowFundingSourceFallback ||
      this.dependencies.fundingTransitions === undefined
    ) {
      return failure(
        error(
          "permission_denied",
          "Funding transition is not permitted by route policy.",
        ),
        input.attempts,
      );
    }

    let decision: FundingTransitionDecision;
    try {
      decision = await this.dependencies.fundingTransitions.authorize({
        request,
        tenantId: input.context.tenantId,
        capability: this.capability,
        fromFundingSource: input.context.fundingSource,
        now: iso(this.#clock.nowMs()),
      });
    } catch {
      return failure(
        error("permission_denied", "Funding transition authorization failed."),
        input.attempts,
      );
    }
    if (!decision.authorized) {
      return failure(
        error(
          "permission_denied",
          `Funding transition denied: ${decision.reasonCode}.`,
        ),
        input.attempts,
      );
    }
    if (decision.grant.policyVersion !== input.policyVersion) {
      return failure(
        error(
          "permission_denied",
          "Funding transition grant does not match the active route policy.",
        ),
        input.attempts,
      );
    }

    const { fundingTransition: _transition, ...continuedOptions } =
      input.options;
    const transitioned = await this.execute(
      {
        ...input.context,
        fundingSource: decision.grant.toFundingSource,
      },
      input.input,
      continuedOptions,
    );
    if (!transitioned.ok) {
      return failure(transitioned.error, [
        ...input.attempts,
        ...transitioned.attempts,
      ]);
    }
    return {
      ok: true,
      result: {
        ...transitioned.result,
        degradedFrom: unique([
          ...input.degradedFrom,
          `funding:${input.context.fundingSource}`,
          ...(transitioned.result.degradedFrom ?? []),
        ]),
      },
    };
  }
}
