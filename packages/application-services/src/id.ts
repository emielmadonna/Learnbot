import type { TenantId } from "@course-ai/contracts";
import type { IdGenerator } from "./types.js";

function hash(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

export class DeterministicIdGenerator implements IdGenerator {
  deterministic(
    prefix: string,
    tenantId: TenantId,
    scope: string,
    key: string,
  ): string {
    return `${prefix}_${hash(`${tenantId}\u0000${scope}\u0000${key}`)}`;
  }
}
