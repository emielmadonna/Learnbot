import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  CapabilityDescriptor,
  CostTelemetrySink,
  ProviderError,
  ProviderRequestContext,
  RoutePolicy,
} from "@course-ai/contracts";
import {
  InMemoryIdempotentCostRecorder,
  InMemoryCostReservationService,
  InMemoryFundingTransitionAuthorizer,
  InMemoryRoutePolicyResolver,
  InMemoryTelemetryOutboxStore,
  MemoryCostTelemetrySink,
  MemoryProviderTelemetrySink,
  OutboxCostTelemetrySink,
  OutboxProviderTelemetrySink,
  ProviderRouter,
  ScriptedProviderAdapter,
  inspectAdapterConformance,
  type AdapterRegistration,
  type AttemptTimer,
  type GracefulDegradation,
  type ScriptedAdapterStep,
  type TimerOutcome,
  type VersionedRoutePolicy,
} from "../src/index.js";

const NOW = Date.UTC(2026, 6, 23, 12);
const healthyClock = { nowMs: () => NOW };
const descriptor = (
  features: readonly string[] = ["tools"],
): CapabilityDescriptor => ({
  capability: "llm.chat",
  features,
  limits: { maxOutputTokens: 8_192 },
});

function context(
  tenantId: string,
  fundingSource: "platform" | "tenant_byok" = "platform",
  requestId = `request-${tenantId}`,
): ProviderRequestContext {
  return {
    requestId,
    traceId: `trace-${tenantId}`,
    tenantId,
    actorId: `actor-${tenantId}`,
    fundingSource,
    deadlineMs: NOW + 10_000,
    idempotencyKey: `idem-${requestId}`,
  };
}

function policy(input: {
  tenantId: string;
  primaryAdapter: string;
  fallbackAdapters?: readonly string[];
  fundingSource?: "platform" | "tenant_byok";
  secretRef?: string;
  requiredFeatures?: readonly string[];
  maxAttempts?: number;
  failures?: number;
  resetMs?: number;
  timeoutMs?: number;
  allowFundingSourceFallback?: boolean;
  maxEstimatedCost?: { readonly amount: number; readonly currency: string };
}): RoutePolicy {
  return {
    tenantId: input.tenantId,
    capability: "llm.chat",
    primaryAdapter: input.primaryAdapter,
    fallbackAdapters: input.fallbackAdapters ?? [],
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
    fundingSource: input.fundingSource ?? "platform",
    allowFundingSourceFallback: input.allowFundingSourceFallback ?? false,
    timeoutMs: input.timeoutMs ?? 100,
    maxAttempts: input.maxAttempts ?? 3,
    circuitBreaker: {
      failures: input.failures ?? 2,
      resetMs: input.resetMs ?? 60_000,
    },
    requiredFeatures: input.requiredFeatures ?? ["tools"],
    ...(input.maxEstimatedCost === undefined
      ? {}
      : { maxEstimatedCost: input.maxEstimatedCost }),
  };
}

function adapter<TOutput>(
  id: string,
  steps: readonly ScriptedAdapterStep<TOutput>[],
  features: readonly string[] = ["tools"],
): ScriptedProviderAdapter<string, TOutput> {
  return new ScriptedProviderAdapter({
    id,
    descriptors: [descriptor(features)],
    steps,
  });
}

function registration<TOutput>(
  fake: ScriptedProviderAdapter<string, TOutput>,
  input: {
    enabled?: boolean;
    funding?: readonly ("platform" | "tenant_byok")[];
    secretRefs?: readonly string[];
  } = {},
): AdapterRegistration<string, TOutput> {
  return {
    adapter: fake,
    enabled: input.enabled ?? true,
    allowedFundingSources: input.funding ?? ["platform"],
    ...(input.secretRefs === undefined
      ? {}
      : { secretRefs: input.secretRefs }),
  };
}

function versioned(routePolicy: RoutePolicy, version = "policy-v1"): VersionedRoutePolicy {
  return { policy: routePolicy, policyVersion: version };
}

