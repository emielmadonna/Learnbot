import { createHash, timingSafeEqual } from "node:crypto";

export const WRITE_PERMISSIONS = [
  "course.create",
  "course.update",
  "course.authoring.edit",
  "course.authoring.diagram.approve",
  "course.authoring.publish",
  "course.authoring.rollback",
  "intelligence.opportunity.review",
  "learning.ingestion.start",
  "learning.version.publish",
  "branding.publish",
  "privacy.access_export.manage",
  "privacy.delete.manage",
  "privacy.retention.manage",
  "privacy.manifest.verify",
] as const;

export type WritePermission = (typeof WRITE_PERMISSIONS)[number];

export interface MutationContext {
  tenantId: string;
  actorId: string;
  requestId: string;
  grantId: string;
  grantToken: string;
  idempotencyKey: string;
}

export interface McpGrant {
  grantId: string;
  tenantId: string;
  actorId: string;
  tokenSha256: string;
  permissions: readonly WritePermission[];
  expiresAt: string;
  budgetUsd: number;
  maxRequestsPerMinute: number;
}

export type SafeErrorCode =
  | "MCP_ACCESS_DENIED"
  | "MCP_IDEMPOTENCY_CONFLICT"
  | "MCP_INVALID_CONFIGURATION"
  | "MCP_UPSTREAM_UNAVAILABLE"
  | "MCP_UPSTREAM_REJECTED"
  | "MCP_INTERNAL_ERROR";

export interface SafeErrorPayload {
  code: SafeErrorCode;
  message: string;
  retryable: boolean;
  requestId?: string;
}

export class McpSafeError extends Error {
  readonly code: SafeErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | undefined;

  constructor(payload: SafeErrorPayload) {
    super(payload.message);
    this.name = "McpSafeError";
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.requestId = payload.requestId;
  }

  toPayload(): SafeErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

interface GrantConfiguration {
  grants: readonly McpGrant[];
  valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWritePermission(value: unknown): value is WritePermission {
  return (
    typeof value === "string" &&
    WRITE_PERMISSIONS.includes(value as WritePermission)
  );
}

function parseGrant(value: unknown): McpGrant | undefined {
  if (!isRecord(value)) return undefined;
  const { grantId, tenantId, actorId, tokenSha256, permissions } = value;
  const { expiresAt, budgetUsd, maxRequestsPerMinute } = value;
  if (
    typeof grantId !== "string" ||
    grantId.length === 0 ||
    typeof tenantId !== "string" ||
    tenantId.length === 0 ||
    typeof actorId !== "string" ||
    actorId.length === 0 ||
    typeof tokenSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(tokenSha256) ||
    !Array.isArray(permissions) ||
    permissions.length === 0 ||
    !permissions.every(isWritePermission) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    typeof budgetUsd !== "number" ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    typeof maxRequestsPerMinute !== "number" ||
    !Number.isInteger(maxRequestsPerMinute) ||
    maxRequestsPerMinute <= 0 ||
    maxRequestsPerMinute > 10_000
  ) {
    return undefined;
  }
  return {
    grantId,
    tenantId,
    actorId,
    tokenSha256: tokenSha256.toLowerCase(),
    permissions,
    expiresAt,
    budgetUsd,
    maxRequestsPerMinute,
  };
}

export function parseGrantConfiguration(raw: string | undefined): GrantConfiguration {
  if (!raw) return { grants: [], valid: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { grants: [], valid: false };
    const grants = parsed.map(parseGrant);
    if (grants.some((grant) => grant === undefined)) {
      return { grants: [], valid: false };
    }
    const resolved = grants as McpGrant[];
    if (new Set(resolved.map((grant) => grant.grantId)).size !== resolved.length) {
      return { grants: [], valid: false };
    }
    return { grants: resolved, valid: true };
  } catch {
    return { grants: [], valid: false };
  }
}

export class GrantAuthorizer {
  readonly configuredGrantCount: number;
  readonly configurationValid: boolean;
  readonly #grants: ReadonlyMap<string, McpGrant>;
  readonly #reservations = new Map<string, number>();
  readonly #reservedByGrant = new Map<string, number>();
  readonly #requestTimesByGrant = new Map<string, number[]>();

