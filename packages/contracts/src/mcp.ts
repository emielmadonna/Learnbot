import type {
  ActorId,
  ContentHash,
  IsoTimestamp,
  JsonObject,
  JsonValue,
  ProtectedObjectRef,
  TenantId,
  TraceId,
} from "./common.js";
import type { RequestContext } from "./context.js";
import type { Money, ProviderOutcome } from "./providers.js";

export type ToolRisk =
  | "read_low"
  | "read_sensitive"
  | "write_reversible"
  | "write_high";

export type McpTransport =
  | { readonly type: "stdio"; readonly commandRef: string }
  | { readonly type: "http"; readonly endpointRef: string }
  | { readonly type: "sse"; readonly endpointRef: string };

export interface RegisteredMcpServer {
  readonly serverId: string;
  readonly name: string;
  readonly version: string;
  readonly owner: string;
  readonly adapterId: string;
  readonly transport: McpTransport;
  readonly credentialRef?: string;
  readonly status: "active" | "degraded" | "disabled";
  readonly registeredAt: IsoTimestamp;
}

export interface RegisteredTool {
  readonly serverId: string;
  readonly toolName: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly permissions: readonly string[];
  readonly risk: ToolRisk;
  readonly capabilities: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly adapterId: string;
  readonly idempotent: boolean;
}

export interface TenantToolEnablement {
  readonly tenantId: TenantId;
  readonly serverId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly enabled: boolean;
  readonly allowedRoles: readonly string[];
  readonly permissions: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly maxCostPerInvocation?: Money;
  readonly policyVersion: string;
}

/** Short-lived, input-bound authorization produced by policy, never by a model. */
export interface ToolGrant {
  readonly grantId: string;
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly role: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly permissions: readonly string[];
  readonly risk: ToolRisk;
  readonly expiresAt: IsoTimestamp;
  readonly inputHash: ContentHash;
  readonly policyVersion: string;
  readonly idempotencyKey?: string;
  readonly confirmationRef?: string;
}

export type ToolAuthorizationDecision =
  | {
      readonly allowed: true;
      readonly grant: ToolGrant;
    }
  | {
      readonly allowed: false;
      readonly reasonCode:
        | "unregistered"
        | "disabled"
        | "tenant_mismatch"
        | "role_forbidden"
        | "permission_denied"
        | "confirmation_required"
        | "rate_exceeded"
        | "budget_exceeded"
        | "input_invalid";
      readonly safeMessage: string;
      readonly policyVersion: string;
    };

export interface ToolProposal {
  readonly serverId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly normalizedInput: JsonObject;
  readonly inputHash: ContentHash;
  readonly requestedPermissions: readonly string[];
  readonly idempotencyKey?: string;
}

export interface ToolInvocationInput {
  readonly invocationId: string;
  readonly grant: ToolGrant;
  readonly normalizedInput: JsonObject;
  readonly inputHash: ContentHash;
  readonly traceId: TraceId;
}

export interface ToolInvocationResult {
  readonly invocationId: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly inlineOutput?: JsonValue;
  readonly outputRef?: ProtectedObjectRef;
  readonly outputHash?: ContentHash;
  readonly sanitized: boolean;
  readonly truncated: boolean;
}

export interface ToolInvocationAudit {
  readonly invocationId: string;
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly role: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly risk: ToolRisk;
  readonly decision: "allowed" | "denied";
  readonly reasonCode: string;
  readonly inputHash: ContentHash;
  readonly outputHash?: ContentHash;
  readonly outputRef?: ProtectedObjectRef;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly status: "denied" | "running" | "succeeded" | "failed";
  readonly retryCount: number;
  readonly cost?: Money;
  readonly traceId: TraceId;
  readonly providerMetadata?: JsonObject;
}

export interface McpRegistry {
  resolveTool(
    tenantId: TenantId,
    serverId: string,
    toolName: string,
    version?: string,
  ): Promise<RegisteredTool | undefined>;
  listAllowedTools(
    context: RequestContext,
  ): Promise<readonly RegisteredTool[]>;
}

export interface ToolPolicy {
  authorize(
    context: RequestContext,
    proposal: ToolProposal,
  ): Promise<ToolAuthorizationDecision>;
}

export interface ToolRouter {
  invoke(
    context: RequestContext,
    input: ToolInvocationInput,
  ): Promise<ProviderOutcome<ToolInvocationResult>>;
}
