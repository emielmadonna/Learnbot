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
  knowledge?: {
    title: string;
    detail: string;
    text: string;
  };
};

export type GroundedChatOutput = {
  answer: string;
  source: {
    title: string;
    detail: string;
  };
};

const groundedStopWords = new Set([
  "about", "after", "again", "an", "and", "are", "can", "does", "for",
  "how", "i", "in", "is", "it", "my", "of", "on", "should", "the",
  "this", "to", "use", "what", "when", "week", "with", "you",
]);

function groundedAnswer(
  message: string,
  knowledge?: GroundedChatInput["knowledge"],
) {
  if (knowledge?.text.trim()) {
    const queryTerms = new Set(
      message
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((term) => term.length > 2 && !groundedStopWords.has(term)) ?? [],
    );
    const evidence = knowledge.text
      .split(/(?<=[.!?])\s+|\n+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .map((sentence) => {
        const terms = sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        const score = terms.reduce(
          (total, term) => total + (queryTerms.has(term) ? 1 : 0),
          0,
        );
        return { sentence, score };
      })
      .sort((left, right) => right.score - left.score)[0];
    if (evidence && evidence.score > 0) {
      return `Based on ${knowledge.title}: ${evidence.sentence}`;
    }
  }
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
    const answer = groundedAnswer(input.message, input.knowledge);
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
    const answer = groundedAnswer(input.message, input.knowledge);
    return {
      ok: true,
      result: {
        value: {
          answer,
          source: {
            title: input.knowledge?.title ?? "Designing Your Minimum Day",
            detail: input.knowledge?.detail ?? "Momentum Method · Lesson 2.3",
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

function openAiError(
  code:
    | "authentication_failed"
    | "provider_error"
    | "provider_unavailable"
    | "response_invalid",
  message: string,
  retryable: boolean,
): ProviderOutcome<GroundedChatOutput> {
  return { ok: false, error: { code, message, retryable }, attempts: [] };
}

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  if (!Array.isArray(record.output)) return null;
  const text = record.output.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? [value] : [];
    });
  });
  return text.join("\n").trim() || null;
}

async function executeOpenAIChat(
  context: ProviderRequestContext,
  input: GroundedChatInput,
  apiKey: string,
  model: string,
): Promise<ProviderOutcome<GroundedChatOutput>> {
  const controller = new AbortController();
  const remainingMs = Math.max(1, Math.min(context.deadlineMs - Date.now(), 60_000));
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  const knowledge = input.knowledge?.text.trim()
    ? `\n\nPublished learning source (${input.knowledge.title}):\n${input.knowledge.text.slice(0, 24_000)}`
    : "";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-client-request-id": context.requestId,
      },
      body: JSON.stringify({
        model,
        instructions:
          "Answer the learner's question using only the published learning source when it contains relevant evidence. If it does not answer the question, say so clearly and do not invent course facts. Keep the answer concise.",
        input: [{ role: "user", content: `${input.message}${knowledge}` }],
        store: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const rejected = response.status === 401 || response.status === 403;
      return openAiError(
        rejected
          ? "authentication_failed"
          : response.status >= 500 || response.status === 429
            ? "provider_unavailable"
            : "provider_error",
        rejected
          ? "The configured OpenAI API key was rejected."
          : "OpenAI could not complete the learning response.",
        response.status >= 500 || response.status === 429,
      );
    }
    const answer = responseText(await response.json());
    if (!answer) return openAiError("response_invalid", "OpenAI returned no usable answer.", true);
    return {
      ok: true,
      result: {
        value: {
          answer,
          source: {
            title: input.knowledge?.title ?? "Published learning",
            detail: input.knowledge?.detail ?? "Grounded course knowledge",
          },
        },
        provider: "openai",
        adapterId: "openai-responses-dev",
        modelOrSku: model,
        latencyMs: 0,
        usage: [
          { quantity: Math.max(1, Math.ceil(input.message.length / 4)), unit: "input_token" },
          { quantity: Math.max(1, Math.ceil(answer.length / 4)), unit: "output_token" },
        ],
        estimatedCost: { amount: 0, currency: "USD" },
        providerMetadata: { configuredCredential: true },
      },
    };
  } catch {
    return openAiError(
      controller.signal.aborted ? "provider_unavailable" : "provider_error",
      "OpenAI could not be reached from the development server.",
      true,
    );
  } finally {
    clearTimeout(timeout);
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
    openaiApiKey?: string;
    providerUpdatedAt?: string;
    providerRoutes?: Record<string, {
      provider: "development-local" | "openai";
      model: string;
      apiKey?: string;
      updatedAt: string;
    }>;
  };
};

