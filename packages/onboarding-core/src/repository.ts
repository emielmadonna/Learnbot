import type {
  OnboardingAuditEvent,
  OnboardingWorkspace,
  StoredOnboardingInvitation,
} from "./types.js";

export type OnboardingRepositoryDurability = "fixture" | "durable";

export interface OnboardingAggregate {
  readonly workspace: OnboardingWorkspace;
  readonly invitations: readonly StoredOnboardingInvitation[];
  readonly audit: readonly OnboardingAuditEvent[];
}

export interface OnboardingUnitOfWork {
  getWorkspace(): OnboardingWorkspace;
  saveWorkspace(workspace: OnboardingWorkspace): void;
  listInvitations(): readonly StoredOnboardingInvitation[];
  saveInvitation(invitation: StoredOnboardingInvitation): void;
  listAudit(): readonly OnboardingAuditEvent[];
  appendAudit(event: OnboardingAuditEvent): void;
}

export type IdempotentOnboardingResult<TResult> =
  | { readonly disposition: "committed"; readonly result: TResult }
  | { readonly disposition: "replayed"; readonly result: TResult };

export interface OnboardingRepository {
  readonly durability: OnboardingRepositoryDurability;

  read(tenantId: string): Promise<OnboardingAggregate | undefined>;

  execute<TResult>(input: {
    readonly tenantId: string;
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly operation: (
      transaction: OnboardingUnitOfWork,
    ) => Promise<TResult> | TResult;
  }): Promise<IdempotentOnboardingResult<TResult>>;
}
