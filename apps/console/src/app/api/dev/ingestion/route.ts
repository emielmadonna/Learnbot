import { NextResponse } from "next/server";

import {
  DEVELOPMENT_COURSE_ID,
  DEVELOPMENT_DOCUMENT_ID,
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevSession,
  tenantClaimFromBody,
  type DevelopmentSession,
} from "../../../../lib/dev-session-guard";

type IngestionRequest =
  | {
      action: "start";
      title?: string;
      body: string;
      idempotencyKey?: string;
    }
  | {
      action: "reprocess";
      body: string;
      idempotencyKey?: string;
    }
  | {
      action: "publish";
      draftVersionId: string;
      expectedActiveVersionId?: string;
    }
  | {
      action: "rollback";
      targetVersionId: string;
      expectedActiveVersionId: string;
    };

function snapshot(session: DevelopmentSession) {
  const runtime = getDevelopmentRuntime();
  const scope = { tenantId: session.context.tenantId };
  return {
    active: runtime.pipeline.getActiveVersion(scope),
    versions: runtime.pipeline.listVersions(scope),
    initialJob: runtime.pipeline.getOperationState(scope, runtime.initialJobId),
  };
}

export async function GET(request: Request) {
  try {
    const session = await requireDevSession(request, {
      principal: "creator",
      permission: "job.read",
    });
    return NextResponse.json(snapshot(session));
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as IngestionRequest;
    const session = await requireDevSession(request, {
      principal: "creator",
      permission: "job.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const runtime = getDevelopmentRuntime();
    const scope = { tenantId: session.context.tenantId };
    const context = session.context;
    const key =
      "idempotencyKey" in input && input.idempotencyKey
        ? input.idempotencyKey
        : crypto.randomUUID();

    if (input.action === "start") {
      const source = await runtime.services.createLearningSource(
        context,
        {
          type: "upload",
          name: input.title ?? "Uploaded learning",
          configuration: {
            mediaType: "text/plain",
          },
        },
        `${key}:source`,
      );
      const job = runtime.pipeline.start(
        scope,
        {
          tenantId: context.tenantId,
          sourceId: source.sourceId,
          documentId: `document_${key.replace(/[^a-z0-9]/giu, "").slice(-16)}`,
          title: input.title ?? "Uploaded learning",
          mediaType: "text/plain",
          contentHash: `sha256:${key}`,
          body: input.body,
          courseId: DEVELOPMENT_COURSE_ID,
        },
        `${key}:pipeline`,
      );
      return NextResponse.json({ action: input.action, job, ...snapshot(session) });
    }

    if (input.action === "reprocess") {
      const result = runtime.pipeline.selectiveReprocess(
        scope,
        {
          kind: "edit_document",
          documentIds: [DEVELOPMENT_DOCUMENT_ID],
          replacementBody: input.body,
        },
        `${key}:reprocess`,
      );
      return NextResponse.json({ action: input.action, result, ...snapshot(session) });
    }

    if (input.action === "publish") {
      const published = runtime.pipeline.publish(
        scope,
        input.draftVersionId,
        input.expectedActiveVersionId,
      );
      return NextResponse.json({
        action: input.action,
        published,
        ...snapshot(session),
      });
    }

    const rolledBack = runtime.pipeline.rollback(
      scope,
      input.targetVersionId,
      input.expectedActiveVersionId,
    );
    return NextResponse.json({
      action: input.action,
      rolledBack,
      ...snapshot(session),
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
