import type {
  Capability,
  FundingSource,
  RoutePolicy,
  TenantId,
} from "@course-ai/contracts";
import type {
  RoutePolicyResolution,
  RoutePolicyResolver,
} from "./types.js";

export interface VersionedRoutePolicy {
  readonly policy: RoutePolicy;
  readonly policyVersion: string;
}

function key(
  tenantId: TenantId,
  capability: Capability,
  fundingSource: FundingSource,
): string {
  return `${tenantId}\u0000${capability}\u0000${fundingSource}`;
}

/**
 * Resolves tenant policies before platform defaults. BYOK never inherits a
 * platform-funded default because doing so would silently change who pays.
 */
export class InMemoryRoutePolicyResolver implements RoutePolicyResolver {
  readonly #tenantPolicies = new Map<string, VersionedRoutePolicy>();
  readonly #platformDefaults = new Map<
    Capability,
    VersionedRoutePolicy
  >();

  constructor(input?: {
    readonly tenantPolicies?: readonly VersionedRoutePolicy[];
    readonly platformDefaults?: readonly VersionedRoutePolicy[];
  }) {
    for (const entry of input?.tenantPolicies ?? []) {
      this.setTenantPolicy(entry);
    }
    for (const entry of input?.platformDefaults ?? []) {
      this.setPlatformDefault(entry);
    }
  }

  setTenantPolicy(entry: VersionedRoutePolicy): void {
    const policy = entry.policy;
    this.#tenantPolicies.set(
      key(policy.tenantId, policy.capability, policy.fundingSource),
      entry,
    );
  }

  setPlatformDefault(entry: VersionedRoutePolicy): void {
    if (entry.policy.fundingSource !== "platform") {
      throw new Error("Platform defaults must use platform funding.");
    }
    this.#platformDefaults.set(entry.policy.capability, entry);
  }

  async resolve(
    tenantId: TenantId,
    capability: Capability,
    fundingSource: FundingSource,
  ): Promise<RoutePolicyResolution | undefined> {
    const tenant = this.#tenantPolicies.get(
      key(tenantId, capability, fundingSource),
    );
    if (tenant !== undefined) {
      return {
        policy: tenant.policy,
        policyVersion: tenant.policyVersion,
        source: "tenant",
      };
    }

    if (fundingSource === "tenant_byok") {
      return undefined;
    }

    const defaultEntry = this.#platformDefaults.get(capability);
    if (defaultEntry === undefined) {
      return undefined;
    }

    return {
      policy: {
        ...defaultEntry.policy,
        tenantId,
        fundingSource,
      },
      policyVersion: defaultEntry.policyVersion,
      source: "platform_default",
    };
  }
}