  constructor(configuration: GrantConfiguration) {
    this.configurationValid = configuration.valid;
    this.configuredGrantCount = configuration.grants.length;
    this.#grants = new Map(
      configuration.grants.map((grant) => [grant.grantId, grant]),
    );
  }

  authorize(
    context: MutationContext,
    permission: WritePermission,
    options: {
      readonly operation?: string;
      readonly estimatedCostUsd?: number;
      readonly nowMs?: number;
    } = {},
  ): void {
    if (!this.configurationValid) {
      throw new McpSafeError({
        code: "MCP_INVALID_CONFIGURATION",
        message: "MCP write authorization is not configured correctly.",
        retryable: false,
        requestId: context.requestId,
      });
    }
    const grant = this.#grants.get(context.grantId);
    const suppliedTokenHash = createHash("sha256")
      .update(context.grantToken)
      .digest();
    const configuredTokenHash =
      grant === undefined ? Buffer.alloc(32) : Buffer.from(grant.tokenSha256, "hex");
    const tokenMatches = timingSafeEqual(suppliedTokenHash, configuredTokenHash);
    const nowMs = options.nowMs ?? Date.now();
    const expiresAtMs =
      grant === undefined ? Number.NEGATIVE_INFINITY : Date.parse(grant.expiresAt);
    const estimatedCostUsd = options.estimatedCostUsd ?? 0;
    const validEstimate =
      Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0;
    const permitted =
      grant !== undefined &&
      tokenMatches &&
      grant.tenantId === context.tenantId &&
      grant.actorId === context.actorId &&
      grant.permissions.includes(permission) &&
      expiresAtMs > nowMs &&
      validEstimate;
    if (!permitted) {
      throw new McpSafeError({
        code: "MCP_ACCESS_DENIED",
        message: "The MCP principal is not authorized for this tenant operation.",
        retryable: false,
        requestId: context.requestId,
      });
    }
    const authorizedGrant = grant as McpGrant;

    const reservationKey = [
      context.grantId,
      options.operation ?? permission,
      context.idempotencyKey,
    ].join(":");
    const existingReservation = this.#reservations.get(reservationKey);
    if (
      existingReservation !== undefined &&
      existingReservation !== estimatedCostUsd
    ) {
      throw new McpSafeError({
        code: "MCP_ACCESS_DENIED",
        message: "The MCP budget reservation does not match the original request.",
        retryable: false,
        requestId: context.requestId,
      });
    }
    if (existingReservation !== undefined) return;

    const recentRequestTimes = (
      this.#requestTimesByGrant.get(context.grantId) ?? []
    ).filter((timestamp) => timestamp > nowMs - 60_000);
    if (recentRequestTimes.length >= authorizedGrant.maxRequestsPerMinute) {
      throw new McpSafeError({
        code: "MCP_ACCESS_DENIED",
        message: "The MCP grant rate limit has been reached.",
        retryable: true,
        requestId: context.requestId,
      });
    }

    const alreadyReserved = this.#reservedByGrant.get(context.grantId) ?? 0;
    if (alreadyReserved + estimatedCostUsd > authorizedGrant.budgetUsd) {
      throw new McpSafeError({
        code: "MCP_ACCESS_DENIED",
        message: "The MCP grant budget is insufficient for this operation.",
        retryable: false,
        requestId: context.requestId,
      });
    }
    this.#reservations.set(reservationKey, estimatedCostUsd);
    this.#reservedByGrant.set(
      context.grantId,
      alreadyReserved + estimatedCostUsd,
    );
    this.#requestTimesByGrant.set(context.grantId, [
      ...recentRequestTimes,
      nowMs,
    ]);
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface IdempotencyEntry<T> {
  fingerprint: string;
  result: Promise<T>;
}

