import { NextResponse } from "next/server";

import {
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";

type CourseMutation =
  | {
      action: "create";
      title: string;
      slug?: string;
      description?: string;
      idempotencyKey?: string;
    }
  | {
      action: "update";
      courseId: string;
      expectedVersion: number;
      title?: string;
      slug?: string;
      description?: string | null;
      idempotencyKey?: string;
    }
  | {
      action: "publish";
      courseId: string;
      expectedVersion: number;
      auditNote: string;
      idempotencyKey?: string;
    };

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function GET(request: Request) {
  try {
    const { context } = await requireDevSession(request, {
      principal: "creator",
      permission: "course.read",
    });
    const services = getDevelopmentRuntime().services;
    const courseId = new URL(request.url).searchParams.get("courseId");
    if (courseId) {
      return NextResponse.json({
        course: await services.getCourse(context, courseId),
      });
    }
    return NextResponse.json({ courses: await services.listCourses(context) });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as CourseMutation;
    const session = await requireDevSession(request, {
      principal: "creator",
      permission: "course.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const context = session.context;
    const services = getDevelopmentRuntime().services;
    const key = input.idempotencyKey ?? crypto.randomUUID();

    if (input.action === "create") {
      const course = await services.createCourse(
        context,
        {
          title: input.title,
          slug: input.slug?.trim() || slugify(input.title),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
        },
        key,
      );
      return NextResponse.json({ course }, { status: 201 });
    }

    if (input.action === "update") {
      const course = await services.updateCourseMetadata(
        context,
        input.courseId,
        input.expectedVersion,
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
        },
        key,
      );
      return NextResponse.json({ course });
    }

    const course = await services.publishCourse(
      context,
      input.courseId,
      input.expectedVersion,
      input.auditNote,
      key,
    );
    return NextResponse.json({ course });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
