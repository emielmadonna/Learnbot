export type ApplicationErrorCode =
  | "INVALID_CONTEXT"
  | "TENANT_INACTIVE"
  | "PERMISSION_DENIED"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "IDEMPOTENCY_CONFLICT";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly safeDetails: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.safeDetails = safeDetails;
  }
}
