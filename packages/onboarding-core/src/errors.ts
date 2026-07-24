export type OnboardingErrorCode =
  | "onboarding.access_denied"
  | "onboarding.invalid_input"
  | "onboarding.not_found"
  | "onboarding.conflict"
  | "onboarding.idempotency_conflict"
  | "onboarding.policy_decision_required"
  | "onboarding.launch_blocked"
  | "onboarding.durable_adapter_required";

export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;
  readonly safeDetails: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: OnboardingErrorCode,
    message: string,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
    this.safeDetails = safeDetails;
  }
}
