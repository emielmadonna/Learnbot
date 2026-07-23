import { AuthoringError } from "@course-ai/course-authoring";
import { NextResponse } from "next/server";

import {
  applyLessonFormat,
  authoringSnapshot,
  findLesson,
  getCourseAuthoringRuntime,
  importLessonContent,
} from "../../../../lib/course-authoring-runtime";
import {
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";

type AuthoringMutation =
  | {
      action: "import";
      lessonId: string;
      expectedVersion: number;
      format: "plain_text" | "markdown";
      content: string;
      idempotencyKey?: string;
    }
  | {
      action: "format";
      lessonId: string;
      expectedVersion: number;
      format: "bold" | "italic" | "heading" | "list";
      idempotencyKey?: string;
    }
  | {
      action: "add_lesson";
      expectedVersion: number;
      title: string;
      idempotencyKey?: string;
    }
  | {
      action: "add_embed";
      lessonId: string;
      expectedVersion: number;
      url: string;
      idempotencyKey?: string;
    }
  | {
      action: "approve_diagram";
      lessonId: string;
      expectedVersion: number;
      altText: string;
      caption: string;
      idempotencyKey?: string;
    }
  | {
      action: "publish";
      expectedVersion: number;
      auditNote: string;
      idempotencyKey?: string;
    }
  | {
      action: "rollback";
      expectedVersion: number;
      targetVersion: number;
      auditNote: string;
      idempotencyKey?: string;
    };

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function errorResponse(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : undefined;
  if (
    error instanceof AuthoringError ||
    (typeof code === "string" && code.startsWith("authoring."))
  ) {
    const authoringCode =
      typeof code === "string" ? code : "authoring.invalid_input";
    const status =
      authoringCode === "authoring.not_found"
        ? 404
        : authoringCode === "authoring.version_conflict" ||
            authoringCode === "authoring.idempotency_conflict"
          ? 409
          : authoringCode === "authoring.unauthorized" ||
              authoringCode === "authoring.tenant_mismatch"
            ? 403
            : 422;
    const message =
      error instanceof Error ? error.message : "Authoring command failed.";
    const safeDetails =
      typeof error === "object" && error !== null && "safeDetails" in error
        ? Reflect.get(error, "safeDetails")
        : {};
    return NextResponse.json(
      {
        error: error instanceof Error ? error.name : "AuthoringError",
        code: authoringCode,
        message,
        safeDetails,
      },
      { status },
    );
  }
  return NextResponse.json(serializeDevelopmentError(error), {
    status: developmentApiErrorStatus(error),
  });
}

export async function GET(request: Request) {
  try {
    const { context } = await requireDevSession(request, {
      principal: "creator",
      permission: "course.read",
    });
    const lessonId =
      new URL(request.url).searchParams.get("lessonId") ?? undefined;
    return NextResponse.json(await authoringSnapshot(context, lessonId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as AuthoringMutation;
    const session = await requireDevSession(request, {
      principal: "creator",
      permission: "course.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const context = session.context;
    const runtime = await getCourseAuthoringRuntime();
    const key = input.idempotencyKey?.trim() || crypto.randomUUID();

    if (input.action === "import") {
      return NextResponse.json(
        await importLessonContent(
          context,
          input.lessonId,
          input.expectedVersion,
          input.format,
          input.content,
          key,
        ),
      );
    }

    if (input.action === "format") {
      return NextResponse.json(
        await applyLessonFormat(
          context,
          input.lessonId,
          input.expectedVersion,
          input.format,
          key,
        ),
      );
    }

    if (input.action === "add_lesson") {
      const course = await runtime.service.getCourse(context, runtime.courseId);
      const title = input.title.trim();
      if (!title) {
        throw new AuthoringError(
          "authoring.validation_failed",
          "Name the lesson before adding it.",
        );
      }
      const result = await runtime.service.execute(context, {
        courseId: course.courseId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: key,
        operations: [
          {
            op: "lesson.create",
            moduleId: runtime.moduleId,
            title,
            slug: `${slugify(title)}-${course.version + 1}`,
          },
        ],
        auditNote: "Added a lesson from the creator workspace.",
      });
      const lesson = result.course.modules
        .flatMap((module) => module.lessons)
        .at(-1);
      return NextResponse.json(
        await authoringSnapshot(context, lesson?.lessonId),
        { status: 201 },
      );
    }

    if (input.action === "add_embed") {
      const course = await runtime.service.getCourse(context, runtime.courseId);
      const lesson = findLesson(course, input.lessonId);
      await runtime.service.execute(context, {
        courseId: course.courseId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: key,
        operations: [
          {
            op: "block.insert",
            lessonId: lesson.lessonId,
            position: lesson.blocks.length,
            blocks: [
              {
                type: "embed",
                provider: "external",
                url: input.url,
                title: "Course resource",
              },
            ],
          },
        ],
        auditNote: "Added a reviewed external lesson embed.",
      });
      return NextResponse.json(
        await authoringSnapshot(context, lesson.lessonId),
      );
    }

    if (input.action === "approve_diagram") {
      const course = await runtime.service.getCourse(context, runtime.courseId);
      const lesson = findLesson(course, input.lessonId);
      if (
        lesson.blocks.some(
          (block) =>
            block.type === "diagram" &&
            block.metadata?.diagramCandidateId ===
              runtime.diagramCandidate.candidateId,
        )
      ) {
        throw new AuthoringError(
          "authoring.idempotency_conflict",
          "This diagram candidate is already approved.",
        );
      }
      await runtime.service.execute(context, {
        courseId: course.courseId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: key,
        operations: [
          {
            op: "diagram.approve",
            lessonId: lesson.lessonId,
            position: lesson.blocks.length,
            candidate: runtime.diagramCandidate,
            altText: input.altText,
            caption: input.caption,
          },
        ],
        auditNote: "Approved the Minimum Day diagram with accessible text.",
      });
      return NextResponse.json(
        await authoringSnapshot(context, lesson.lessonId),
      );
    }

    if (input.action === "publish") {
      await runtime.service.publish(context, {
        courseId: runtime.courseId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: key,
        auditNote: input.auditNote,
      });
      return NextResponse.json(await authoringSnapshot(context));
    }

    if (input.action === "rollback") {
      await runtime.service.rollback(context, {
        courseId: runtime.courseId,
        expectedVersion: input.expectedVersion,
        targetVersion: input.targetVersion,
        idempotencyKey: key,
        auditNote: input.auditNote,
      });
      return NextResponse.json(await authoringSnapshot(context));
    }

    throw new AuthoringError(
      "authoring.invalid_input",
      "Unsupported authoring action.",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
