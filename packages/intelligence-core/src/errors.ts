export type IntelligenceErrorCode =
  | "opportunity.not_found"
  | "opportunity.already_exists"
  | "opportunity.invalid_transition"
  | "opportunity.version_conflict"
  | "opportunity.tenant_mismatch"
  | "opportunity.invalid_input";

export class IntelligenceError extends Error {
  constructor(
    readonly code: IntelligenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntelligenceError";
  }
}

export function requireIntelligence(
  condition: unknown,
  code: IntelligenceErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new IntelligenceError(code, message);
}
