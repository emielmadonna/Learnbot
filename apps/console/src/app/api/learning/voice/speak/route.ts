import { NextResponse } from "next/server";
import { AuthenticationBoundaryError } from "../../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../../lib/supabase/learning-route";

type JsonRecord = Record<string, unknown>;

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const SPEECH_MODEL = "gpt-4o-mini-tts";
const SPEECH_VOICE = "marin";
const MAX_SPEECH_CHARACTERS = 4_096;
const REQUEST_DEADLINE_MS = 45_000;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validUuid(value: unknown) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

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

function findAssistantMessage(
  payload: unknown,
  messageId: string,
): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.conversations)) return null;
  const conversation = payload.conversations.find(isRecord);
  if (!conversation || !Array.isArray(conversation.messages)) return null;
  for (const candidate of conversation.messages) {
    if (
      isRecord(candidate) &&
      candidate.messageId === messageId &&
      candidate.actorType === "assistant" &&
      typeof candidate.body === "string"
    ) {
      return candidate.body.trim();
    }
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const credential = process.env.OPENAI_API_KEY?.trim();
    if (!credential || credential.length < 20) {
      return jsonError(
        "voice_provider_not_configured",
        503,
        "Synthetic speech is not configured.",
      );
    }

    const input = (await request.json()) as unknown;
    if (
      !isRecord(input) ||
      !validUuid(input.conversationId) ||
      !validUuid(input.messageId)
    ) {
      return jsonError(
        "invalid_request",
        400,
        "A saved assistant answer is required.",
      );
    }

    const conversationId = input.conversationId as string;
    const messageId = input.messageId as string;
    const transcript = await executeLearningRpc(
      supabase,
      "learning_get_conversations",
      { target_conversation_id: conversationId },
    );
    const answer = findAssistantMessage(transcript, messageId);
    if (!answer) {
      return jsonError(
        "answer_not_found",
        404,
        "The assistant answer is not available in this conversation.",
      );
    }
    if (answer.length > MAX_SPEECH_CHARACTERS) {
      return jsonError(
        "answer_too_long",
        422,
        "This answer is too long to read aloud. Continue with it in text.",
      );
    }

    const providerResponse = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SPEECH_MODEL,
        voice: SPEECH_VOICE,
        input: answer,
        response_format: "mp3",
        instructions:
          "Speak as a calm, warm learning companion. Read the supplied answer faithfully without adding words.",
      }),
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    if (!providerResponse.ok || !providerResponse.body) {
      return jsonError(
        "speech_failed",
        502,
        "The answer is saved, but its audio could not be generated.",
        providerResponse.status === 408 || providerResponse.status === 429,
      );
    }

    return new NextResponse(providerResponse.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'inline; filename="assistant-answer.mp3"',
        "X-AI-Generated-Voice": "true",
        "X-Content-Type-Options": "nosniff",
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
        "speech_timeout",
        504,
        "The answer is saved, but its audio timed out.",
        true,
      );
    }
    return jsonError(
      "request_denied",
      400,
      "Synthetic speech could not be requested.",
    );
  }
}
