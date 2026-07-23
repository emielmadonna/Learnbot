import {
  authorizeDevelopmentRequest,
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";
import { executeDevelopmentGroundedChat } from "../../../../lib/provider-runtime";

type ChatRequest = {
  message?: string;
  attachmentId?: string;
  modality?: "text" | "voice";
  pageUrl?: string;
  idempotencyKey?: string;
};

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as ChatRequest;
    const session = await requireDevSession(request, {
      principal: "student",
      permission: "conversation.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const studentId = requireDevActorId(session);
    const message = input.message?.trim() ?? "";
    if (!message && !input.attachmentId) {
      return Response.json(
        { code: "MESSAGE_REQUIRED", message: "Add text or a ready attachment." },
        { status: 400 },
      );
    }
    const runtime = getDevelopmentRuntime();
    const studentContext = session.context;
    const key = input.idempotencyKey ?? crypto.randomUUID();
    const conversation = await runtime.services.createConversation(
      studentContext,
      {
        idempotencyKey: "student-demo-conversation",
        studentId,
        identityTier: "verified",
        activeModality: "text",
        pageContext: {
          url:
            input.pageUrl ??
            "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
          courseId: "course_momentum",
          course: "Momentum Method",
          moduleId: "module_rhythm",
          module: "Build Your Rhythm",
          lessonId: "lesson_minimum_day",
          lesson: "Minimum Day",
        },
      },
    );
    if (input.modality === "voice") {
      await runtime.services.setConversationModality(
        studentContext,
        conversation.id,
        "voice",
        `${key}:voice-modality`,
      );
    }
    if (input.attachmentId) {
      const attachment = await runtime.services.getAttachment(
        studentContext,
        input.attachmentId,
      );
      if (attachment.status !== "ready") {
        return Response.json(
          {
            code: "ATTACHMENT_NOT_READY",
            message: "The attachment has not completed safe processing.",
          },
          { status: 409 },
        );
      }
    }
    const context = await runtime.services.resolveLearningContext(
      studentContext,
      {
        page: {
          url:
            input.pageUrl ??
            "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
        },
        studentId,
      },
    );
    const providerContext = {
      requestId: studentContext.requestId,
      traceId: studentContext.traceId,
      tenantId: studentContext.tenantId,
      ...(studentContext.actor.id === undefined
        ? {}
        : { actorId: studentContext.actor.id }),
      fundingSource: studentContext.fundingSource,
      deadlineMs: studentContext.deadlineMs,
      idempotencyKey: key,
    };
    const providerExecution = await executeDevelopmentGroundedChat(
      providerContext,
      {
        message,
        contextSource: context.source,
        contextConfidence: context.confidence,
      },
      key,
    );
    const providerOutcome = providerExecution.outcome;
    if (!providerOutcome.ok) {
      return Response.json(
        {
          code: providerOutcome.error.code,
          message: providerOutcome.error.message,
          retryable: providerOutcome.error.retryable,
        },
        {
          status:
            providerOutcome.error.code === "permission_denied"
              ? 403
              : providerOutcome.error.code === "invalid_request"
                ? 409
                : 503,
        },
      );
    }
    const { answer, source } = providerOutcome.result.value;
    const serviceContext = authorizeDevelopmentRequest(
      "service",
      "development-provider-router",
    );
    await runtime.services.recordCost(serviceContext, {
      idempotencyKey: `${key}:cost`,
      referenceType: "conversation",
      referenceId: conversation.id,
      attemptId: `${key}:attempt-1`,
      feature: "grounded_conversation",
      capability: "llm.chat",
      provider: providerOutcome.result.provider,
      adapterId: providerOutcome.result.adapterId,
      ...(providerOutcome.result.modelOrSku === undefined
        ? {}
        : { modelOrSku: providerOutcome.result.modelOrSku }),
      quantities: providerOutcome.result.usage.map(({ quantity, unit }) => ({
        quantity,
        unit:
          unit === "input_token"
            ? "input_token"
            : unit === "output_token"
              ? "output_token"
              : "other",
      })),
      amount: providerOutcome.result.estimatedCost.amount,
      currency: providerOutcome.result.estimatedCost.currency,
      status: "final",
      safeMetadata: {
        contextSource: context.source,
        contextConfidence: context.confidence,
      },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        send({
          type: "context",
          conversationId: conversation.id,
          context: {
            course: context.course,
            module: context.module,
            lesson: context.lesson,
            source: context.source,
            confidence: context.confidence,
          },
        });
        const words = answer.split(" ");
        for (let index = 0; index < words.length; index += 1) {
          send({
            type: "delta",
            text: `${index === 0 ? "" : " "}${words[index]}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 24));
        }
        send({
          type: "completed",
          sources: [
            source,
          ],
          costRecorded: true,
          provider: {
            adapterId: providerOutcome.result.adapterId,
            provider: providerOutcome.result.provider,
            policyVersion: "policy-v18",
            fundingSource: providerContext.fundingSource,
            replayed: providerExecution.replayed,
          },
        });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
