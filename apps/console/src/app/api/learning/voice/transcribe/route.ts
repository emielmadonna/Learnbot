import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  getCurrentTenantContext,
} from "../../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../../lib/supabase/learning-route";
import {
  acceptedAudioType,
  acceptedBrowserAudioTypes,
  MAX_AUDIO_BYTES,
  MAX_VOICE_TURN_MS,
  multipartHeaderError,
  validDeclaredDuration,
} from "../policy";
import {
  forwardManagedVoiceFailure,
  invokeManagedVoice,
  managedVoiceHeaders,
} from "../../../../../lib/supabase/managed-voice";

function jsonError(
  code: string,
  status: number,
  message: string,
  retryable = false,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    { ok: false, code, message, retryable },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

async function voiceTenantContext(request: Request, mutation: boolean) {
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
  };
}

export async function GET(request: Request) {
  try {
    const context = await voiceTenantContext(request, false);
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
        "Voice readiness could not be verified.",
      );
    }
    return NextResponse.json(
      {
        ok: true,
        configured: true,
        maxDurationMs: MAX_VOICE_TURN_MS,
        acceptedAudioTypes: acceptedBrowserAudioTypes(),
        rateLimitScope: "durable-tenant",
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Voice-RateLimit-Scope": "durable-tenant",
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthenticationBoundaryError) {
      return jsonError(
        "authentication_required",
        401,
        "Your session has expired.",
      );
    }
    return jsonError(
      "request_denied",
      400,
      "Voice readiness could not be verified.",
    );
  }
}

export async function POST(request: Request) {
  try {
    const context = await voiceTenantContext(request, true);
    if (!context) {
      return jsonError(
        "tenant_selection_required",
        409,
        "Select a workspace before using voice.",
      );
    }
    const headerError = multipartHeaderError(request.headers);
    if (headerError === "invalid_content_type") {
      return jsonError(
        headerError,
        415,
        "A multipart microphone recording is required.",
      );
    }
    if (headerError === "length_required") {
      return jsonError(
        headerError,
        411,
        "A bounded Content-Length is required for voice turns.",
      );
    }
    if (headerError === "audio_too_large") {
      return jsonError(
        "audio_too_large",
        413,
        "Voice turns are limited to 45 seconds and 10 MB.",
      );
    }

    const input = await request.formData();
    const audio = input.get("audio");
    const durationMs = validDeclaredDuration(input.get("durationMs"));
    const mediaType =
      audio instanceof File ? acceptedAudioType(audio.type) : null;
    if (
      !(audio instanceof File) ||
      audio.size < 64 ||
      audio.size > MAX_AUDIO_BYTES ||
      !mediaType ||
      durationMs === null
    ) {
      return jsonError(
        "invalid_audio",
        400,
        "A supported microphone recording of 45 seconds or less is required.",
      );
    }

    const managedBody = new FormData();
    managedBody.set(
      "audio",
      new File([audio], `voice-turn.${mediaType.extension}`, {
        type: mediaType.providerType,
      }),
    );
    managedBody.set("durationMs", String(durationMs));
    const managedResponse = await invokeManagedVoice(
      request,
      context.supabase,
      managedBody,
      undefined,
      { "x-learningbot-tenant-id": context.tenantId },
    );
    if (!managedResponse.ok) {
      return forwardManagedVoiceFailure(
        managedResponse,
        "The voice turn could not be transcribed.",
      );
    }
    return new NextResponse(managedResponse.body, {
      status: 200,
      headers: managedVoiceHeaders(managedResponse, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
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
        "transcription_timeout",
        504,
        "Voice transcription timed out. Try again or continue in text.",
        true,
      );
    }
    return jsonError(
      "request_denied",
      400,
      "The voice turn could not be accepted.",
    );
  }
}
