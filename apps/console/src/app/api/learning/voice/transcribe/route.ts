import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../../lib/supabase/learning-route";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const OPENAI_TRANSCRIPTION_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const REQUEST_DEADLINE_MS = 45_000;

function jsonError(
  code: string,
  status: number,
  message: string,
  retryable = false,
) {
  return NextResponse.json(
    { ok: false, code, message, retryable },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function providerCredential() {
  const credential = process.env.OPENAI_API_KEY?.trim();
  return credential && credential.length >= 20 ? credential : null;
}

export async function POST(request: Request) {
  try {
    await authenticatedLearningClient(request, { mutation: true });
    const credential = providerCredential();
    if (!credential) {
      return jsonError(
        "voice_provider_not_configured",
        503,
        "Voice transcription is not configured.",
      );
    }

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES + 64_000) {
      return jsonError(
        "audio_too_large",
        413,
        "Keep each voice turn under 45 seconds.",
      );
    }

    const input = await request.formData();
    const audio = input.get("audio");
    if (
      !(audio instanceof File) ||
      audio.size < 64 ||
      audio.size > MAX_AUDIO_BYTES ||
      !["audio/webm", "video/webm"].includes(
        audio.type.toLowerCase().split(";")[0] ?? "",
      )
    ) {
      return jsonError(
        "invalid_audio",
        400,
        "A bounded WebM microphone recording is required.",
      );
    }

    const body = new FormData();
    body.set(
      "file",
      new File([audio], "voice-turn.webm", { type: "audio/webm" }),
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

    return NextResponse.json(
      {
        ok: true,
        transcript,
        model: TRANSCRIPTION_MODEL,
        rawAudioStored: false,
      },
      { headers: { "Cache-Control": "no-store" } },
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
