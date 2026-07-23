export type PrivacyErrorCode =
  | "privacy.unauthorized"
  | "privacy.cross_tenant"
  | "privacy.invalid_input"
  | "privacy.job_not_found"
  | "privacy.manifest_not_found"
  | "privacy.idempotency_conflict"
  | "privacy.version_conflict";

export class PrivacyLifecycleError extends Error {
  constructor(
    readonly code: PrivacyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrivacyLifecycleError";
  }
}

export function requirePrivacy(
  condition: unknown,
  code: PrivacyErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new PrivacyLifecycleError(code, message);
}