function router<TOutput>(input: {
  tenantPolicies?: readonly VersionedRoutePolicy[];
  platformDefaults?: readonly VersionedRoutePolicy[];
  adapters: readonly AdapterRegistration<string, TOutput>[];
  costs?: MemoryCostTelemetrySink;
  telemetry?: MemoryProviderTelemetrySink;
  timer?: AttemptTimer;
  clock?: { nowMs(): number };
  degrade?: GracefulDegradation<string, TOutput>;
  reservations?: InMemoryCostReservationService;
  fundingTransitions?: InMemoryFundingTransitionAuthorizer;
}): ProviderRouter<string, TOutput> {
  return new ProviderRouter({
    capability: "llm.chat",
    policyResolver: new InMemoryRoutePolicyResolver({
      ...(input.tenantPolicies === undefined
        ? {}
        : { tenantPolicies: input.tenantPolicies }),
      ...(input.platformDefaults === undefined
        ? {}
        : { platformDefaults: input.platformDefaults }),
    }),
    adapters: input.adapters,
    costTelemetry: input.costs ?? new MemoryCostTelemetrySink(),
    attemptTelemetry: input.telemetry ?? new MemoryProviderTelemetrySink(),
    clock: input.clock ?? healthyClock,
    ...(input.timer === undefined ? {} : { timer: input.timer }),
    ...(input.reservations === undefined
      ? {}
      : { costReservations: input.reservations }),
    ...(input.fundingTransitions === undefined
      ? {}
      : { fundingTransitions: input.fundingTransitions }),
    ...(input.degrade === undefined ? {} : { degrade: input.degrade }),
  });
}

test("PRO-01: package and fake adapter are provider-neutral and conformant", async () => {
  const fake = new ScriptedProviderAdapter<unknown, unknown>({
    id: "conformant",
    descriptors: [descriptor()],
    steps: [{ type: "success", value: "ok" }],
  });
  assert.deepEqual(await inspectAdapterConformance(fake), []);

  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.dependencies), [
    "@course-ai/contracts",
  ]);

  const sourceDirectory = join(process.cwd(), "src");
  for (const filename of await readdir(sourceDirectory)) {
    if (!filename.endsWith(".ts")) continue;
    const source = await readFile(join(sourceDirectory, filename), "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    assert.ok(
      specifiers.every(
        (specifier) =>
          specifier === "@course-ai/contracts" ||
          specifier?.startsWith("./") === true,
      ),
      `${filename} contains a non-contract, non-local import`,
    );
  }
});

test("PRO-02: tenant policy precedes platform default and selects only compatible enabled adapters", async () => {
  const tenantPrimary = adapter("tenant-primary", [
    { type: "success", value: "tenant" },
  ]);
  const platformPrimary = adapter("platform-primary", [
    { type: "success", value: "platform" },
  ]);
  const missingFeature = adapter(
    "missing-feature",
    [{ type: "success", value: "wrong" }],
    [],
  );
  const disabled = adapter("disabled", [
    { type: "success", value: "wrong" },
  ]);
  const compatible = adapter("compatible", [
    { type: "success", value: "compatible" },
  ]);
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "tenant-primary",
        }),
        "alpha-v2",
      ),
      versioned(
        policy({
          tenantId: "feature-tenant",
          primaryAdapter: "missing-feature",
          fallbackAdapters: ["disabled", "compatible"],
        }),
      ),
    ],
    platformDefaults: [
      versioned(
        policy({
          tenantId: "__platform__",
          primaryAdapter: "platform-primary",
        }),
        "default-v3",
      ),
    ],
    adapters: [
      registration(tenantPrimary),
      registration(platformPrimary),
      registration(missingFeature),
      registration(disabled, { enabled: false }),
      registration(compatible),
    ],
  });

  const alpha = await subject.route(context("alpha"));
  assert.equal(alpha.ok, true);
  if (alpha.ok) {
    assert.equal(alpha.result.value.adapterId, "tenant-primary");
    assert.equal(alpha.result.value.policyVersion, "alpha-v2");
  }

  const beta = await subject.route(context("beta"));
  assert.equal(beta.ok, true);
  if (beta.ok) {
    assert.equal(beta.result.value.adapterId, "platform-primary");
    assert.equal(beta.result.value.policyVersion, "default-v3");
  }

  const feature = await subject.route(context("feature-tenant"));
  assert.equal(feature.ok, true);
  if (feature.ok) {
    assert.equal(feature.result.value.adapterId, "compatible");
    assert.deepEqual(feature.result.value.degradedFrom, [
      "missing-feature",
      "disabled",
    ]);
  }
});

