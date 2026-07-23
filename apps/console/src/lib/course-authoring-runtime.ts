import type {
  ContentBlock,
  CourseDraft,
  CourseLesson,
  RequestContext,
  RichTextSpan,
} from "@course-ai/contracts";
import {
  AuthoringError,
  CourseAuthoringService,
  deterministicId,
  fingerprint,
  importMarkdown,
  importPlainText,
  InMemoryCourseAuthoringRepository,
  validateCourse,
  type CourseAuthoringOperation,
  type CourseRevision,
  type DiagramCandidate,
} from "@course-ai/course-authoring";

import {
  DEVELOPMENT_COURSE_ID,
  DEVELOPMENT_DOCUMENT_ID,
  DEVELOPMENT_TENANT_ID,
} from "./dev-runtime";

export const DEVELOPMENT_MODULE_ID = "module_rhythm";
export const DEVELOPMENT_LESSON_ID = "lesson_minimum_day";
export const INITIAL_MINIMUM_DAY_CONTENT =
  "A Minimum Day is the smallest credible version of your practice.\n\nOn a disrupted day, open your plan, choose one priority, and stop after two intentional minutes. This protects the restart loop without turning the minimum into the permanent target.\n\nAfter two consistent days, rebuild the fuller practice. Diagram: Disruption -> Minimum Day -> Evidence -> Momentum.";

const SEEDED_AT = "2026-07-23T20:00:00.000Z";

export interface DevelopmentAuthoringRuntime {
  readonly repository: InMemoryCourseAuthoringRepository;
  readonly service: CourseAuthoringService;
  readonly courseId: string;
  readonly moduleId: string;
  readonly lessonId: string;
  readonly diagramCandidate: DiagramCandidate;
}

function textFromSpans(spans: readonly RichTextSpan[]): string {
  return spans
    .map((span) => {
      let value = span.text;
      if (span.marks?.includes("bold")) value = `**${value}**`;
      if (span.marks?.includes("italic")) value = `_${value}_`;
      return span.href ? `[${value}](${span.href})` : value;
    })
    .join("");
}

