export type DurableAdapterErrorCode =
  | "durable.idempotency_conflict"
  | "durable.receipt_invalid_state"
  | "durable.revision_conflict"
  | "durable.outbox_conflict"
  | "durable.outbox_lease_lost"
  | "durable.invalid_json"
  | "durable.invalid_row";

export class DurableAdapterError extends Error {
  readonly code: DurableAdapterErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DurableAdapterErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DurableAdapterError";
    this.code = code;
    this.details = details;
  }
}