test("PRO-02/04: BYOK uses an exact Vault-bound tenant route and preserves funding on fallback", async () => {
  const primary = adapter("byok-primary", [
    {
      type: "failure",
      error: {
        code: "provider_unavailable",
        message: "transient",
        retryable: true,
      },
      estimatedCost: { amount: 0.01, currency: "USD" },
    },
  ]);
  const fallback = adapter("byok-fallback", [
    {
      type: "success",
      value: "fallback answer",
      estimatedCost: { amount: 0.02, currency: "USD" },
    },
  ]);
  const costs = new MemoryCostTelemetrySink();
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "byok-primary",
          fallbackAdapters: ["byok-fallback"],
          fundingSource: "tenant_byok",
          secretRef: "vault://alpha/llm",
          maxAttempts: 2,
        }),
      ),
    ],
    adapters: [
      registration(primary, {
        funding: ["tenant_byok"],
        secretRefs: ["vault://alpha/llm"],
      }),
      registration(fallback, {
        funding: ["tenant_byok"],
        secretRefs: ["vault://alpha/llm"],
      }),
    ],
    costs,
  });

  const outcome = await subject.execute(
    context("alpha", "tenant_byok"),
    "question",
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.value, "fallback answer");
    assert.deepEqual(outcome.result.degradedFrom, ["byok-primary"]);
  }
  assert.equal(primary.calls[0]?.context.fundingSource, "tenant_byok");
  assert.equal(fallback.calls[0]?.context.fundingSource, "tenant_byok");
  assert.equal(primary.calls[0]?.options.secretRef, "vault://alpha/llm");
  assert.equal(fallback.calls[0]?.options.secretRef, "vault://alpha/llm");
  assert.deepEqual(
    costs.entries.map((entry) => entry.fundingSource),
    ["tenant_byok", "tenant_byok"],
  );
});

test("PRO-04: BYOK never falls through to a platform-funded default", async () => {
  const platform = adapter("platform", [
    { type: "success", value: "must not execute" },
  ]);
  const subject = router({
    platformDefaults: [
      versioned(
        policy({
          tenantId: "__platform__",
          primaryAdapter: "platform",
          allowFundingSourceFallback: true,
        }),
      ),
    ],
    adapters: [registration(platform)],
  });

  const outcome = await subject.execute(
    context("alpha", "tenant_byok"),
    "question",
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "capability_unavailable");
  }
  assert.equal(platform.calls.length, 0);
});

test("COST-01: an over-cap primary is denied before provider spend and a cheaper compatible adapter runs", async () => {
  const expensive = adapter("expensive", [
    {
      type: "success",
      value: "must not execute",
      estimatedCost: { amount: 0.5, currency: "USD" },
    },
  ]);
  const affordable = adapter("affordable", [
    {
      type: "success",
      value: "within cap",
      estimatedCost: { amount: 0.05, currency: "USD" },
    },
  ]);
  const costs = new MemoryCostTelemetrySink();
  const telemetry = new MemoryProviderTelemetrySink();
  const reservations = new InMemoryCostReservationService();
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "expensive",
          fallbackAdapters: ["affordable"],
          maxAttempts: 2,
          maxEstimatedCost: { amount: 0.1, currency: "USD" },
        }),
      ),
    ],
    adapters: [registration(expensive), registration(affordable)],
    costs,
    telemetry,
    reservations,
  });

  const outcome = await subject.execute(context("alpha"), "question");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.value, "within cap");
    assert.deepEqual(outcome.result.degradedFrom, ["expensive"]);
  }
  assert.equal(expensive.calls.length, 0);
  assert.equal(affordable.calls.length, 1);
  assert.equal(costs.entries.length, 1);
  assert.equal(
    reservations.get(
      "alpha:request-alpha:idem-request-alpha:llm.chat:platform:affordable:2",
    )?.status,
    "committed",
  );
  assert.deepEqual(
    telemetry.attempts.map((attempt) => [
      attempt.adapterId,
      attempt.outcome,
      attempt.errorCode,
    ]),
    [
      ["expensive", "skipped", "budget_exceeded"],
      ["affordable", "succeeded", undefined],
    ],
  );
});

