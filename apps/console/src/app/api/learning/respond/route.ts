import { NextResponse } from "next/server";
import {
  answerGroundedLearningQuestion,
  LearningProviderError,
  type ConversationHistoryItem,
  type GroundingSource,
} from "../../../../lib/learning-provider";
import {
  AuthenticationBoundaryError,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";
import { LearningRpcError } from "../../../../lib/supabase/learning-rpc";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function requiredUuid(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new LearningRpcError("invalid_request");
  }
  return value;
}

function optionalUuid(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return requiredUuid(value);
}

function requestKey(value: unknown) {
  if (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 160 &&
    /^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    return value;
  }
  return crypto.randomUUID();
}

function normalizeSources(value: unknown): GroundingSource[] {
  if (!isRecord(value) || !Array.isArray(value.matches)) return [];
  return value.matches.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const source = isRecord(candidate.source) ? candidate.source : {};
    const chunkId = stringValue(candidate.chunkId);
    const courseId = stringValue(candidate.courseId);
    const courseTitle = stringValue(candidate.courseTitle);
    const documentId = stringValue(candidate.documentId);
    const documentTitle = stringValue(candidate.documentTitle);
    const contentHash = stringValue(candidate.contentHash);
    const excerpt = stringValue(candidate.excerpt)?.replace(
      /<\/?b>/giu,
      "",
    );
    if (
      !chunkId ||
      !courseId ||
      !courseTitle ||
      !documentId ||
      !documentTitle ||
      !contentHash ||
      !excerpt
    ) {
      return [];
    }
    return [
      {
        chunkId,
        courseId,
        courseTitle,
        documentId,
        documentTitle,
        contentHash,
        excerpt,
        lessonTitle: stringValue(source.lessonName),
        sectionName: stringValue(source.sectionName),
      },
    ];
  });
}

function normalizeHistory(value: unknown): ConversationHistoryItem[] {
  if (!isRecord(value) || !Array.isArray(value.conversations)) return [];
  const conversation = value.conversations.find(isRecord);
  if (!conversation || !Array.isArray(conversation.messages)) return [];
  return conversation.messages.flatMap((message) => {
    if (!isRecord(message)) return [];
    const actorType = stringValue(message.actorType);
    const body = stringValue(message.body);
    return actorType && body ? [{ actorType, body }] : [];
  });
}

function publicSources(sources: readonly GroundingSource[]) {
  return sources.map((source) => ({
    sourceId: source.chunkId,
    chunkId: source.chunkId,
    title: source.lessonTitle ?? source.documentTitle,
    courseId: source.courseId,
    courseTitle: source.courseTitle,
    lessonTitle: source.lessonTitle,
    sectionName: source.sectionName,
    excerpt: source.excerpt,
    contentHash: source.contentHash,
  }));
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    return NextResponse.json(
      { ok: false, code: "authentication_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof LearningProviderError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        retryable: error.retryable,
        message:
          error.code === "provider_not_configured"
            ? "The learning provider is not configured."
            : "The learning provider could not complete this response.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    error instanceof LearningRpcError &&
    error.code === "tenant_selection_required"
  ) {
    return NextResponse.json(
      { ok: false, code: error.code },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_denied" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    const operationToken =
      process.env.LEARNINGBOT_CONVERSATION_OPERATION_TOKEN?.trim();
    if (!operationToken || operationToken.length < 32) {
      throw new LearningProviderError("provider_not_configured", false);
    }
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const user = await requireVerifiedUser(supabase);
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new LearningRpcError("invalid_request");
    const conversationId = requiredUuid(input.conversationId);
    const courseId = optionalUuid(input.courseId);
    const message = stringValue(input.message)?.trim() ?? "";
    if (message.length < 2 || message.length > 8_000) {
      throw new LearningRpcError("invalid_request");
    }

    const baseKey = requestKey(input.idempotencyKey);
    const requestId = crypto.randomUUID();
    const traceId = `learning-response:${crypto.randomUUID()}`;
    const assistantKey = `assistant:${baseKey}`;
    const replay = await executeLearningRpc(
      supabase,
      "learning_get_completed_turn",
      {
        target_conversation_id: conversationId,
        assistant_idempotency_key: assistantKey,
      },
    );
    if (replay.completed === true && isRecord(replay.message)) {
      return NextResponse.json(
        {
          ok: true,
          dataMode: "durable",
          conversationId,
          message: replay.message,
          sources: Array.isArray(replay.message.sources)
            ? replay.message.sources
            : [],
          provider: { replayed: true },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    await executeLearningRpc(supabase, "learning_record_user_message", {
      target_conversation_id: conversationId,
      message_body: message,
      message_modality:
        input.modality === "voice" ? "voice_transcript" : "text",
      trace_id: traceId,
      idempotency_key: `user:${baseKey}`,
    });

    const [searchResult, transcript, workspace] = await Promise.all([
      executeLearningRpc(supabase, "learning_search_chunks", {
        search_query: message,
        target_course_id: courseId,
        match_limit: 6,
      }),
      executeLearningRpc(supabase, "learning_get_conversations", {
        target_conversation_id: conversationId,
      }),
      executeLearningRpc(supabase, "learning_get_workspace"),
    ]);
    const sources = normalizeSources(searchResult);
    const history = normalizeHistory(transcript);
    if (
      history.length &&
      history.at(-1)?.actorType !== "assistant" &&
      history.at(-1)?.body === message
    ) {
      history.pop();
    }
    const branding = isRecord(workspace.branding)
      ? workspace.branding
      : null;
    const tenant = isRecord(workspace.tenant) ? workspace.tenant : null;
    const answer = await answerGroundedLearningQuestion({
      assistantName:
        stringValue(branding?.assistantName) ??
        stringValue(tenant?.displayName) ??
        "Learning assistant",
      tenantId: stringValue(tenant?.tenantId) ?? "",
      actorId: user.id,
      requestId,
      traceId,
      idempotencyKey: baseKey,
      question: message,
      history,
      sources,
    });
    const evidence = publicSources(sources);
    const recorded = await executeLearningRpc(
      supabase,
      "learning_record_assistant_message",
      {
        target_conversation_id: conversationId,
        message_body: answer.answer,
        sources: evidence,
        provider_key: `${answer.provider}:${answer.adapterId}`.slice(0, 100),
        provider_request_ref: answer.providerRequestRef,
        trace_id: traceId,
        idempotency_key: assistantKey,
        operation_token: operationToken,
      },
    );

    return NextResponse.json(
      {
        ok: true,
        dataMode: "durable",
        conversationId,
        message: {
          messageId: recorded.messageId,
          role: "assistant",
          content: answer.answer,
          createdAt: new Date().toISOString(),
          sources: evidence,
        },
        sources: evidence,
        provider: {
          provider: answer.provider,
          adapterId: answer.adapterId,
          model: answer.model,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
