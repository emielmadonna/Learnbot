import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  getCurrentTenantContext,
} from "../../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../../lib/supabase/learning-route";
import {
  enforceVoiceQuota,
  meterVoiceUsage,
  resolveTenantVoice,
  voiceTraceId,
} from "../../../../../lib/voice-runtime";

const REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
const REALTIME_MODEL = "gpt-realtime-2.1";
const MAX_SDP_BYTES = 32 * 1024;
const REQUEST_DEADLINE_MS = 20_000;

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

function providerCredential() {
  const credential = process.env.OPENAI_API_KEY?.trim();
  return credential && credential.length >= 20 ? credential : null;
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
    if (!providerCredential()) {
      return jsonError(
        "voice_provider_not_configured",
        503,
        "Continuous voice is not configured.",
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
    const credential = providerCredential();
    if (!credential) {
      return jsonError(
        "voice_provider_not_configured",
        503,
        "Continuous voice is not configured.",
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
    // Durable, cross-instance quota. The previous per-process map reset on
    // every serverless cold start, so it bounded nothing in production.
    const quota = await enforceVoiceQuota(context.supabase, {
      kind: "realtime",
      tenantId: context.tenantId,
      principalId: context.principalId,
    });
    if (!quota.allowed) {
      return jsonError(quota.code, 429, quota.message);
    }
    const sdp = await request.text();
    if (!sdp.startsWith("v=0") || new TextEncoder().encode(sdp).byteLength > MAX_SDP_BYTES) {
      return jsonError("invalid_sdp", 400, "The WebRTC offer was invalid.");
    }

    // The tenant's configured voice, not a hardcoded one.
    const voiceProfile = await resolveTenantVoice(context.supabase);
    const session = {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions:
        "You are a calm learning voice. Automatic answers are disabled because the application grounds every turn in the tenant's published learning. When the application asks you to read a saved answer, speak that answer faithfully, without adding facts or changing its meaning.",
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: "en",
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "auto",
            create_response: false,
            interrupt_response: true,
          },
        },
        output: { voice: voiceProfile.voice },
      },
    };
    const form = new FormData();
    form.set("sdp", sdp);
    form.set("session", JSON.stringify(session));
    const safetyIdentifier = createHash("sha256")
      .update(`learningbot:${context.tenantId}:${context.principalId}`)
      .digest("hex");
    const providerResponse = await fetch(REALTIME_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "OpenAI-Safety-Identifier": safetyIdentifier,
      },
      body: form,
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    const answerSdp = await providerResponse.text();
    if (!providerResponse.ok || !answerSdp.startsWith("v=0")) {
      return jsonError(
        "realtime_provider_failed",
        502,
        "Continuous voice could not connect. Push-to-talk remains available.",
      );
    }
    // A realtime session is metered once, at connection, as an estimate: the
    // browser holds the socket, so the server never observes its true length.
    await meterVoiceUsage(context.supabase, {
      kind: "realtime",
      model: REALTIME_MODEL,
      quantity: 1,
      fallbackUnit: "realtime_sessions",
      traceId: voiceTraceId("realtime"),
      idempotencyKey: `voice-realtime:${crypto.randomUUID()}`,
    });

    return new NextResponse(answerSdp, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "application/sdp",
        "X-AI-Generated-Voice": "true",
        "X-Voice-Transport": "webrtc",
        "X-Voice-Name": voiceProfile.voice,
        "X-Voice-Profile": voiceProfile.source,
        "X-Voice-RateLimit-Scope": quota.scope,
      },
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