test("COST-01: if every estimate exceeds the cap, execution is denied with no billable leg", async () => {
  const first = adapter("first", [
    {
      type: "success",
      value: "no",
      estimatedCost: { amount: 0.2, currency: "USD" },
    },
  ]);
  const second = adapter("second", [
    {
      type: "success",
      value: "no",
      estimatedCost: { amount: 0.3, currency: "USD" },
    },
  ]);
  const costs = new MemoryCostTelemetrySink();
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "first",
          fallbackAdapters: ["second"],
          maxAttempts: 2,
          maxEstimatedCost: { amount: 0.1, currency: "USD" },
        }),
      ),
    ],
    adapters: [registration(first), registration(second)],
    costs,
  });

  const outcome = await subject.execute(context("alpha"), "question");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "budget_exceeded");
    assert.equal(outcome.attempts.length, 0);
  }
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 0);
  assert.equal(costs.entries.length, 0);
});

test("PRO-04: an explicit scoped grant authorizes BYOK-to-platform transition after BYOK failure", async () => {
  const byok = adapter("byok", [
    {
      type: "failure",
      error: {
        code: "provider_unavailable",
        message: "tenant key unavailable",
        retryable: false,
      },
      estimatedCost: { amount: 0.01, currency: "USD" },
    },
  ]);
  const platform = adapter("platform", [
    {
      type: "success",
      value: "platform recovery",
      estimatedCost: { amount: 0.02, currency: "USD" },
    },
  ]);
  const costs = new MemoryCostTelemetrySink();
  const authorizer = new InMemoryFundingTransitionAuthorizer([
    {
      grantId: "grant-alpha",
      tenantId: "alpha",
      capability: "llm.chat",
      fromFundingSource: "tenant_byok",
      toFundingSource: "platform",
      expiresAt: new Date(NOW + 5_000).toISOString(),
      policyVersion: "policy-v1",
    },
  ]);
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "byok",
          fundingSource: "tenant_byok",
          secretRef: "vault://alpha/llm",
          maxAttempts: 1,
          allowFundingSourceFallback: true,
        }),
      ),
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "platform",
          fundingSource: "platform",
          maxAttempts: 1,
        }),
      ),
    ],
    adapters: [
      registration(byok, {
        funding: ["tenant_byok"],
        secretRefs: ["vault://alpha/llm"],
      }),
      registration(platform),
    ],
    costs,
    fundingTransitions: authorizer,
  });

  const outcome = await subject.execute(
    context("alpha", "tenant_byok"),
    "question",
    {
      fundingTransition: {
        grantId: "grant-alpha",
        targetFundingSource: "platform",
      },
    },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.value, "platform recovery");
    assert.deepEqual(outcome.result.degradedFrom, [
      "byok",
      "funding:tenant_byok",
    ]);
  }
  assert.equal(byok.calls[0]?.context.fundingSource, "tenant_byok");
  assert.equal(platform.calls[0]?.context.fundingSource, "platform");
  assert.deepEqual(
    costs.entries.map((entry) => entry.fundingSource),
    ["tenant_byok", "platform"],
  );
});

test("PRO-04: missing, expired or policy-disallowed funding grants never execute the target route", async () => {
  const byok = adapter("byok", [
    {
      type: "failure",
      error: {
        code: "provider_unavailable",
        message: "offline",
        retryable: false,
      },
    },
  ]);
  const platform = adapter("platform", [
    { type: "success", value: "must not execute" },
  ]);
  const authorizer = new InMemoryFundingTransitionAuthorizer([
    {
      grantId: "expired",
      tenantId: "alpha",
      capability: "llm.chat",
      fromFundingSource: "tenant_byok",
      toFundingSource: "platform",
      expiresAt: new Date(NOW - 1).toISOString(),
      policyVersion: "policy-v1",
    },
  ]);
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "byok",
          fundingSource: "tenant_byok",
          secretRef: "vault://alpha/llm",
          maxAttempts: 1,
          allowFundingSourceFallback: true,
        }),
      ),
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "platform",
          fundingSource: "platform",
        }),
      ),
    ],
    adapters: [
      registration(byok, {
        funding: ["tenant_byok"],
        secretRefs: ["vault://alpha/llm"],
      }),
      registration(platform),
    ],
    fundingTransitions: authorizer,
  });

  const outcome = await subject.execute(
    context("alpha", "tenant_byok"),
    "question",
    {
      fundingTransition: {
        grantId: "expired",
        targetFundingSource: "platform",
      },
    },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "permission_denied");
  }
  assert.equal(platform.calls.length, 0);
});

