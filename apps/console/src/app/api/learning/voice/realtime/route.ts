import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  getCurrentTenantContext,
} from "../../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../../lib/supabase/learning-route";
import {
  resolveTenantVoice,
} from "../../../../../lib/voice-runtime";
import {
  forwardManagedVoiceFailure,
  invokeManagedVoice,
  managedVoiceHeaders,
} from "../../../../../lib/supabase/managed-voice";

const REALTIME_MODEL = "gpt-realtime-2.1";
const MAX_SDP_BYTES = 32 * 1024;

function jsonError(code: string, status: number, message: string) {
  return NextResponse.json(
    { ok: false, code, message },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

async function realtimeContext(request: Request, mutation: boolean) {
  const supabase = await authenticatedLearningClient(request, { mutation });
  const context = await getCurrentTenantContext(supabase);
  if (
    !context.selected ||
    !context.tenantId ||
    !context.membershipId ||
    !context.principalId
  ) {
    return null;
  }
  return {
    supabase,
    tenantId: context.tenantId,
    principalId: context.principalId,
  };
}

export async function GET(request: Request) {
  try {
    const context = await realtimeContext(request, false);
    if (!context) {
      return jsonError(
        "tenant_selection_required",
        409,
        "Select a workspace before using voice.",
      );
    }
    const readiness = await invokeManagedVoice(
      request,
      context.supabase,
      JSON.stringify({
        action: "readiness",
        tenantId: context.tenantId,
      }),
      "application/json",
    );
    if (!readiness.ok) {
      return forwardManagedVoiceFailure(
        readiness,
        "Continuous voice readiness could not be verified.",
      );
    }
    // The readiness read reports the voice the learner will actually hear, so a
    // misconfigured tenant voice is visible before a session is opened.
    const voiceProfile = await resolveTenantVoice(context.supabase);
    return NextResponse.json(
      {
        ok: true,
        configured: true,
        transport: "webrtc",
        model: REALTIME_MODEL,
        rawAudioStored: false,
        turnDetection: "semantic_vad",
        voice: voiceProfile.voice,
        voiceSource: voiceProfile.source,
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-AI-Generated-Voice": "true",
        },
      },
    );
  } catch (error) {
    return jsonError(
      error instanceof AuthenticationBoundaryError
        ? "authentication_required"
        : "request_denied",
      error instanceof AuthenticationBoundaryError ? 401 : 400,
      "Continuous voice readiness could not be verified.",
    );
  }
}

export async function POST(request: Request) {
  try {
    const context = await realtimeContext(request, true);
    if (!context) {
      return jsonError(
        "tenant_selection_required",
        409,
        "Select a workspace before using voice.",
      );
    }
    const contentType = request.headers.get("content-type")?.toLowerCase();
    const declaredLength = request.headers.get("content-length");
    const contentLength = declaredLength === null ? null : Number(declaredLength);
    if (
      contentType !== "application/sdp" ||
      (contentLength !== null &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength < 1 ||
          contentLength > MAX_SDP_BYTES))
    ) {
      return jsonError(
        "invalid_sdp",
        400,
        "A bounded WebRTC session description is required.",
      );
    }
    const sdp = await request.text();
    if (!sdp.startsWith("v=0") || new TextEncoder().encode(sdp).byteLength > MAX_SDP_BYTES) {
      return jsonError("invalid_sdp", 400, "The WebRTC offer was invalid.");
    }

    // The tenant's configured voice, not a hardcoded one.
    const voiceProfile = await resolveTenantVoice(context.supabase);
    const managedResponse = await invokeManagedVoice(
      request,
      context.supabase,
      JSON.stringify({
        action: "realtime",
        tenantId: context.tenantId,
        sdp,
        voice: voiceProfile.voice,
      }),
      "application/json",
    );
    if (!managedResponse.ok) {
      return forwardManagedVoiceFailure(
        managedResponse,
        "Continuous voice could not connect. Push-to-talk remains available.",
      );
    }
    return new NextResponse(managedResponse.body, {
      status: 200,
      headers: managedVoiceHeaders(managedResponse, {
        "Content-Type": "application/sdp",
        "X-AI-Generated-Voice": "true",
        "X-Voice-Transport": "webrtc",
        "X-Voice-Name": voiceProfile.voice,
        "X-Voice-Profile": voiceProfile.source,
      }),
    });
  } catch (error) {
    if (error instanceof AuthenticationBoundaryError) {
      return jsonError(
        "authentication_required",
        401,
        "Your session has expired.",
      );
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return jsonError(
        "realtime_timeout",
        504,
        "Continuous voice timed out while connecting.",
      );
    }
    return jsonError(
      "request_denied",
      400,
      "Continuous voice could not be requested.",
    );
  }
}
