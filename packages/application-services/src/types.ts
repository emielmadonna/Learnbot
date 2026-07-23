import type {
  ActorId,
  Capability,
  ChatAttachment,
  Conversation,
  CostLedgerEntry,
  CourseDraft,
  IngestionJob,
  IsoTimestamp,
  JsonObject,
  LearningContextMapping,
  LearningSource,
  RequestContext,
  ResolvedLearningContext,
  StudentLearningProgress,
  TenantBranding,
  TenantContext,
  TenantId,
} from "@course-ai/contracts";

export const PLATFORM_ROLES = [
  "platform_admin",
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
  "service",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  "tenant.read",
  "tenant.write",
  "branding.read",
  "branding.write",
  "context.read",
  "context.write",
  "course.read",
  "course.write",
  "source.read",
  "source.write",
  "job.read",
  "job.write",
  "conversation.read",
  "conversation.write",
  "attachment.read",
  "attachment.write",
  "audit.read",
  "cost.read",
  "cost.write",
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export interface AuthorizedTenantContext extends RequestContext {
  readonly tenant: TenantContext;
  readonly role: PlatformRole;
  readonly permissions: ReadonlySet<PlatformPermission>;
}

export interface TenantConfigurationRecord {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly tenant: TenantContext;
  readonly settings: JsonObject;
  readonly version: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface TenantConfigurationPatch {
  readonly displayName?: string;
  readonly planId?: string;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
  readonly limits?: Readonly<Record<string, number>>;
  readonly settings?: JsonObject;
}

export interface BrandingDraftInput {
  readonly assistant: TenantBranding["assistant"];
  readonly colors: TenantBranding["colors"];
  readonly typography: TenantBranding["typography"];
  readonly launcher: TenantBranding["launcher"];
  readonly attribution: TenantBranding["attribution"];
  readonly voice: TenantBranding["voice"];
}

export interface StudentProgressRecord {
  readonly tenantId: TenantId;
  readonly studentId: string;
  readonly progress: StudentLearningProgress;
  readonly updatedAt: IsoTimestamp;
}

export interface ContextResolutionInput {
  readonly page: {
    readonly url: string;
    readonly title?: string;
    readonly courseId?: string;
    readonly course?: string;
    readonly moduleId?: string;
    readonly module?: string;
    readonly lessonId?: string;
    readonly lesson?: string;
  };
  readonly hostContext?: ContextResolutionInput["page"];
  readonly studentId?: string;
}

export interface AuditRecord {
  readonly auditId: string;
  readonly tenantId: TenantId;
  readonly actorId?: ActorId;
  readonly actorRole: PlatformRole;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly occurredAt: IsoTimestamp;
  readonly safeMetadata: JsonObject;
}

export interface CostRecordInput {
  readonly idempotencyKey: string;
  readonly referenceType: CostLedgerEntry["referenceType"];
  readonly referenceId: string;
  readonly attemptId?: string;
  readonly feature: string;
  readonly capability: Capability;
  readonly provider: string;
  readonly adapterId: string;
  readonly modelOrSku?: string;
  readonly quantities: CostLedgerEntry["quantities"];
  readonly amount: number;
  readonly currency: string;
  readonly status: CostLedgerEntry["cost"]["status"];
  readonly occurredAt?: IsoTimestamp;
  readonly safeMetadata?: JsonObject;
}

export interface StartJobInput {
  readonly type: IngestionJob["type"];
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly parentJobId?: string;
}

export interface CreateConversationInput {
  readonly idempotencyKey: string;
  readonly studentId?: string;
  readonly identityTier: Conversation["identityTier"];
  readonly activeModality: Conversation["activeModality"];
  readonly pageContext?: Conversation["pageContext"];
}

export interface CreateAttachmentInput {
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly kind: ChatAttachment["kind"];
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentHash?: string;
}

export interface PlatformSeed {
  readonly tenants?: readonly TenantConfigurationRecord[];
  readonly branding?: readonly TenantBranding[];
  readonly mappings?: readonly LearningContextMapping[];
  readonly progress?: readonly StudentProgressRecord[];
  readonly courses?: readonly CourseDraft[];
  readonly sources?: readonly LearningSource[];
  readonly jobs?: readonly IngestionJob[];
  readonly conversations?: readonly Conversation[];
  readonly attachments?: readonly ChatAttachment[];
  readonly audits?: readonly AuditRecord[];
  readonly costs?: readonly CostLedgerEntry[];
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  deterministic(
    prefix: string,
    tenantId: TenantId,
    scope: string,
    key: string,
  ): string;
}

export type LearningContextResult = ResolvedLearningContext;