test("PRO-03/COST-01: bounded safe retry, compatible fallback, circuit opening and per-leg telemetry", async () => {
  const transient: ProviderError = {
    code: "provider_unavailable",
    message: "fixture outage",
    retryable: true,
  };
  const primary = adapter("primary", [
    {
      type: "failure",
      error: transient,
      estimatedCost: { amount: 0.01, currency: "USD" },
    },
    {
      type: "failure",
      error: transient,
      estimatedCost: { amount: 0.01, currency: "USD" },
    },
  ]);
  const fallback = adapter("fallback", [
    {
      type: "success",
      value: "recovered",
      estimatedCost: { amount: 0.03, currency: "USD" },
      usage: [{ quantity: 12, unit: "output_token" }],
    },
  ]);
  const costs = new MemoryCostTelemetrySink();
  const telemetry = new MemoryProviderTelemetrySink();
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "primary",
          fallbackAdapters: ["fallback"],
          maxAttempts: 3,
          failures: 2,
        }),
      ),
    ],
    adapters: [registration(primary), registration(fallback)],
    costs,
    telemetry,
  });

  const first = await subject.execute(context("alpha"), "question", {
    idempotent: true,
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.result.value, "recovered");
    assert.deepEqual(first.result.degradedFrom, ["primary"]);
  }
  assert.equal(primary.calls.length, 2);
  assert.equal(fallback.calls.length, 1);
  assert.equal(costs.entries.length, 3);
  assert.deepEqual(
    telemetry.attempts.map((attempt) => attempt.outcome),
    ["failed", "failed", "succeeded"],
  );
  assert.deepEqual(
    costs.entries.map((entry) => entry.adapterId),
    ["primary", "primary", "fallback"],
  );

  const second = await subject.execute(
    context("alpha", "platform", "request-alpha-2"),
    "next question",
    { idempotent: true },
  );
  assert.equal(second.ok, true);
  assert.equal(primary.calls.length, 2, "open circuit must skip primary");
  assert.equal(fallback.calls.length, 2);
  if (second.ok) {
    assert.deepEqual(second.result.degradedFrom, ["primary"]);
  }
});

test("PRO-03: non-idempotent execution is not retried on the same adapter", async () => {
  const primary = adapter("primary", [
    {
      type: "failure",
      error: {
        code: "rate_limited",
        message: "retry later",
        retryable: true,
      },
    },
    { type: "success", value: "unsafe duplicate" },
  ]);
  const fallback = adapter("fallback", [
    { type: "success", value: "safe route change" },
  ]);
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "primary",
          fallbackAdapters: ["fallback"],
          maxAttempts: 4,
        }),
      ),
    ],
    adapters: [registration(primary), registration(fallback)],
  });

  const outcome = await subject.execute(context("alpha"), "mutation");
  assert.equal(outcome.ok, true);
  assert.equal(primary.calls.length, 1);
  assert.equal(fallback.calls.length, 1);
});

test("PRO-03: an unnormalized adapter exception becomes a safe fallback leg", async () => {
  const primary = adapter("primary", [
    {
      type: "throw",
      error: new Error("secret-bearing SDK failure must not escape"),
    },
  ]);
  const fallback = adapter("fallback", [
    { type: "success", value: "normalized recovery" },
  ]);
  const telemetry = new MemoryProviderTelemetrySink();
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "primary",
          fallbackAdapters: ["fallback"],
          maxAttempts: 2,
        }),
      ),
    ],
    adapters: [registration(primary), registration(fallback)],
    telemetry,
  });

  const outcome = await subject.execute(context("alpha"), "question");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.value, "normalized recovery");
  }
  assert.deepEqual(
    telemetry.attempts.map((attempt) => attempt.errorCode),
    ["provider_error", undefined],
  );
  assert.ok(
    JSON.stringify(telemetry.attempts).includes("secret-bearing") === false,
  );
});

class SequenceAttemptTimer implements AttemptTimer {
  #index = 0;