export type DevelopmentProviderRoute = {
  scopeId: string;
  provider: "development-local" | "openai";
  model: string;
  configured: boolean;
  keyLast4?: string;
  updatedAt: string | null;
};

type ResolvedDevelopmentProviderRoute = {
  scopeId: string;
  provider: "development-local" | "openai";
  model: string;
  apiKey?: string;
  updatedAt: string | null;
};

export function getDevelopmentProviderRuntime() {
  const existing = providerGlobal.__learningBotDevelopmentProviderRuntime;
  if (existing) {
    existing.requests ??= new Map();
    existing.providerRoutes ??= {};
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
    providerRoutes: {},
  };
  return providerGlobal.__learningBotDevelopmentProviderRuntime;
}

export function configureDevelopmentOpenAIKey(
  apiKey: string,
  scopeId = "workspace",
  model = "gpt-4o-mini",
  provider: "development-local" | "openai" = "openai",
) {
  const runtime = getDevelopmentProviderRuntime();
  const updatedAt = new Date().toISOString();
  runtime.providerRoutes ??= {};
  runtime.providerRoutes[scopeId] = {
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    updatedAt,
  };
}

export function clearDevelopmentOpenAIKey(scopeId = "workspace") {
  const runtime = getDevelopmentProviderRuntime();
  runtime.providerRoutes ??= {};
  delete runtime.providerRoutes[scopeId];
  if (scopeId === "workspace") {
    delete runtime.openaiApiKey;
    runtime.providerUpdatedAt = new Date().toISOString();
  }
}

function getResolvedProviderRoute(scopeId: string): ResolvedDevelopmentProviderRoute {
  const runtime = getDevelopmentProviderRuntime();
  const route = runtime.providerRoutes?.[scopeId] ?? runtime.providerRoutes?.workspace;
  if (route) return { ...route, scopeId };
  if (runtime.openaiApiKey) {
    return {
      scopeId,
      provider: "openai" as const,
      model: "gpt-4o-mini",
      apiKey: runtime.openaiApiKey,
      updatedAt: runtime.providerUpdatedAt ?? new Date().toISOString(),
    };
  }
  return {
    scopeId,
    provider: "development-local" as const,
    model: "deterministic-grounded-v1",
    updatedAt: null,
  };
}

export function getDevelopmentProviderConfigurations(): DevelopmentProviderRoute[] {
  const runtime = getDevelopmentProviderRuntime();
  const scopes = new Set(["workspace", ...Object.keys(runtime.providerRoutes ?? {})]);
  return [...scopes].map((scopeId) => {
    const route = getResolvedProviderRoute(scopeId);
    return {
      scopeId,
      provider: route.provider,
      model: route.model,
      configured: Boolean(route.apiKey),
      ...(route.apiKey ? { keyLast4: route.apiKey.slice(-4) } : {}),
      updatedAt: route.updatedAt,
    };
  });
}

export function getDevelopmentProviderConfiguration(scopeId = "workspace") {
  const route = getResolvedProviderRoute(scopeId);
  return {
    scopeId,
    provider: route.provider,
    model: route.model,
    configured: Boolean(route.apiKey),
    ...(route.apiKey ? { keyLast4: route.apiKey.slice(-4) } : {}),
    updatedAt: route.updatedAt,
  } satisfies DevelopmentProviderRoute;
}

export async function executeDevelopmentGroundedChat(
  context: ProviderRequestContext,
  input: GroundedChatInput,
  idempotencyKey: string,
  scopeId = "workspace",
) {
  const runtime = getDevelopmentProviderRuntime();
  const route = getResolvedProviderRoute(scopeId);
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

  const promise = route.provider === "openai" && route.apiKey
    ? executeOpenAIChat(context, input, route.apiKey, route.model)
    : runtime.router.execute(context, input, {
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
    configuration: getDevelopmentProviderConfigurations(),
  };
}
