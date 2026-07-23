import type {
  CapabilityDescriptor,
  ProviderHealth,
  ProviderOutcome,
  ProviderRequestContext,
} from "@course-ai/contracts";
import {
  InMemoryRoutePolicyResolver,
  MemoryCostTelemetrySink,
  MemoryProviderTelemetrySink,
  ProviderRouter,
  type AdapterExecutionOptions,
  type CostEstimateOptions,
  type ExecutableAdapter,
  type ProviderCostEstimate,
} from "@course-ai/provider-router";

import { DEVELOPMENT_TENANT_ID } from "./dev-runtime";

export type GroundedChatInput = {
  message: string;
  contextSource: string;
  contextConfidence: number;
};

export type GroundedChatOutput = {
  answer: string;
  source: {
    title: string;
    detail: string;
  };
};

function groundedAnswer(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("small") || normalized.includes("minimum")) {
    return "Make the busy-day version two minutes: open your plan, choose one priority, and stop. The Minimum Day protects the restart loop; it does not replace your full practice.";
  }
  if (normalized.includes("restart") || normalized.includes("busy")) {
    return "Treat the first calm day after disruption as a protected restart. Begin with one Minimum Day, repeat it once, and only then rebuild the full routine.";
  }
  return "Use the Momentum Method as a floor-and-rebuild system: choose the smallest credible action, collect evidence that you restarted, then increase the practice after two consistent days.";
}

class DeterministicGroundedChatAdapter
  implements ExecutableAdapter<GroundedChatInput, GroundedChatOutput>
{
  readonly id = "grounded-deterministic-v1";
  readonly provider = "development-local";

  async capabilities(): Promise<readonly CapabilityDescriptor[]> {
    return [
      {
        capability: "llm.chat",
        features: ["grounding", "streaming"],
        limits: { maxInputCharacters: 32_000, maxOutputTokens: 1_024 },
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };
  }

  async estimateCost(
    _context: ProviderRequestContext,
    input: GroundedChatInput,
    _options: CostEstimateOptions,
  ): Promise<ProviderCostEstimate> {
    const answer = groundedAnswer(input.message);
    return {
      estimatedCost: { amount: 0.0004, currency: "USD" },
      usage: [
        {
          quantity: Math.max(1, Math.ceil(input.message.length / 4)),
          unit: "input_token",
        },
        {
          quantity: Math.max(1, Math.ceil(answer.length / 4)),
          unit: "output_token",
        },
      ],
      modelOrSku: "deterministic-grounded-v1",
      validUntil: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  async execute(
    _context: ProviderRequestContext,
    input: GroundedChatInput,
    _options: AdapterExecutionOptions,
  ): Promise<ProviderOutcome<GroundedChatOutput>> {
    const answer = groundedAnswer(input.message);
    return {
      ok: true,
      result: {
        value: {
          answer,
          source: {
            title: "Designing Your Minimum Day",
            detail: "Momentum Method · Lesson 2.3",
          },
        },
        provider: this.provider,
        adapterId: this.id,
        modelOrSku: "deterministic-grounded-v1",
        latencyMs: 0,
        usage: [
          {
            quantity: Math.max(1, Math.ceil(input.message.length / 4)),
            unit: "input_token",
          },
          {
            quantity: Math.max(1, Math.ceil(answer.length / 4)),
            unit: "output_token",
          },
        ],
        estimatedCost: { amount: 0.0004, currency: "USD" },
        providerMetadata: {
          localDevelopment: true,
          contextSource: input.contextSource,
          contextConfidence: input.contextConfidence,
        },
      },
    };
  }
}

const providerGlobal = globalThis as typeof globalThis & {
  __learningBotDevelopmentProviderRuntime?: {
    router: ProviderRouter<GroundedChatInput, GroundedChatOutput>;
    costs: MemoryCostTelemetrySink;
    attempts: MemoryProviderTelemetrySink;
    requests: Map<
      string,
      {
        fingerprint: string;
        promise: Promise<ProviderOutcome<GroundedChatOutput>>;
      }
    >;
  };
};

export function getDevelopmentProviderRuntime() {
  const existing = providerGlobal.__learningBotDevelopmentProviderRuntime;
  if (existing) {
    existing.requests ??= new Map();
    return existing;
  }

  const adapter = new DeterministicGroundedChatAdapter();
  const costs = new MemoryCostTelemetrySink();
  const attempts = new MemoryProviderTelemetrySink();
  const policyResolver = new InMemoryRoutePolicyResolver({
    tenantPolicies: [
      {
        policyVersion: "policy-v18",
        policy: {
          tenantId: DEVELOPMENT_TENANT_ID,
          capability: "llm.chat",
          primaryAdapter: adapter.id,
          fallbackAdapters: [],
          fundingSource: "platform",
          allowFundingSourceFallback: false,
          timeoutMs: 5_000,
          maxAttempts: 1,
          circuitBreaker: { failures: 3, resetMs: 30_000 },
          requiredFeatures: ["grounding", "streaming"],
          maxEstimatedCost: { amount: 0.01, currency: "USD" },
        },
      },
    ],
  });
  const router = new ProviderRouter<GroundedChatInput, GroundedChatOutput>({
    capability: "llm.chat",
    policyResolver,
    adapters: [
      {
        adapter,
        enabled: true,
        allowedFundingSources: ["platform"],
      },
    ],
    costTelemetry: costs,
    attemptTelemetry: attempts,
    policyFeature: "grounded_conversation",
  });
  providerGlobal.__learningBotDevelopmentProviderRuntime = {
    router,
    costs,
    attempts,
    requests: new Map(),
  };
  return providerGlobal.__learningBotDevelopmentProviderRuntime;
}

export async function executeDevelopmentGroundedChat(
  context: ProviderRequestContext,
  input: GroundedChatInput,
  idempotencyKey: string,
) {
  const runtime = getDevelopmentProviderRuntime();
  const key = `${context.tenantId}\u0000${idempotencyKey}`;
  const fingerprint = JSON.stringify(input);
  const existing = runtime.requests.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return {
        replayed: false,
        outcome: {
          ok: false,
          error: {
            code: "invalid_request",
            message:
              "The idempotency key was already used with different chat input.",
            retryable: false,
          },
          attempts: [],
        } satisfies ProviderOutcome<GroundedChatOutput>,
      };
    }
    return { replayed: true, outcome: await existing.promise };
  }

  const promise = runtime.router.execute(context, input, {
    idempotent: true,
    requiredFeatures: ["grounding", "streaming"],
  });
  runtime.requests.set(key, { fingerprint, promise });
  const outcome = await promise;
  if (!outcome.ok) {
    runtime.requests.delete(key);
  }
  return { replayed: false, outcome };
}

export function getDevelopmentProviderTelemetry() {
  const runtime = getDevelopmentProviderRuntime();
  return {
    attempts: runtime.attempts.attempts,
    costs: runtime.costs.entries,
  };
}