  constructor(
    private readonly outcomes: readonly ("timed_out" | "completed")[],
  ) {}

  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<TimerOutcome<T>> {
    const outcome =
      this.outcomes[Math.min(this.#index, this.outcomes.length - 1)];
    this.#index += 1;
    const controller = new AbortController();
    if (outcome === "timed_out") {
      void task(controller.signal);
      controller.abort("deterministic_timeout");
      return { type: "timed_out" };
    }
    return { type: "completed", value: await task(controller.signal) };
  }
}

test("PRO-03: deterministic attempt timeout falls back within the total deadline", async () => {
  const primary = adapter<string>("primary", [{ type: "never" }]);
  const fallback = adapter("fallback", [
    { type: "success", value: "text degradation" },
  ]);
  const costs = new MemoryCostTelemetrySink();
  const telemetry = new MemoryProviderTelemetrySink();
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "primary",
          fallbackAdapters: ["fallback"],
          maxAttempts: 2,
        }),
      ),
    ],
    adapters: [registration(primary), registration(fallback)],
    costs,
    telemetry,
    timer: new SequenceAttemptTimer(["timed_out", "completed"]),
  });

  const outcome = await subject.execute(context("alpha"), "voice turn");
  assert.equal(outcome.ok, true);
  assert.equal(primary.calls.length, 1);
  assert.equal(fallback.calls.length, 1);
  assert.equal(primary.calls[0]?.options.signal.aborted, true);
  assert.deepEqual(
    telemetry.attempts.map((attempt) => attempt.outcome),
    ["timed_out", "succeeded"],
  );
  assert.equal(costs.entries.length, 2);
});

test("PRO-03: an open circuit resets after its configured interval", async () => {
  let now = NOW;
  const clock = { nowMs: () => now };
  const primary = adapter("primary", [
    {
      type: "failure",
      error: {
        code: "provider_unavailable",
        message: "temporary outage",
        retryable: true,
      },
    },
    { type: "success", value: "primary restored" },
  ]);
  const fallback = adapter("fallback", [
    { type: "success", value: "fallback" },
  ]);
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({
          tenantId: "alpha",
          primaryAdapter: "primary",
          fallbackAdapters: ["fallback"],
          maxAttempts: 2,
          failures: 1,
          resetMs: 100,
        }),
      ),
    ],
    adapters: [registration(primary), registration(fallback)],
    clock,
  });

  const first = await subject.execute(context("alpha"), "first");
  assert.equal(first.ok, true);
  assert.equal(primary.calls.length, 1);

  const whileOpen = await subject.execute(
    context("alpha", "platform", "request-open"),
    "second",
  );
  assert.equal(whileOpen.ok, true);
  assert.equal(primary.calls.length, 1);

  now += 101;
  const afterReset = await subject.execute(
    context("alpha", "platform", "request-reset"),
    "third",
  );
  assert.equal(afterReset.ok, true);
  if (afterReset.ok) {
    assert.equal(afterReset.result.value, "primary restored");
  }
  assert.equal(primary.calls.length, 2);
});

test("PRO-03: total deadline stops route resolution and all provider execution", async () => {
  let tick = NOW;
  const expiringClock = {
    nowMs: () => {
      tick += 10;
      return tick;
    },
  };
  const candidate = adapter("candidate", [
    { type: "success", value: "too late" },
  ]);
  const subject = router({
    tenantPolicies: [
      versioned(
        policy({ tenantId: "alpha", primaryAdapter: "candidate" }),
      ),
    ],
    adapters: [registration(candidate)],
    clock: expiringClock,
  });
  const expiringContext = {
    ...context("alpha"),
    deadlineMs: NOW + 15,
  };

  const outcome = await subject.execute(expiringContext, "question");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "deadline_exceeded");
  }
  assert.equal(candidate.calls.length, 0);
});

test("PRO-03: explicit graceful degradation returns a typed reduced result", async () => {
  const primary = adapter("primary", [
    {
      type: "failure",
      error: {
        code: "provider_unavailable",
        message: "offline",
        retryable: false,
      },
    },
  ]);
  const degrade: GracefulDegradation<string, string> = async ({
    attemptedAdapters,
  }) => ({
    value: "grounded cached answer",
    provider: "local",
    adapterId: "grounded-cache",
    latencyMs: 0,
    usage: [],
    estimatedCost: { amount: 0, currency: "USD" },
    providerMetadata: { mode: "cached" },
    degradedFrom: attemptedAdapters,
  });
  const subject = router({
    tenantPolicies: [
      versioned(policy({ tenantId: "alpha", primaryAdapter: "primary" })),
    ],
    adapters: [registration(primary)],
    degrade,
  });

  const outcome = await subject.execute(context("alpha"), "question");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.value, "grounded cached answer");
    assert.deepEqual(outcome.result.degradedFrom, ["primary"]);
  }
});

