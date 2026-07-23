export type IdentityAccessErrorCode =
  | "AUTHENTICATION_FAILED"
  | "ACCESS_DENIED"
  | "TENANT_SELECTION_REQUIRED"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_REPLAYED"
  | "INVITATION_INVALID"
  | "CONFLICT"
  | "VALIDATION_FAILED";

const SAFE_MESSAGES: Readonly<Record<IdentityAccessErrorCode, string>> = {
  AUTHENTICATION_FAILED: "Authentication could not be verified.",
  ACCESS_DENIED: "The principal is not authorized for this operation.",
  TENANT_SELECTION_REQUIRED: "Select one of the available organizations.",
  TOKEN_INVALID: "The signed host context is invalid.",
  TOKEN_EXPIRED: "The signed host context has expired.",
  TOKEN_REPLAYED: "The signed host context has already been used.",
  INVITATION_INVALID: "The invitation cannot be accepted.",
  CONFLICT: "The requested identity operation conflicts with existing state.",
  VALIDATION_FAILED: "The identity request is invalid.",
};

export class IdentityAccessError extends Error {
  readonly code: IdentityAccessErrorCode;
  readonly safeDetails: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: IdentityAccessErrorCode,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "IdentityAccessError";
    this.code = code;
    this.safeDetails = sanitizeSafeDetails(safeDetails);
  }
}

const SECRET_KEYS =
  /token|secret|signature|assertion|password|authorization|cookie|email|subject/i;

export function sanitizeSafeDetails(
  details: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SECRET_KEYS.test(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

export function toSafeIdentityError(error: unknown): IdentityAccessError {
  if (error instanceof IdentityAccessError) {
    return error;
  }
  return new IdentityAccessError("AUTHENTICATION_FAILED");
}
