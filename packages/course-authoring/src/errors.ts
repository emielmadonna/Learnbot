export type AuthoringErrorCode =
  | "authoring.invalid_input"
  | "authoring.unauthorized"
  | "authoring.tenant_mismatch"
  | "authoring.not_found"
  | "authoring.version_conflict"
  | "authoring.idempotency_conflict"
  | "authoring.validation_failed"
  | "authoring.deadline_exceeded";

export class AuthoringError extends Error {
  readonly code: AuthoringErrorCode;
  readonly safeDetails: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: AuthoringErrorCode,
    message: string,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "AuthoringError";
    this.code = code;
    this.safeDetails = safeDetails;
  }
}

export function requireAuthoring(
  condition: unknown,
  code: AuthoringErrorCode,
  message: string,
  safeDetails?: Readonly<Record<string, string | number | boolean>>,
): asserts condition {
  if (!condition) {
    throw new AuthoringError(code, message, safeDetails);
  }
}
