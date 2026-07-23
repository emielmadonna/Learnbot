import type {
  IsoTimestamp,
  LessonId,
  TenantId
} from "./common.js";
import type { PageContext } from "./conversation.js";
import type { RequestContext } from "./context.js";

export interface TenantBranding {
  readonly tenantId: TenantId;
  readonly version: number;
  readonly assistant: {
    readonly name: string;
    readonly avatarUrl?: string;
    readonly logoUrl?: string;
    readonly welcomeMessage: string;
  };
  readonly colors: {
    readonly primary: string;
    readonly accent: string;
    readonly canvas: string;
    readonly surface: string;
    readonly text: string;
  };
  readonly typography: {
    readonly family: "system" | "editorial" | "humanist";
  };
  readonly launcher: {
    readonly style: "bubble" | "pill" | "avatar";
    readonly position: "bottom_left" | "bottom_right";
    readonly label?: string;
  };
  readonly attribution: {
    readonly showPlatformAttribution: boolean;
    readonly privacyUrl?: string;
    readonly termsUrl?: string;
    readonly supportUrl?: string;
  };
  readonly voice: {
    readonly enabled: boolean;
    readonly voiceId?: string;
    readonly displayName?: string;
  };
  readonly updatedAt: IsoTimestamp;
}

export interface LearningContextMapping {
  readonly mappingId: string;
  readonly tenantId: TenantId;
  readonly enabled: boolean;
  readonly priority: number;
  readonly match:
    | { readonly type: "exact"; readonly url: string }
    | { readonly type: "prefix"; readonly urlPrefix: string }
    | { readonly type: "pattern"; readonly safePattern: string };
  readonly context: {
    readonly courseId: string;
    readonly course: string;
    readonly moduleId?: string;
    readonly module?: string;
    readonly lessonId?: LessonId;
    readonly lesson?: string;
  };
  readonly updatedAt: IsoTimestamp;
}

export interface StudentLearningProgress {
  readonly courseId: string;
  readonly moduleId?: string;
  readonly lessonId?: LessonId;
  readonly coursePercentComplete?: number;
  readonly modulePercentComplete?: number;
  readonly completedLessonIds: readonly LessonId[];
  readonly updatedAt: IsoTimestamp;
}

export interface ResolvedLearningContext extends PageContext {
  readonly source:
    | "verified_host_context"
    | "url_mapping"
    | "progress_resume"
    | "unknown";
  readonly confidence: number;
  readonly progress?: StudentLearningProgress;
  readonly resolvedAt: IsoTimestamp;
}

export interface WidgetPresentationState {
  readonly mode: "launcher" | "panel" | "expanded" | "mobile_sheet";
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly voiceActive: boolean;
}

export interface BrandingService {
  getPublished(context: RequestContext): Promise<TenantBranding>;
  getDraft(context: RequestContext): Promise<TenantBranding | undefined>;
  saveDraft(
    context: RequestContext,
    branding: TenantBranding
  ): Promise<TenantBranding>;
  publish(context: RequestContext, version: number): Promise<TenantBranding>;
  rollback(context: RequestContext, version: number): Promise<TenantBranding>;
}

export interface LearningContextResolver {
  resolve(
    context: RequestContext,
    input: {
      readonly page: PageContext;
      readonly hostContext?: PageContext;
      readonly progress?: StudentLearningProgress;
    }
  ): Promise<ResolvedLearningContext>;
}
