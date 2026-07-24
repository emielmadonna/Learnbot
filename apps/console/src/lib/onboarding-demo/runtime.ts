import "server-only";

import {
  ExplicitFixtureOnboardingRepository,
  OnboardingError,
  OnboardingService,
  createOnboardingWorkspaceSeed,
  type OnboardingAggregate,
} from "@course-ai/onboarding-core";

import { developmentFixturesAllowed } from "../deployment-mode";

const SEEDED_AT = "2026-07-24T12:00:00.000Z";

function seed(tenantId: string): OnboardingAggregate {
  return {
    workspace: createOnboardingWorkspaceSeed({
      onboardingId: `onboarding_${tenantId}`,
      tenantId,
      displayName: "Northstar Academy",
      slug: "northstar-academy",
      planId: "enterprise",
      assistantName: "Nova",
      primaryColor: "#315F50",
      accentColor: "#D8A653",
      now: SEEDED_AT,
    }),
    invitations: [],
    audit: [],
  };
}

function createExplicitFixtureRuntime(tenantId: string): OnboardingService {
  if (!developmentFixturesAllowed()) {
    throw new OnboardingError(
      "onboarding.durable_adapter_required",
      "Fixture onboarding is disabled outside an acknowledged preview.",
    );
  }
  const repository = new ExplicitFixtureOnboardingRepository([seed(tenantId)]);
  return new OnboardingService(repository, {
    requiredDurability: "fixture",
  });
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __learningBotOnboardingFixtureRuntimes?: Map<string, OnboardingService>;
};

export function getOnboardingFixtureRuntime(
  tenantId: string,
): OnboardingService {
  const requiredMode =
    process.env.COURSE_AI_ONBOARDING_STORE_MODE ?? "fixture";
  if (requiredMode !== "fixture") {
    throw new OnboardingError(
      "onboarding.durable_adapter_required",
      "Durable onboarding mode requires an injected durable repository.",
      { requiredMode },
    );
  }
  runtimeGlobal.__learningBotOnboardingFixtureRuntimes ??= new Map();
  let runtime =
    runtimeGlobal.__learningBotOnboardingFixtureRuntimes.get(tenantId);
  if (runtime === undefined) {
    runtime = createExplicitFixtureRuntime(tenantId);
    runtimeGlobal.__learningBotOnboardingFixtureRuntimes.set(
      tenantId,
      runtime,
    );
  }
  return runtime;
}
