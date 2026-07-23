import {
  authorizeTenantContext,
  PlatformApplicationServices,
  type AuthorizedTenantContext,
  type PlatformRole,
  type PlatformSeed,
} from "@course-ai/application-services";
import { DeterministicLearningPipeline } from "@course-ai/learning-pipeline";

export const DEVELOPMENT_TENANT_ID = "tenant_northstar_demo";
export const DEVELOPMENT_STUDENT_ID = "student_maya_demo";
export const DEVELOPMENT_COURSE_ID = "course_momentum";
export const DEVELOPMENT_DOCUMENT_ID = "document_minimum_day";

const SEEDED_AT = "2026-07-23T20:00:00.000Z";

const seed: PlatformSeed = {
  tenants: [
    {
      tenantId: DEVELOPMENT_TENANT_ID,
      displayName: "Northstar Academy",
      tenant: {
        tenantId: DEVELOPMENT_TENANT_ID,
        slug: "northstar-academy",
        status: "active",
        planId: "enterprise",
        region: "us-west",
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        featureFlags: {
          realtimeVoice: true,
          fileAttachments: true,
          managementMcp: true,
        },
        limits: {
          monthlyBudgetUsd: 2500,
          attachmentBytes: 26214400,
        },
        policyVersion: "policy-v18",
        resolvedAt: SEEDED_AT,
      },
      settings: {
        identityMode: "verified_host",
        retentionDays: 30,
      },
      version: 1,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  ],
  branding: [
    {
      tenantId: DEVELOPMENT_TENANT_ID,
      version: 1,
      assistant: {
        name: "Nova",
        welcomeMessage:
          "Hi, I’m Nova. Ask a question about this lesson, upload a file, or talk it through with me.",
      },
      colors: {
        primary: "#315f50",
        accent: "#d8a653",
        canvas: "#eef2ef",
        surface: "#fffdf8",
        text: "#17211d",
      },
      typography: { family: "system" },
      launcher: {
        style: "pill",
        position: "bottom_right",
        label: "Ask Nova",
      },
      attribution: {
        showPlatformAttribution: true,
        privacyUrl: "https://northstar.example/privacy",
      },
      voice: {
        enabled: true,
        voiceId: "harbor",
        displayName: "Harbor",
      },
      updatedAt: SEEDED_AT,
    },
  ],
  mappings: [
    {
      mappingId: "mapping_momentum",
      tenantId: DEVELOPMENT_TENANT_ID,
      enabled: true,
      priority: 100,
      match: {
        type: "prefix",
        urlPrefix: "/courses/momentum-method/",
      },
      context: {
        courseId: DEVELOPMENT_COURSE_ID,
        course: "Momentum Method",
        moduleId: "module_rhythm",
        module: "Build Your Rhythm",
        lessonId: "lesson_minimum_day",
        lesson: "Minimum Day",
      },
      updatedAt: SEEDED_AT,
    },
  ],
  progress: [
    {
      tenantId: DEVELOPMENT_TENANT_ID,
      studentId: DEVELOPMENT_STUDENT_ID,
      progress: {
        courseId: DEVELOPMENT_COURSE_ID,
        moduleId: "module_rhythm",
        lessonId: "lesson_minimum_day",
        coursePercentComplete: 58,
        modulePercentComplete: 64,
        completedLessonIds: [
          "lesson_welcome",
          "lesson_systems",
          "lesson_trigger",
          "lesson_evidence",
          "lesson_restart",
          "lesson_floor",
          "lesson_review",
        ],
        updatedAt: SEEDED_AT,
      },
      updatedAt: SEEDED_AT,
    },
  ],
  courses: [
    {
      courseId: DEVELOPMENT_COURSE_ID,
      tenantId: DEVELOPMENT_TENANT_ID,
      title: "Momentum Method",
      slug: "momentum-method",
      description: "Build consistent progress with smaller restart loops.",
      status: "published",
      version: 12,
      modules: [
        {
          moduleId: "module_rhythm",
          title: "Build Your Rhythm",
          position: 2,
          lessons: [
            {
              lessonId: "lesson_minimum_day",
              title: "Minimum Day",
              slug: "minimum-day",
              description: "Protect momentum when a full practice is impossible.",
              position: 3,
              status: "published",
              blocks: [
                {
                  id: "block_minimum_day",
                  type: "paragraph",
                  content: [
                    {
                      text: "A Minimum Day is the smallest version of the habit that protects your identity and restart loop.",
                    },
                  ],
                },
              ],
              sourceDocumentIds: [DEVELOPMENT_DOCUMENT_ID],
              estimatedMinutes: 10,
              updatedAt: SEEDED_AT,
            },
          ],
        },
      ],
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      publishedAt: SEEDED_AT,
    },
  ],
};

export type DevelopmentRuntime = {
  services: PlatformApplicationServices;
  pipeline: DeterministicLearningPipeline;
  initialJobId: string;
};

function createRuntime(): DevelopmentRuntime {
  const services = new PlatformApplicationServices(seed);
  const pipeline = new DeterministicLearningPipeline();
  const initial = pipeline.start(
    { tenantId: DEVELOPMENT_TENANT_ID },
    {
      tenantId: DEVELOPMENT_TENANT_ID,
      sourceId: "source_momentum_transcript",
      documentId: DEVELOPMENT_DOCUMENT_ID,
      title: "Designing Your Minimum Day",
      mediaType: "text/plain",
      contentHash: "sha256:minimum-day-v12",
      courseId: DEVELOPMENT_COURSE_ID,
      moduleId: "module_rhythm",
      lessonId: "lesson_minimum_day",
      body:
        "A Minimum Day is the smallest credible version of your practice. On a disrupted day, open your plan, choose one priority, and stop after two intentional minutes. This protects the restart loop without turning the minimum into the permanent target. After two consistent days, rebuild the fuller practice. Diagram: Disruption -> Minimum Day -> Evidence -> Momentum.",
    },
    "seed-minimum-day-v12",
  );
  pipeline.publish(
    { tenantId: DEVELOPMENT_TENANT_ID },
    initial.draftVersionId!,
  );
  return { services, pipeline, initialJobId: initial.jobId };
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __learningBotDevelopmentRuntime?: DevelopmentRuntime;
};

export function getDevelopmentRuntime(): DevelopmentRuntime {
  runtimeGlobal.__learningBotDevelopmentRuntime ??= createRuntime();
  return runtimeGlobal.__learningBotDevelopmentRuntime;
}

export function authorizeDevelopmentRequest(
  role: PlatformRole = "tenant_owner",
  actorId = "owner_emiel_demo",
  tenantId = DEVELOPMENT_TENANT_ID,
): AuthorizedTenantContext {
  const runtime = getDevelopmentRuntime();
  const configuration = seed.tenants?.find(
    (record) => record.tenantId === tenantId,
  );
  if (!configuration) {
    throw new Error("Unknown development tenant.");
  }
  return authorizeTenantContext(
    {
      requestId: `req_${crypto.randomUUID()}`,
      tenantId,
      actor: {
        type: role === "student" ? "student" : role === "creator" || role === "teacher" ? "creator" : "owner",
        id: actorId,
        role,
        identityTier: "verified",
      },
      fundingSource: "platform",
      deadlineMs: Date.now() + 30_000,
      traceId: `trace_${crypto.randomUUID()}`,
      environment: "local",
    },
    configuration.tenant,
    role,
  );
}

export function serializeDevelopmentError(error: unknown) {
  if (error instanceof Error) {
    return {
      error: error.name,
      message: error.message,
      ...("code" in error && typeof error.code === "string"
        ? { code: error.code }
        : {}),
    };
  }
  return { error: "UnknownError", message: "An unknown error occurred." };
}