export function blockToEditorText(block: ContentBlock): string {
  switch (block.type) {
    case "paragraph":
      return textFromSpans(block.content);
    case "heading":
      return `${"#".repeat(block.level)} ${textFromSpans(block.content)}`;
    case "list":
      return block.items
        .map((item, index) => {
          const marker = block.style === "numbered" ? `${index + 1}.` : "-";
          return `${marker} ${textFromSpans(item.content)}`;
        })
        .join("\n");
    case "quote":
      return `> ${textFromSpans(block.content)}${
        block.attribution ? ` — ${block.attribution}` : ""
      }`;
    case "callout":
      return `${block.title ? `${block.title}: ` : ""}${textFromSpans(block.content)}`;
    case "code":
      return `\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``;
    case "table":
      return [
        `| ${block.columns.join(" | ")} |`,
        `| ${block.columns.map(() => "---").join(" | ")} |`,
        ...block.rows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n");
    case "image":
      return `![${block.altText}](asset:${block.assetId})`;
    case "diagram":
      return `[Diagram: ${block.caption} — ${block.altText}]`;
    case "media":
      return `[${block.mediaKind}: ${block.title ?? block.assetId}]`;
    case "embed":
      return `[Embed: ${block.title ?? block.provider}](${block.url})`;
    case "divider":
      return "---";
  }
}

export function lessonToEditorText(lesson: CourseLesson): string {
  return lesson.blocks.map(blockToEditorText).join("\n\n");
}

function createSeedCourse(): CourseDraft {
  return {
    courseId: DEVELOPMENT_COURSE_ID,
    tenantId: DEVELOPMENT_TENANT_ID,
    title: "Momentum Method",
    slug: "momentum-method",
    description: "Build consistent progress with smaller restart loops.",
    status: "published",
    version: 12,
    modules: [
      {
        moduleId: DEVELOPMENT_MODULE_ID,
        title: "Build Your Rhythm",
        position: 0,
        lessons: [
          {
            lessonId: DEVELOPMENT_LESSON_ID,
            title: "Minimum Day",
            slug: "minimum-day",
            description: "Protect momentum when a full practice is impossible.",
            position: 0,
            status: "published",
            blocks: importPlainText(
              INITIAL_MINIMUM_DAY_CONTENT,
              "northstar:minimum-day:v12",
            ).blocks,
            sourceDocumentIds: [DEVELOPMENT_DOCUMENT_ID],
            estimatedMinutes: 10,
            updatedAt: SEEDED_AT,
          },
        ],
      },
    ],
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    publishedAt: SEEDED_AT,
  };
}

async function createRuntime(): Promise<DevelopmentAuthoringRuntime> {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository, {
    urlPolicy: {
      allowedLinkProtocols: ["https:", "mailto:"],
      allowedEmbedHosts: [
        "youtube.com",
        "youtu.be",
        "vimeo.com",
        "wistia.com",
        "loom.com",
      ],
      allowSubdomains: true,
    },
  });
  const course = createSeedCourse();
  const revision: CourseRevision = {
    revisionId: deterministicId(
      "revision",
      `${course.tenantId}:${course.courseId}`,
      course.version,
      "seed",
    ),
    tenantId: course.tenantId,
    courseId: course.courseId,
    version: course.version,
    kind: "published",
    commandId: "seed:northstar:v12",
    auditNote: "Seeded from the verified Northstar development course.",
    actorId: "system_seed",
    createdAt: SEEDED_AT,
    snapshot: course,
  };
  await repository.create(course, revision, {
    tenantId: course.tenantId,
    idempotencyKey: "seed:northstar:v12",
    fingerprint: fingerprint({ kind: "seed", course }),
    result: course,
    committedAt: SEEDED_AT,
  });
  return {
    repository,
    service,
    courseId: course.courseId,
    moduleId: DEVELOPMENT_MODULE_ID,
    lessonId: DEVELOPMENT_LESSON_ID,
    diagramCandidate: {
      candidateId: "diagram_candidate_minimum_day_flow",
      tenantId: DEVELOPMENT_TENANT_ID,
      assetId: "asset_diagram_minimum_day_flow",
      suggestedAltText:
        "A four-step flow from disruption through a minimum action and evidence to renewed momentum.",
      suggestedCaption: "The Minimum Day restart loop.",
    },
  };
}

const authoringGlobal = globalThis as typeof globalThis & {
  __learningBotCourseAuthoringRuntime?: Promise<DevelopmentAuthoringRuntime>;
};

export function getCourseAuthoringRuntime(): Promise<DevelopmentAuthoringRuntime> {
  authoringGlobal.__learningBotCourseAuthoringRuntime ??= createRuntime();
  return authoringGlobal.__learningBotCourseAuthoringRuntime;
}

export function findLesson(course: CourseDraft, lessonId?: string): CourseLesson {
  const requested = lessonId?.trim();
  for (const module of course.modules) {
    const lesson = module.lessons.find((item) => item.lessonId === requested);
    if (lesson) return lesson;
  }
  const fallback = course.modules[0]?.lessons[0];
  if (!fallback) {
    throw new AuthoringError(
      "authoring.not_found",
      "The course has no editable lesson.",
    );
  }
  return fallback;
}

export async function authoringSnapshot(
  context: RequestContext,
  requestedLessonId?: string,
) {
  const runtime = await getCourseAuthoringRuntime();
  const course = await runtime.service.getCourse(context, runtime.courseId);
  const lesson = findLesson(course, requestedLessonId);
  const revisions = await runtime.service.listRevisions(context, course.courseId);
  const approved = course.modules.some((module) =>
    module.lessons.some((item) =>
      item.blocks.some(
        (block) =>
          block.type === "diagram" &&
          block.metadata?.diagramCandidateId ===
            runtime.diagramCandidate.candidateId,
      ),
    ),
  );
  return {
    course,
    lesson,
    editorContent: lessonToEditorText(lesson),
    validation: validateCourse(course, "draft"),
    publishValidation: validateCourse(course, "publish"),
    revisions,
    diagramCandidate: { ...runtime.diagramCandidate, approved },
  };
}

function addMark(
  spans: readonly RichTextSpan[],
  mark: "bold" | "italic",
): readonly RichTextSpan[] {
  return spans.map((span) => ({
    ...span,
    marks: [...new Set([...(span.marks ?? []), mark])],
  }));
}

function formatBlock(
  block: ContentBlock,
  format: "bold" | "italic",
): ContentBlock | undefined {
  if (
    block.type === "paragraph" ||
    block.type === "heading" ||
    block.type === "quote" ||
    block.type === "callout"
  ) {
    return { ...block, content: addMark(block.content, format) };
  }
  if (block.type === "list") {
    return {
      ...block,
      items: block.items.map((item) => ({
        ...item,
        content: addMark(item.content, format),
      })),
    };
  }
  return undefined;
}

export async function applyLessonFormat(
  context: RequestContext,
  lessonId: string,
  expectedVersion: number,
  format: "bold" | "italic" | "heading" | "list",
  idempotencyKey: string,
) {
  const runtime = await getCourseAuthoringRuntime();
  const course = await runtime.service.getCourse(context, runtime.courseId);
  const lesson = findLesson(course, lessonId);
  let operations: readonly CourseAuthoringOperation[];

  if (format === "bold" || format === "italic") {
    operations = lesson.blocks.flatMap((block) => {
      const formatted = formatBlock(block, format);
      return formatted
        ? [
            {
              op: "block.update" as const,
              lessonId: lesson.lessonId,
              blockId: block.id,
              block: formatted,
            },
          ]
        : [];
    });
  } else if (format === "heading") {
    const first = lesson.blocks[0];
    if (!first) {
      throw new AuthoringError(
        "authoring.validation_failed",
        "Add lesson text before applying a heading.",
      );
    }
    operations = [
      {
        op: "block.update",
        lessonId: lesson.lessonId,
        blockId: first.id,
        block: {
          type: "heading",
          level: 2,
          content: [{ text: blockToEditorText(first).replace(/^#+\s*/u, "") }],
        },
      },
    ];
  } else {
    const items = lesson.blocks
      .map((block) => blockToEditorText(block).trim())
      .filter(Boolean)
      .map((text, index) => ({
        id: `item_${index + 1}`,
        content: [{ text }],
      }));
    if (items.length === 0) {
      throw new AuthoringError(
        "authoring.validation_failed",
        "Add lesson text before creating a list.",
      );
    }
    operations = [
      {
        op: "block.replace",
        lessonId: lesson.lessonId,
        blocks: [{ type: "list", style: "bullet", items }],
      },
    ];
  }

  if (operations.length === 0) {
    throw new AuthoringError(
      "authoring.validation_failed",
      "No rich-text blocks support that format.",
    );
  }
  await runtime.service.execute(context, {
    courseId: course.courseId,
    expectedVersion,
    idempotencyKey,
    operations,
    auditNote: `Applied ${format} formatting.`,
  });
  return authoringSnapshot(context, lesson.lessonId);
}

export async function importLessonContent(
  context: RequestContext,
  lessonId: string,
  expectedVersion: number,
  format: "plain_text" | "markdown",
  content: string,
  idempotencyKey: string,
) {
  const runtime = await getCourseAuthoringRuntime();
  const course = await runtime.service.getCourse(context, runtime.courseId);
  const lesson = findLesson(course, lessonId);
  const imported =
    format === "markdown"
      ? importMarkdown(content, `${course.courseId}:${lesson.lessonId}:${idempotencyKey}`)
      : importPlainText(content, `${course.courseId}:${lesson.lessonId}:${idempotencyKey}`);
  if (imported.blocks.length === 0) {
    throw new AuthoringError(
      "authoring.validation_failed",
      "No safe, importable lesson content was found.",
    );
  }
  await runtime.service.execute(context, {
    courseId: course.courseId,
    expectedVersion,
    idempotencyKey,
    operations: [
      {
        op: "block.replace",
        lessonId: lesson.lessonId,
        blocks: imported.blocks,
      },
    ],
    auditNote: `Imported ${format === "markdown" ? "Markdown" : "plain text"} content.`,
  });
  return {
    ...(await authoringSnapshot(context, lesson.lessonId)),
    importWarnings: imported.warnings,
  };
}
