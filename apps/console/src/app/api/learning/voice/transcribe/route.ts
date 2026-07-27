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
  enforceVoiceQuota,
  meterVoiceUsage,
  voiceTraceId,
} from "../../../../../lib/voice-runtime";

const OPENAI_TRANSCRIPTION_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const REQUEST_DEADLINE_MS = 45_000;

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

function providerCredential() {
  const credential = process.env.OPENAI_API_KEY?.trim();
  return credential && credential.length >= 20 ? credential : null;
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
    quotaSubject: `${context.tenantId}:${context.principalId}`,
    tenantId: context.tenantId,
    principalId: context.principalId,
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
    if (!providerCredential()) {
      return jsonError(
        "voice_provider_not_configured",
        503,
        "Voice is not configured for this environment.",
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
    const credential = providerCredential();
    if (!credential) {
      return jsonError(
        "voice_provider_not_configured",
        503,
        "Voice transcription is not configured.",
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

    // Durable, cross-instance quota. The previous per-process map reset on
    // every serverless cold start, so it bounded nothing in production.
    const quota = await enforceVoiceQuota(context.supabase, {
      kind: "transcribe",
      tenantId: context.tenantId,
      principalId: context.principalId,
    });
    if (!quota.allowed) {
      return jsonError(
        quota.code,
        429,
        quota.message,
        quota.retryAfterSeconds > 0,
        {
          "Retry-After": String(Math.max(1, quota.retryAfterSeconds)),
          "X-Voice-RateLimit-Scope": quota.scope,
        },
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

    const body = new FormData();
    body.set(
      "file",
      new File([audio], `voice-turn.${mediaType.extension}`, {
        type: mediaType.providerType,
      }),
    );
    body.set("model", TRANSCRIPTION_MODEL);
    body.set("response_format", "json");

    const providerResponse = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
      body,
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    if (!providerResponse.ok) {
      return jsonError(
        "transcription_failed",
        502,
        "The voice turn could not be transcribed. Try again or continue in text.",
        providerResponse.status === 408 || providerResponse.status === 429,
      );
    }

    const result = (await providerResponse.json()) as unknown;
    const transcript =
      result &&
      typeof result === "object" &&
      "text" in result &&
      typeof result.text === "string"
        ? result.text.trim()
        : "";
    if (!transcript || transcript.length > 8_000) {
      return jsonError(
        "transcription_empty",
        422,
        "I did not catch that. Please try the voice turn again.",
      );
    }

    // Transcription is billed by audio duration, which the client declared and
    // the policy bounded. Metering is best effort and never throws.
    await meterVoiceUsage(context.supabase, {
      kind: "transcribe",
      model: TRANSCRIPTION_MODEL,
      quantity: durationMs / 1_000,
      fallbackUnit: "audio_seconds",
      traceId: voiceTraceId("transcribe"),
      idempotencyKey: `voice-transcribe:${crypto.randomUUID()}`,
    });

    return NextResponse.json(
      {
        ok: true,
        transcript,
        model: TRANSCRIPTION_MODEL,
        rawAudioStored: false,
        durationPolicyMs: MAX_VOICE_TURN_MS,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Voice-RateLimit-Scope": quota.scope,
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
