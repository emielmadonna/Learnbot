import type {
  ActorId,
  ConversationId,
  IsoTimestamp,
  JsonObject,
  RequestId,
  SessionId,
  TenantId,
  TraceId,
} from "./common.js";

export type ActorType = "student" | "creator" | "owner" | "system";
export type IdentityTier = "verified" | "self_reported" | "anonymous";
export type FundingSource = "platform" | "tenant_byok";
export type EnvironmentName = "local" | "test" | "staging" | "production";

export interface ActorContext {
  readonly type: ActorType;
  readonly id?: ActorId;
  readonly role?: string;
  readonly identityTier?: IdentityTier;
}

/**
 * Boundary-authorized request context.
 *
 * `tenantId` is resolved from trusted identity/public-key context and must not
 * be copied from an untrusted request body. `deadlineMs` is an absolute Unix
 * timestamp so every downstream retry shares one total budget.
 */
export interface RequestContext {
  readonly requestId: RequestId;
  readonly tenantId: TenantId;
  readonly actor: ActorContext;
  readonly sessionId?: SessionId;
  readonly conversationId?: ConversationId;
  readonly fundingSource: FundingSource;
  readonly deadlineMs: number;
  readonly traceId: TraceId;
  readonly environment?: EnvironmentName;
}

export interface TenantContext {
  readonly tenantId: TenantId;
  readonly slug: string;
  readonly status: "provisioning" | "active" | "suspended" | "archived";
  readonly planId: string;
  readonly region?: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly limits: Readonly<Record<string, number>>;
  readonly policyVersion: string;
  readonly resolvedAt: IsoTimestamp;
}

export interface TenantResolutionInput {
  readonly publicKey?: string;
  readonly host?: string;
  readonly accessToken?: string;
}

export interface AuthorizedRequest<TBody = unknown> {
  readonly context: RequestContext;
  readonly tenant: TenantContext;
  readonly body: TBody;
}

export interface AuditPrincipal {
  readonly tenantId: TenantId;
  readonly actor: ActorContext;
  readonly requestId: RequestId;
  readonly traceId: TraceId;
  readonly authenticatedAt: IsoTimestamp;
  readonly authenticationMethod: string;
  readonly claims?: JsonObject;
}

/** Compares tenant IDs without ever accepting a missing scope. */
export function isSameTenant(
  context: Pick<RequestContext, "tenantId">,
  resource: { readonly tenantId: TenantId },
): boolean {
  return context.tenantId.length > 0 && context.tenantId === resource.tenantId;
}

/** Remaining time in the request's shared deadline budget. */
export function remainingDeadlineMs(
  context: Pick<RequestContext, "deadlineMs">,
  nowMs: number = Date.now(),
): number {
  return Math.max(0, context.deadlineMs - nowMs);
}
