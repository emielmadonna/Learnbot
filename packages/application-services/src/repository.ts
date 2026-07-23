import type { TenantId } from "@course-ai/contracts";
import { ApplicationError } from "./errors.js";

export interface TenantOwned {
  readonly tenantId: TenantId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-memory reference adapter with the same mandatory tenant partition key a
 * durable repository must use. There is intentionally no unscoped get/list.
 */
export class TenantMemoryRepository<T extends TenantOwned> {
  readonly #partitions = new Map<TenantId, Map<string, T>>();
  readonly #keyOf: (record: T) => string;

  constructor(keyOf: (record: T) => string) {
    this.#keyOf = keyOf;
  }

  seed(record: T): void {
    this.put(record.tenantId, record);
  }

  get(tenantId: TenantId, id: string): T | undefined {
    this.#assertTenant(tenantId);
    const value = this.#partitions.get(tenantId)?.get(id);
    return value === undefined ? undefined : clone(value);
  }

  list(tenantId: TenantId): readonly T[] {
    this.#assertTenant(tenantId);
    return [...(this.#partitions.get(tenantId)?.values() ?? [])].map(clone);
  }

  put(tenantId: TenantId, record: T): T {
    this.#assertTenant(tenantId);
    if (record.tenantId !== tenantId) {
      throw new ApplicationError(
        "PERMISSION_DENIED",
        "A resource cannot be written outside the active tenant partition.",
      );
    }
    let partition = this.#partitions.get(tenantId);
    if (partition === undefined) {
      partition = new Map<string, T>();
      this.#partitions.set(tenantId, partition);
    }
    const copy = clone(record);
    partition.set(this.#keyOf(copy), copy);
    return clone(copy);
  }

  delete(tenantId: TenantId, id: string): boolean {
    this.#assertTenant(tenantId);
    return this.#partitions.get(tenantId)?.delete(id) ?? false;
  }

  #assertTenant(tenantId: TenantId): void {
    if (tenantId.trim().length === 0) {
      throw new ApplicationError(
        "INVALID_CONTEXT",
        "A non-empty tenant partition is required.",
      );
    }
  }
}

interface IdempotencyRecord extends TenantOwned {
  readonly recordId: string;
  readonly fingerprint: string;
  readonly value: unknown;
}

export class TenantIdempotencyStore {
  readonly #records = new TenantMemoryRepository<IdempotencyRecord>(
    (record) => record.recordId,
  );

  replay<T>(
    tenantId: TenantId,
    scope: string,
    key: string,
    fingerprint: string,
  ): T | undefined {
    const record = this.#records.get(tenantId, `${scope}:${key}`);
    if (record === undefined) {
      return undefined;
    }
    if (record.fingerprint !== fingerprint) {
      throw new ApplicationError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with different input.",
        { scope },
      );
    }
    return structuredClone(record.value) as T;
  }

  remember<T>(
    tenantId: TenantId,
    scope: string,
    key: string,
    fingerprint: string,
    value: T,
  ): T {
    if (key.trim().length === 0) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "An idempotency key is required.",
      );
    }
    this.#records.put(tenantId, {
      recordId: `${scope}:${key}`,
      tenantId,
      fingerprint,
      value: structuredClone(value),
    });
    return structuredClone(value);
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
