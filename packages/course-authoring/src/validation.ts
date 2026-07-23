import type {
  ContentBlock,
  CourseDraft,
  CourseValidationIssue,
} from "@course-ai/contracts";
import type { AuthoringValidationResult } from "./types.js";

function issue(
  code: string,
  severity: "error" | "warning",
  message: string,
  locations: Partial<Pick<CourseValidationIssue, "moduleId" | "lessonId" | "blockId">> = {},
): CourseValidationIssue {
  return { code, severity, message, ...locations };
}

function validateBlock(
  block: ContentBlock,
  lessonId: string,
): readonly CourseValidationIssue[] {
  const location = { lessonId, blockId: block.id };
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
    case "callout":
      return block.content.some((span) => span.text.trim().length > 0)
        ? []
        : [issue("block.empty", "warning", "Text block is empty.", location)];
    case "list":
      return block.items.length > 0
        ? []
        : [issue("list.empty", "warning", "List has no items.", location)];
    case "code":
      return block.code.trim().length > 0
        ? []
        : [issue("code.empty", "warning", "Code block is empty.", location)];
    case "table": {
      const issues: CourseValidationIssue[] = [];
      if (block.columns.length === 0) {
        issues.push(issue("table.no_columns", "error", "Table needs at least one column.", location));
      }
      if (block.rows.some((row) => row.length !== block.columns.length)) {
        issues.push(
          issue(
            "table.row_width",
            "error",
            "Every table row must match the column count.",
            location,
          ),
        );
      }
      return issues;
    }
    case "image":
      return block.altText.trim().length > 0
        ? []
        : [issue("image.alt_text_required", "error", "Image alt text is required.", location)];
    case "diagram": {
      const issues: CourseValidationIssue[] = [];
      if (block.altText.trim().length < 5) {
        issues.push(
          issue(
            "diagram.alt_text_required",
            "error",
            "Diagram alt text must meaningfully describe the visual.",
            location,
          ),
        );
      }
      if (block.caption.trim().length === 0) {
        issues.push(
          issue("diagram.caption_required", "error", "Diagram caption is required.", location),
        );
      }
      if (
        block.metadata?.approvalStatus !== "approved" ||
        typeof block.metadata.diagramCandidateId !== "string"
      ) {
        issues.push(
          issue(
            "diagram.approval_required",
            "error",
            "Diagram candidates require explicit approval before publishing.",
            location,
          ),
        );
      }
      return issues;
    }
    case "media":
      return block.title?.trim()
        ? []
        : [issue("media.title_recommended", "warning", "Media title is recommended.", location)];
    case "embed":
      return block.provider.trim().length > 0
        ? []
        : [issue("embed.provider_required", "error", "Embed provider is required.", location)];
    case "divider":
      return [];
  }
}

export function validateCourse(
  course: CourseDraft,
  mode: "draft" | "publish" = "draft",
): AuthoringValidationResult {
  const issues: CourseValidationIssue[] = [];
  if (course.title.trim().length === 0) {
    issues.push(issue("course.title_required", "error", "Course title is required."));
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(course.slug)) {
    issues.push(
      issue("course.slug_invalid", "error", "Course slug must use lowercase kebab-case."),
    );
  }
  if (course.modules.length === 0) {
    issues.push(
      issue(
        "course.modules_required",
        mode === "publish" ? "error" : "warning",
        "Course has no modules.",
      ),
    );
  }

  const moduleIds = new Set<string>();
  const lessonIds = new Set<string>();
  const lessonSlugs = new Set<string>();
  const blockIds = new Set<string>();
  course.modules.forEach((module, moduleIndex) => {
    if (moduleIds.has(module.moduleId)) {
      issues.push(
        issue("module.id_duplicate", "error", "Module id is duplicated.", {
          moduleId: module.moduleId,
        }),
      );
    }
    moduleIds.add(module.moduleId);
    if (module.position !== moduleIndex) {
      issues.push(
        issue("module.position_invalid", "error", "Module positions must be contiguous.", {
          moduleId: module.moduleId,
        }),
      );
    }
    if (module.title.trim().length === 0) {
      issues.push(
        issue("module.title_required", "error", "Module title is required.", {
          moduleId: module.moduleId,
        }),
      );
    }
    if (module.lessons.length === 0) {
      issues.push(
        issue(
          "module.lessons_required",
          mode === "publish" ? "error" : "warning",
          "Module has no lessons.",
          { moduleId: module.moduleId },
        ),
      );
    }

    module.lessons.forEach((lesson, lessonIndex) => {
      const location = { moduleId: module.moduleId, lessonId: lesson.lessonId };
      if (lessonIds.has(lesson.lessonId)) {
        issues.push(issue("lesson.id_duplicate", "error", "Lesson id is duplicated.", location));
      }
      lessonIds.add(lesson.lessonId);
      if (lessonSlugs.has(lesson.slug)) {
        issues.push(
          issue("lesson.slug_duplicate", "error", "Lesson slug must be unique.", location),
        );
      }
      lessonSlugs.add(lesson.slug);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(lesson.slug)) {
        issues.push(issue("lesson.slug_invalid", "error", "Lesson slug is invalid.", location));
      }
      if (lesson.position !== lessonIndex) {
        issues.push(
          issue("lesson.position_invalid", "error", "Lesson positions must be contiguous.", location),
        );
      }
      if (lesson.title.trim().length === 0) {
        issues.push(issue("lesson.title_required", "error", "Lesson title is required.", location));
      }
      if (
        lesson.estimatedMinutes !== undefined &&
        (!Number.isFinite(lesson.estimatedMinutes) || lesson.estimatedMinutes <= 0)
      ) {
        issues.push(
          issue(
            "lesson.estimated_minutes_invalid",
            "error",
            "Estimated minutes must be greater than zero.",
            location,
          ),
        );
      }
      if (lesson.blocks.length === 0) {
        issues.push(
          issue(
            "lesson.blocks_required",
            mode === "publish" ? "error" : "warning",
            "Lesson has no content blocks.",
            location,
          ),
        );
      }
      for (const block of lesson.blocks) {
        if (blockIds.has(block.id)) {
          issues.push(
            issue("block.id_duplicate", "error", "Block ids must be unique in a course.", {
              ...location,
              blockId: block.id,
            }),
          );
        }
        blockIds.add(block.id);
        issues.push(...validateBlock(block, lesson.lessonId));
      }
    });
  });

  return {
    valid: !issues.some((candidate) => candidate.severity === "error"),
    issues,
  };
}
