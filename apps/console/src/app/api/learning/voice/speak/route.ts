import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  getCurrentTenantContext,
} from "../../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../../lib/supabase/learning-route";
import {
  resolveTenantVoice,
} from "../../../../../lib/voice-runtime";
import {
  forwardManagedVoiceFailure,
  invokeManagedVoice,
  managedVoiceHeaders,
} from "../../../../../lib/supabase/managed-voice";

type JsonRecord = Record<string, unknown>;

const MAX_SPEECH_CHARACTERS = 4_096;
const MAX_SPEECH_REQUEST_BYTES = 16 * 1024;

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
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    { ok: false, code, message, retryable },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
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
    const context = await getCurrentTenantContext(supabase);
    if (
      !context.selected ||
      !context.tenantId ||
      !context.membershipId ||
      !context.principalId
    ) {
      return jsonError(
        "tenant_selection_required",
        409,
        "Select a workspace before using voice.",
      );
    }
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      return jsonError(
        "invalid_content_type",
        415,
        "A JSON speech request is required.",
      );
    }
    const rawInput = await request.text();
    if (new TextEncoder().encode(rawInput).byteLength > MAX_SPEECH_REQUEST_BYTES) {
      return jsonError(
        "request_too_large",
        413,
        "The speech request is too large.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(rawInput) as unknown;
    } catch {
      return jsonError("invalid_request", 400, "A saved assistant answer is required.");
    }
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

    // The tenant's configured voice, not a hardcoded one. An unset or
    // unrecognised value falls back to the platform default.
    const voiceProfile = await resolveTenantVoice(supabase);
    const managedResponse = await invokeManagedVoice(
      request,
      supabase,
      JSON.stringify({
        action: "speak",
        tenantId: context.tenantId,
        input: answer,
        voice: voiceProfile.voice,
        conversationId,
        messageId,
      }),
      "application/json",
    );
    if (!managedResponse.ok || !managedResponse.body) {
      return forwardManagedVoiceFailure(
        managedResponse,
        "The answer is saved, but its audio could not be generated.",
      );
    }
    return new NextResponse(managedResponse.body, {
      status: 200,
      headers: managedVoiceHeaders(managedResponse, {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'inline; filename="assistant-answer.mp3"',
        "X-AI-Generated-Voice": "true",
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