test("COST-01: cost attempt recording is idempotent under concurrent replay", async () => {
  const sink = new MemoryCostTelemetrySink();
  const recorder = new InMemoryIdempotentCostRecorder(sink);
  const input = {
    context: context("alpha", "tenant_byok"),
    capability: "llm.chat" as const,
    feature: "chat.answer",
    attemptId: "attempt-stable-1",
    adapterId: "byok",
    provider: "fake:byok",
    modelOrSku: "fixture-model",
    usage: [{ quantity: 4, unit: "input_token" }],
    estimatedCost: { amount: 0.04, currency: "USD" },
    occurredAt: new Date(NOW).toISOString(),
  };

  const [first, second] = await Promise.all([
    recorder.recordAttempt(input),
    recorder.recordAttempt(input),
  ]);
  assert.equal(sink.entries.length, 1);
  assert.equal(first.costEntryId, second.costEntryId);
  assert.equal(first.attemptId, "attempt-stable-1");
  assert.equal(first.fundingSource, "tenant_byok");
});

test("COST-01: a sink failure is retryable and never marked as recorded", async () => {
  let calls = 0;
  const entries: unknown[] = [];
  const sink: CostTelemetrySink = {
    async record(entry) {
      calls += 1;
      if (calls === 1) throw new Error("temporary ledger failure");
      entries.push(entry);
    },
    async recordMany() {},
  };
  const recorder = new InMemoryIdempotentCostRecorder(sink);
  const input = {
    context: context("alpha"),
    capability: "llm.chat" as const,
    feature: "chat.answer",
    attemptId: "retryable-cost-write",
    adapterId: "fake",
    provider: "fake",
    usage: [],
    estimatedCost: { amount: 0, currency: "USD" },
    occurredAt: new Date(NOW).toISOString(),
  };

  await assert.rejects(recorder.recordAttempt(input), /ledger failure/u);
  await recorder.recordAttempt(input);
  assert.equal(calls, 2);
  assert.equal(entries.length, 1);
});

test("COST-01: shared outbox sinks dedupe cost and attempt telemetry across process-local recorder replays", async () => {
  const store = new InMemoryTelemetryOutboxStore();
  const fixedTimestamp = () => new Date(NOW).toISOString();
  const firstCostRecorder = new InMemoryIdempotentCostRecorder(
    new OutboxCostTelemetrySink(store, fixedTimestamp),
  );
  const secondCostRecorder = new InMemoryIdempotentCostRecorder(
    new OutboxCostTelemetrySink(store, fixedTimestamp),
  );
  const costInput = {
    context: context("alpha"),
    capability: "llm.chat" as const,
    feature: "chat.answer",
    attemptId: "shared-attempt",
    adapterId: "fake",
    provider: "fake",
    usage: [{ quantity: 1, unit: "request" }],
    estimatedCost: { amount: 0.01, currency: "USD" },
    occurredAt: fixedTimestamp(),
  };
  await Promise.all([
    firstCostRecorder.recordAttempt(costInput),
    secondCostRecorder.recordAttempt(costInput),
  ]);

  const attempt = {
    attemptId: "shared-attempt",
    requestId: "request-alpha",
    traceId: "trace-alpha",
    tenantId: "alpha",
    capability: "llm.chat" as const,
    adapterId: "fake",
    provider: "fake",
    policyVersion: "v1",
    fundingSource: "platform" as const,
    startedAt: fixedTimestamp(),
    endedAt: fixedTimestamp(),
    outcome: "succeeded" as const,
    estimatedCost: { amount: 0.01, currency: "USD" },
    safeMetadata: {},
  };
  await Promise.all([
    new OutboxProviderTelemetrySink(store, fixedTimestamp).recordAttempt(
      attempt,
    ),
    new OutboxProviderTelemetrySink(store, fixedTimestamp).recordAttempt(
      attempt,
    ),
  ]);

  assert.equal(store.values().length, 2);
  assert.deepEqual(
    store.values().map((envelope) => envelope.payload.type).sort(),
    ["cost", "provider_attempt"],
  );
});
