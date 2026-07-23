import { NextResponse } from "next/server";

import { serializeDevelopmentError } from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";
import {
  getDevelopmentVoiceSessionCount,
  handoffDevelopmentVoiceSession,
  startDevelopmentVoiceSession,
} from "../../../../lib/voice-runtime";

type VoiceRequest =
  | { action: "start" }
  | {
      action: "handoff";
      sessionId: string;
      reason?: "user_requested" | "voice_unavailable" | "deadline";
    };

export async function GET(request: Request) {
  try {
    await requireDevSession(request, {
      principal: "student",
      permission: "conversation.read",
    });
    return NextResponse.json({
      capability: "voice.realtime",
      adapterBoundary: "@course-ai/realtime-voice",
      activeDevelopmentSessions: getDevelopmentVoiceSessionCount(),
      transport: "browser-speech-bridge",
      productionCredentialsPresent: false,
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as VoiceRequest;
    const session = await requireDevSession(request, {
      principal: "student",
      permission: "conversation.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    if (input.action === "start") {
      const result = await startDevelopmentVoiceSession(session.context);
      return NextResponse.json(result, { status: result.ok ? 201 : 503 });
    }
    if (
      !input.sessionId ||
      !input.sessionId.startsWith("voice_") ||
      input.sessionId.length > 128
    ) {
      return NextResponse.json(
        {
          code: "INVALID_VOICE_SESSION",
          message: "A valid voice session ID is required.",
        },
        { status: 400 },
      );
    }
    const result = await handoffDevelopmentVoiceSession(
      session.context,
      input.sessionId,
      input.reason ?? "user_requested",
    );
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
