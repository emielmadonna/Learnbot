import {
  FakeRealtimeVoiceAdapter,
  FakeRealtimeVoiceTransport,
  MemoryVoiceCostSink,
  MemoryVoiceUsageSink,
  RealtimeVoiceOrchestrator,
  type RealtimeVoiceSession,
  type TextConversationHandoff,
} from "@course-ai/realtime-voice";
import type { AuthorizedTenantContext } from "@course-ai/application-services";

import { getDevelopmentRuntime } from "./dev-runtime";
import {
  voiceSessionScopeMatches,
  type DevelopmentVoiceSessionOwner,
} from "./voice-session-scope";

type DevelopmentVoiceSession = {
  session: RealtimeVoiceSession;
  createdAt: string;
  owner: DevelopmentVoiceSessionOwner;
};

const voiceGlobal = globalThis as typeof globalThis & {
  __learningBotDevelopmentVoiceSessions?: Map<string, DevelopmentVoiceSession>;
};

function sessions() {
  voiceGlobal.__learningBotDevelopmentVoiceSessions ??= new Map();
  return voiceGlobal.__learningBotDevelopmentVoiceSessions;
}

export async function startDevelopmentVoiceSession(
  authorized: AuthorizedTenantContext,
) {
  const now = Date.now();
  const actorId = authorized.actor.id;
  if (!actorId) {
    return {
      ok: false as const,
      code: "VOICE_SESSION_SCOPE_INVALID",
      message: "The voice session could not be scoped.",
    };
  }
  const conversation = await getDevelopmentRuntime().services.createConversation(
    authorized,
    {
      idempotencyKey: "student-demo-conversation",
      studentId: actorId,
      identityTier: "verified",
      activeModality: "text",
      pageContext: {
        url: "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
        courseId: "course_momentum",
        course: "Momentum Method",
        moduleId: "module_rhythm",
        module: "Build Your Rhythm",
        lessonId: "lesson_minimum_day",
        lesson: "Minimum Day",
      },
    },
  );
  const sessionId = `voice_${crypto.randomUUID()}`;
  const providerSessionId = `browser_${crypto.randomUUID()}`;
  const transport = new FakeRealtimeVoiceTransport(providerSessionId);
  const adapter = new FakeRealtimeVoiceAdapter({
    id: "browser-speech-bridge-v1",
    provider: "browser-web-speech",
    nowMs: now,
    openSteps: [{ type: "success", transport }],
  });
  const orchestrator = new RealtimeVoiceOrchestrator({
    adapter,
    usageSink: new MemoryVoiceUsageSink(),
    costSink: new MemoryVoiceCostSink(),
  });
  const outcome = await orchestrator.start({
    context: {
      requestId: authorized.requestId,
      traceId: authorized.traceId,
      tenantId: authorized.tenantId,
      actorId,
      conversationId: conversation.id,
      sessionId,
      fundingSource: authorized.fundingSource,
      deadlineMs: now + 10 * 60_000,
      idempotencyKey: sessionId,
    },
    options: {
      voiceId: "harbor",
      language: "en-US",
      mode: "tap_to_start",
      enableBargeIn: true,
      inputMediaType: "audio/browser-speech",
      outputMediaType: "audio/browser-speech",
      reconnect: {
        maxAttempts: 2,
        initialBackoffMs: 150,
        maxBackoffMs: 1_000,
      },
    },
  });
  if (!outcome.ok) {
    return outcome;
  }
  await getDevelopmentRuntime().services.setConversationModality(
    authorized,
    conversation.id,
    "voice",
    `${sessionId}:voice-modality`,
  );
  sessions().set(sessionId, {
    session: outcome.session,
    createdAt: new Date(now).toISOString(),
    owner: {
      tenantId: authorized.tenantId,
      actorId,
    },
  });
  return {
    ok: true as const,
    sessionId,
    conversationId: conversation.id,
    descriptor: outcome.session.clientDescriptor,
    transportMode: "browser-speech-bridge" as const,
  };
}

export async function handoffDevelopmentVoiceSession(
  authorized: AuthorizedTenantContext,
  sessionId: string,
  reason: TextConversationHandoff["reason"],
) {
  const record = sessions().get(sessionId);
  const actorId = authorized.actor.id;
  if (
    !record ||
    !actorId ||
    !voiceSessionScopeMatches(record.owner, {
      tenantId: authorized.tenantId,
      actorId,
    })
  ) {
    return {
      ok: false as const,
      code: "VOICE_SESSION_NOT_FOUND",
      message: "The voice session is unavailable or already closed.",
    };
  }
  const handoff = await record.session.handoffToText(reason);
  await getDevelopmentRuntime().services.setConversationModality(
    authorized,
    record.session.context.conversationId,
    "text",
    `${sessionId}:text-handoff`,
  );
  sessions().delete(sessionId);
  return { ok: true as const, handoff };
}

export function getDevelopmentVoiceSessionCount() {
  return sessions().size;
}
