import type {
  ApplyCourseEditsResult,
  AssetId,
  ContentBlock,
  CourseDraft,
  CourseId,
  CourseLesson,
  CourseModule,
  CourseValidationIssue,
  IsoTimestamp,
  LessonId,
  ModuleId,
  RequestContext,
  TenantId,
} from "@course-ai/contracts";

export interface CreateCourseCommand {
  readonly idempotencyKey: string;
  readonly title: string;
  readonly slug: string;
  readonly description?: string;
}

export type CourseAuthoringOperation =
  | {
      readonly op: "course.update";
      readonly patch: {
        readonly title?: string;
        readonly slug?: string;
        readonly description?: string | null;
      };
    }
  | {
      readonly op: "module.create";
      readonly moduleId?: ModuleId;
      readonly title: string;
      readonly description?: string;
      readonly position?: number;
    }
  | {
      readonly op: "module.update";
      readonly moduleId: ModuleId;
      readonly patch: { readonly title?: string; readonly description?: string | null };
    }
  | {
      readonly op: "module.move";
      readonly moduleId: ModuleId;
      readonly position: number;
    }
  | { readonly op: "module.delete"; readonly moduleId: ModuleId }
  | {
      readonly op: "lesson.create";
      readonly moduleId: ModuleId;
      readonly lessonId?: LessonId;
      readonly title: string;
      readonly slug: string;
      readonly description?: string;
      readonly estimatedMinutes?: number;
      readonly position?: number;
    }
  | {
      readonly op: "lesson.update";
      readonly lessonId: LessonId;
      readonly patch: {
        readonly title?: string;
        readonly slug?: string;
        readonly description?: string | null;
        readonly status?: CourseLesson["status"];
        readonly estimatedMinutes?: number | null;
      };
    }
  | {
      readonly op: "lesson.move";
      readonly lessonId: LessonId;
      readonly moduleId: ModuleId;
      readonly position: number;
    }
  | { readonly op: "lesson.delete"; readonly lessonId: LessonId }
  | {
      readonly op: "block.insert";
      readonly lessonId: LessonId;
      readonly position: number;
      readonly blocks: readonly NewContentBlock[];
    }
  | {
      readonly op: "block.update";
      readonly lessonId: LessonId;
      readonly blockId: string;
      readonly block: NewContentBlock;
    }
  | {
      readonly op: "block.move";
      readonly lessonId: LessonId;
      readonly blockId: string;
      readonly position: number;
    }
  | {
      readonly op: "block.delete";
      readonly lessonId: LessonId;
      readonly blockIds: readonly string[];
    }
  | {
      readonly op: "block.replace";
      readonly lessonId: LessonId;
      readonly blocks: readonly NewContentBlock[];
    }
  | {
      readonly op: "diagram.approve";
      readonly lessonId: LessonId;
      readonly position: number;
      readonly candidate: DiagramCandidate;
      readonly altText: string;
      readonly caption: string;
      readonly layout?: "full" | "wide" | "inline";
    };

type WithoutBlockId<T> = T extends { readonly id: string } ? Omit<T, "id"> : never;
export type NewContentBlock = ContentBlock | WithoutBlockId<ContentBlock>;

export interface DiagramCandidate {
  readonly candidateId: string;
  readonly tenantId: TenantId;
  readonly assetId: AssetId;
  readonly suggestedAltText?: string;
  readonly suggestedCaption?: string;
}

export interface CourseAuthoringCommand {
  readonly courseId: CourseId;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly operations: readonly CourseAuthoringOperation[];
  readonly auditNote?: string;
}

export interface PublishCommand {
  readonly courseId: CourseId;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly auditNote: string;
}

export interface RollbackCommand {
  readonly courseId: CourseId;
  readonly expectedVersion: number;
  readonly targetVersion: number;
  readonly idempotencyKey: string;
  readonly auditNote: string;
}

export type RevisionKind = "created" | "edited" | "published" | "rolled_back";

export interface CourseRevision {
  readonly revisionId: string;
  readonly tenantId: TenantId;
  readonly courseId: CourseId;
  readonly version: number;
  readonly kind: RevisionKind;
  readonly commandId: string;
  readonly auditNote?: string;
  readonly actorId?: string;
  readonly createdAt: IsoTimestamp;
  readonly snapshot: CourseDraft;
  readonly rollbackTargetVersion?: number;
}

export interface CommandReceipt<TResult> {
  readonly tenantId: TenantId;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly result: TResult;
  readonly committedAt: IsoTimestamp;
}

export interface CommitCourseInput<TResult> {
  readonly tenantId: TenantId;
  readonly courseId: CourseId;
  readonly expectedVersion: number;
  readonly course: CourseDraft;
  readonly revision: CourseRevision;
  readonly receipt: CommandReceipt<TResult>;
}

export interface CourseAuthoringRepository {
  get(tenantId: TenantId, courseId: CourseId): Promise<CourseDraft | undefined>;
  create<TResult>(
    course: CourseDraft,
    revision: CourseRevision,
    receipt: CommandReceipt<TResult>,
  ): Promise<void>;
  commit<TResult>(input: CommitCourseInput<TResult>): Promise<void>;
  findReceipt<TResult>(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<CommandReceipt<TResult> | undefined>;
  listRevisions(tenantId: TenantId, courseId: CourseId): Promise<readonly CourseRevision[]>;
  getRevision(
    tenantId: TenantId,
    courseId: CourseId,
    version: number,
  ): Promise<CourseRevision | undefined>;
}

export interface AuthoringValidationResult {
  readonly valid: boolean;
  readonly issues: readonly CourseValidationIssue[];
}

export interface ImportedBlocks {
  readonly blocks: readonly ContentBlock[];
  readonly warnings: readonly string[];
}

export interface CourseAuthoringServiceApi {
  create(context: RequestContext, command: CreateCourseCommand): Promise<CourseDraft>;
  execute(
    context: RequestContext,
    command: CourseAuthoringCommand,
  ): Promise<ApplyCourseEditsResult>;
  publish(context: RequestContext, command: PublishCommand): Promise<CourseDraft>;
  rollback(context: RequestContext, command: RollbackCommand): Promise<CourseDraft>;
}

export type MutableCourse = {
  -readonly [K in keyof CourseDraft]: CourseDraft[K] extends readonly CourseModule[]
    ? CourseModule[]
    : CourseDraft[K];
};
