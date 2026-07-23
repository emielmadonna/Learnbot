import { NextResponse } from "next/server";

import {
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      url?: string;
      title?: string;
      studentId?: string;
    };
    const session = await requireDevSession(request, {
      principal: "student",
      permission: "context.read",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(body));
    const context = session.context;
    const studentId = requireDevActorId(session);
    const resolved = await getDevelopmentRuntime().services.resolveLearningContext(
      context,
      {
        page: {
          url: body.url ?? "/",
          ...(body.title ? { title: body.title } : {}),
        },
        studentId,
      },
    );
    return NextResponse.json(resolved);
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
