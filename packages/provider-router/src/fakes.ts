import type {
  CapabilityDescriptor,
  Money,
  ProviderAttempt,
  ProviderError,
  ProviderHealth,
  ProviderOutcome,
  ProviderRequestContext,
  UsageQuantity,
} from "@course-ai/contracts";
import type {
  AdapterExecutionOptions,
  CostEstimateOptions,
  ExecutableAdapter,
  ProviderCostEstimate,
} from "./types.js";

export type ScriptedAdapterStep<TOutput> =
  | {
      readonly type: "success";
      readonly value: TOutput;
      readonly estimatedCost?: Money;
      readonly usage?: readonly UsageQuantity[];
      readonly modelOrSku?: string;
    }
  | {
      readonly type: "failure";
      readonly error: ProviderError;
      readonly estimatedCost?: Money;
    }
  | { readonly type: "throw"; readonly error: Error }
  | { readonly type: "never" };

export interface ScriptedAdapterOptions<TOutput> {
  readonly id: string;
  readonly provider?: string;
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly health?: ProviderHealth;
  readonly steps: readonly ScriptedAdapterStep<TOutput>[];
}

export class ScriptedProviderAdapter<TInput, TOutput>
  implements ExecutableAdapter<TInput, TOutput>
{
  readonly id: string;
  readonly provider: string;
  readonly calls: Array<{
    readonly context: ProviderRequestContext;
    readonly input: TInput;
    readonly options: AdapterExecutionOptions;
  }> = [];
  #stepIndex = 0;

  constructor(private readonly fixture: ScriptedAdapterOptions<TOutput>) {
    this.id = fixture.id;
    this.provider = fixture.provider ?? `fake:${fixture.id}`;
  }

  async capabilities(): Promise<readonly CapabilityDescriptor[]> {
    return this.fixture.descriptors;
  }

  async health(): Promise<ProviderHealth> {
    return (
      this.fixture.health ?? {
        status: "healthy",
        checkedAt: new Date(0).toISOString(),
      }
    );
  }

  async estimateCost(
    _context: ProviderRequestContext,
    _input: TInput,
    _options: CostEstimateOptions,
  ): Promise<ProviderCostEstimate> {
    const step =
      this.fixture.steps[
        Math.min(this.#stepIndex, this.fixture.steps.length - 1)
      ];
    const estimatedCost =
      step !== undefined &&
      (step.type === "success" || step.type === "failure") &&
      step.estimatedCost !== undefined
        ? step.estimatedCost
        : { amount: 0, currency: "USD" };
    return {
      estimatedCost,
      usage:
        step?.type === "success" ? (step.usage ?? []) : [],
      ...(step?.type === "success" && step.modelOrSku !== undefined
        ? { modelOrSku: step.modelOrSku }
        : {}),
    };
  }

  async execute(
    context: ProviderRequestContext,
    input: TInput,
    options: AdapterExecutionOptions,
  ): Promise<ProviderOutcome<TOutput>> {
    this.calls.push({ context, input, options });
    const step =
      this.fixture.steps[
        Math.min(this.#stepIndex, this.fixture.steps.length - 1)
      ];
    this.#stepIndex += 1;
    if (step === undefined) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Fake adapter has no scripted step.",
          retryable: false,
          adapterId: this.id,
        },
        attempts: [],
      };
    }
    if (step.type === "never") {
      return await new Promise<ProviderOutcome<TOutput>>((resolve) => {
        options.signal.addEventListener(
          "abort",
          () =>
            resolve({
              ok: false,
              error: {
                code: "aborted",
                message: "Fake adapter observed abort.",
                retryable: false,
                adapterId: this.id,
              },
              attempts: [],
            }),
          { once: true },
        );
      });
    }
    if (step.type === "throw") {
      throw step.error;
    }
    if (step.type === "failure") {
      const timestamp = new Date(0).toISOString();
      const attempt: ProviderAttempt = {
        adapterId: this.id,
        startedAt: timestamp,
        endedAt: timestamp,
        outcome:
          step.error.code === "deadline_exceeded" ? "timed_out" : "failed",
        errorCode: step.error.code,
        ...(step.estimatedCost === undefined
          ? {}
          : { estimatedCost: step.estimatedCost }),
      };
      return {
        ok: false,
        error: { ...step.error, adapterId: this.id },
        attempts: [attempt],
      };
    }
    return {
      ok: true,
      result: {
        value: step.value,
        provider: this.provider,
        adapterId: this.id,
        ...(step.modelOrSku === undefined
          ? {}
          : { modelOrSku: step.modelOrSku }),
        latencyMs: 0,
        usage: step.usage ?? [],
        estimatedCost: step.estimatedCost ?? {
          amount: 0,
          currency: "USD",
        },
        providerMetadata: { fixture: true },
      },
    };
  }
}

export async function inspectAdapterConformance(
  adapter: ExecutableAdapter<unknown, unknown>,
): Promise<readonly string[]> {
  const problems: string[] = [];
  if (adapter.id.trim().length === 0) {
    problems.push("adapter id is empty");
  }
  if (adapter.provider.trim().length === 0) {
    problems.push("provider name is empty");
  }
  const descriptors = await adapter.capabilities();
  const keys = descriptors.map((descriptor) => descriptor.capability);
  if (new Set(keys).size !== keys.length) {
    problems.push("capability descriptors are duplicated");
  }
  for (const descriptor of descriptors) {
    const health = await adapter.health(descriptor.capability);
    if (health.checkedAt.trim().length === 0) {
      problems.push(`health timestamp missing for ${descriptor.capability}`);
    }
  }
  return problems;
}
