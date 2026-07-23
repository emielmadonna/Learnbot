import { NextResponse } from "next/server";

import { serializeDevelopmentError } from "../../../../lib/dev-runtime";
import {
  developmentApiErrorStatus,
  requireDevSession,
  safeDevelopmentSessionMetadata,
} from "../../../../lib/dev-session-guard";

export async function GET(request: Request) {
  try {
    const session = await requireDevSession(request, {
      principal: "owner",
      permission: "tenant.read",
    });
    return NextResponse.json(safeDevelopmentSessionMetadata(session));
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
