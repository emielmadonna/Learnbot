import { serializeDevelopmentError } from "../../../../lib/dev-runtime";
import {
  developmentApiErrorStatus,
  requireDevSession,
} from "../../../../lib/dev-session-guard";
import { fixturePreviewEnabled } from "../../../../lib/deployment-mode";

export async function GET(request: Request) {
  try {
    await requireDevSession(request, {
      principal: "student",
      permission: "tenant.read",
    });
    return Response.json({
      service: "course-ai-console",
      status: "healthy",
      mode: fixturePreviewEnabled() ? "fixture-preview" : "development",
    });
  } catch (error) {
    return Response.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