export class IdempotencyStore {
  readonly #entries = new Map<string, IdempotencyEntry<unknown>>();
  readonly #maximumEntries: number;

  constructor(maximumEntries = 1_000) {
    this.#maximumEntries = maximumEntries;
  }

  async execute<T>(
    context: MutationContext,
    operation: string,
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    const scope = [
      context.tenantId,
      context.actorId,
      operation,
      context.idempotencyKey,
    ].join(":");
    const fingerprint = createHash("sha256")
      .update(canonicalize(input))
      .digest("hex");
    const existing = this.#entries.get(scope);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new McpSafeError({
          code: "MCP_IDEMPOTENCY_CONFLICT",
          message: "The idempotency key was already used with different input.",
          retryable: false,
          requestId: context.requestId,
        });
      }
      return existing.result as Promise<T>;
    }

    if (this.#entries.size >= this.#maximumEntries) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey) this.#entries.delete(oldestKey);
    }
    const result = action().catch((error: unknown) => {
      this.#entries.delete(scope);
      throw error;
    });
    this.#entries.set(scope, { fingerprint, result });
    return result;
  }
}

export function mutationHeaders(context: MutationContext): Record<string, string> {
  return {
    "x-course-ai-tenant-id": context.tenantId,
    "x-course-ai-actor-id": context.actorId,
    "x-course-ai-request-id": context.requestId,
    "x-course-ai-mcp-grant-id": context.grantId,
    "idempotency-key": context.idempotencyKey,
  };
}

export interface ConsoleRequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ConsoleApiClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #maximumResponseBytes: number;

  constructor(
    baseUrl: string,
    fetchImplementation: FetchLike = fetch,
    maximumResponseBytes = 1_000_000,
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetchImplementation;
    this.#maximumResponseBytes = maximumResponseBytes;
  }

  async request<T>(
    path: string,
    options: ConsoleRequestOptions = {},
    requestId?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...options.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new McpSafeError({
        code: "MCP_UPSTREAM_UNAVAILABLE",
        message: "The Course AI control plane is temporarily unavailable.",
        retryable: true,
        ...(requestId ? { requestId } : {}),
      });
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.#maximumResponseBytes
    ) {
      throw new McpSafeError({
        code: "MCP_UPSTREAM_REJECTED",
        message: "The Course AI control plane response exceeded the safe limit.",
        retryable: false,
        ...(requestId ? { requestId } : {}),
      });
    }

    let payload: unknown;
    try {
      const serialized = await response.text();
      if (
        new TextEncoder().encode(serialized).byteLength >
        this.#maximumResponseBytes
      ) {
        throw new McpSafeError({
          code: "MCP_UPSTREAM_REJECTED",
          message:
            "The Course AI control plane response exceeded the safe limit.",
          retryable: false,
          ...(requestId ? { requestId } : {}),
        });
      }
      payload = JSON.parse(serialized);
    } catch (error: unknown) {
      if (error instanceof McpSafeError) throw error;
      throw new McpSafeError({
        code: "MCP_UPSTREAM_REJECTED",
        message: "The Course AI control plane returned an invalid response.",
        retryable: response.status >= 500,
        ...(requestId ? { requestId } : {}),
      });
    }
    if (!response.ok) {
      throw new McpSafeError({
        code:
          response.status === 401 || response.status === 403
            ? "MCP_ACCESS_DENIED"
            : "MCP_UPSTREAM_REJECTED",
        message:
          response.status === 401 || response.status === 403
            ? "The control plane denied this operation."
            : "The Course AI control plane rejected this operation.",
        retryable: response.status === 429 || response.status >= 500,
        ...(requestId ? { requestId } : {}),
      });
    }
    return payload as T;
  }
}

export function safeError(error: unknown, requestId?: string): SafeErrorPayload {
  if (error instanceof McpSafeError) return error.toPayload();
  return {
    code: "MCP_INTERNAL_ERROR",
    message: "The MCP operation could not be completed safely.",
    retryable: false,
    ...(requestId ? { requestId } : {}),
  };
}
