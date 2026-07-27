import { createHash } from "node:crypto";

/** sha256 hex digest, matching `encode(digest(text, 'sha256'), 'hex')` in SQL. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
