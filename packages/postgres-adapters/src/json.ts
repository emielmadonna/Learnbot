import { DurableAdapterError } from "./errors.js";

export interface SerializedDurableJson {
  readonly text: string;
  readonly value: unknown;
}

/**
 * Produces the exact JSON value that Postgres will return. Returning this
 * normalized value on the first command execution keeps it identical to later
 * idempotent replays (including omitted object properties and toJSON output).
 */
export function serializeDurableJson(
  value: unknown,
  subject: string,
): SerializedDurableJson {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new DurableAdapterError(
      "durable.invalid_json",
      `${subject} must be JSON serializable.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (text === undefined) {
    throw new DurableAdapterError(
      "durable.invalid_json",
      `${subject} cannot be undefined.`,
    );
  }
  return { text, value: JSON.parse(text) as unknown };
}
