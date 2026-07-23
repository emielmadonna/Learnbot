import type {
  FundingTransitionAuthorizer,
  FundingTransitionDecision,
  FundingTransitionGrant,
  FundingTransitionRequest,
} from "./types.js";

export class InMemoryFundingTransitionAuthorizer
  implements FundingTransitionAuthorizer
{
  readonly #grants = new Map<string, FundingTransitionGrant>();

  constructor(grants: readonly FundingTransitionGrant[] = []) {
    for (const grant of grants) {
      this.#grants.set(grant.grantId, grant);
    }
  }

  async authorize(input: {
    readonly request: FundingTransitionRequest;
    readonly tenantId: string;
    readonly capability: FundingTransitionGrant["capability"];
    readonly fromFundingSource: FundingTransitionGrant["fromFundingSource"];
    readonly now: string;
  }): Promise<FundingTransitionDecision> {
    const grant = this.#grants.get(input.request.grantId);
    if (grant === undefined) {
      return { authorized: false, reasonCode: "grant_not_found" };
    }
    if (
      grant.tenantId !== input.tenantId ||
      grant.capability !== input.capability ||
      grant.fromFundingSource !== input.fromFundingSource ||
      grant.toFundingSource !== input.request.targetFundingSource
    ) {
      return { authorized: false, reasonCode: "scope_mismatch" };
    }
    if (grant.fromFundingSource === grant.toFundingSource) {
      return { authorized: false, reasonCode: "same_funding_source" };
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(input.now)) {
      return { authorized: false, reasonCode: "expired" };
    }
    return { authorized: true, grant };
  }
}
