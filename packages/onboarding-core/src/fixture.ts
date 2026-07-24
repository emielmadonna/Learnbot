import { OnboardingError } from "./errors.js";
import type {
  IdempotentOnboardingResult,
  OnboardingAggregate,
  OnboardingRepository,
  OnboardingUnitOfWork,
} from "./repository.js";
import type {
  OnboardingAuditEvent,
  OnboardingWorkspace,
  StoredOnboardingInvitation,
} from "./types.js";

interface MutableAggregate {
  workspace: OnboardingWorkspace;
  invitations: StoredOnboardingInvitation[];
  audit: OnboardingAuditEvent[];
}

interface Receipt {
  readonly fingerprint: string;
  readonly result: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FixtureUnitOfWork implements OnboardingUnitOfWork {
  constructor(private readonly aggregate: MutableAggregate) {}

  getWorkspace(): OnboardingWorkspace {
    return clone(this.aggregate.workspace);
  }

  saveWorkspace(workspace: OnboardingWorkspace): void {
    if (workspace.tenantId !== this.aggregate.workspace.tenantId) {
      throw new OnboardingError(
        "onboarding.access_denied",
        "Onboarding data cannot move between tenant partitions.",
      );
    }
    this.aggregate.workspace = clone(workspace);
  }

  listInvitations(): readonly StoredOnboardingInvitation[] {
    return clone(this.aggregate.invitations);
  }

  saveInvitation(invitation: StoredOnboardingInvitation): void {
    if (invitation.tenantId !== this.aggregate.workspace.tenantId) {
      throw new OnboardingError(
        "onboarding.access_denied",
        "An invitation cannot move between tenant partitions.",
      );
    }
    const index = this.aggregate.invitations.findIndex(
      (candidate) => candidate.invitationId === invitation.invitationId,
    );
    if (index >= 0) {
      this.aggregate.invitations[index] = clone(invitation);
    } else {
      this.aggregate.invitations.push(clone(invitation));
    }
  }

  listAudit(): readonly OnboardingAuditEvent[] {
    return clone(this.aggregate.audit);
  }

  appendAudit(event: OnboardingAuditEvent): void {
    if (event.tenantId !== this.aggregate.workspace.tenantId) {
      throw new OnboardingError(
        "onboarding.access_denied",
        "An audit event cannot move between tenant partitions.",
      );
    }
    this.aggregate.audit.push(clone(event));
  }
}

/**
 * Explicit local/test fixture adapter.
 *
 * Its name and `durability` marker are intentionally impossible to mistake for
 * production persistence. The service constructor rejects it when durable mode
 * is requested.
 */
export class ExplicitFixtureOnboardingRepository
  implements OnboardingRepository
{
  readonly durability = "fixture" as const;
  readonly #aggregates = new Map<string, MutableAggregate>();
  readonly #receipts = new Map<string, Receipt>();

  constructor(seed: readonly OnboardingAggregate[] = []) {
    for (const aggregate of seed) {
      this.#aggregates.set(aggregate.workspace.tenantId, clone({
        workspace: aggregate.workspace,
        invitations: [...aggregate.invitations],
        audit: [...aggregate.audit],
      }));
    }
  }

  async read(tenantId: string): Promise<OnboardingAggregate | undefined> {
    const aggregate = this.#aggregates.get(tenantId);
    return aggregate === undefined ? undefined : clone(aggregate);
  }

  async execute<TResult>(input: {
    readonly tenantId: string;
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly operation: (
      transaction: OnboardingUnitOfWork,
    ) => Promise<TResult> | TResult;
  }): Promise<IdempotentOnboardingResult<TResult>> {
    const receiptKey =
      `${input.tenantId}\u0000${input.scope}\u0000${input.idempotencyKey}`;
    const receipt = this.#receipts.get(receiptKey);
    if (receipt !== undefined) {
      if (receipt.fingerprint !== input.requestFingerprint) {
        throw new OnboardingError(
          "onboarding.idempotency_conflict",
          "The idempotency key was already used for a different request.",
          { scope: input.scope },
        );
      }
      return {
        disposition: "replayed",
        result: clone(receipt.result) as TResult,
      };
    }
    const current = this.#aggregates.get(input.tenantId);
    if (current === undefined) {
      throw new OnboardingError(
        "onboarding.not_found",
        "No onboarding workspace exists for the active tenant.",
      );
    }
    const working = clone(current);
    const result = await input.operation(new FixtureUnitOfWork(working));
    this.#aggregates.set(input.tenantId, working);
    this.#receipts.set(receiptKey, {
      fingerprint: input.requestFingerprint,
      result: clone(result),
    });
    return { disposition: "committed", result: clone(result) };
  }
}
