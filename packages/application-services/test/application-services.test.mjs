import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ApplicationError,
  PlatformApplicationServices,
  authorizeTenantContext,
} from "../dist/index.js";

const fixedNow = "2026-07-23T12:00:00.000Z";
const clock = { now: () => new Date(fixedNow) };

function tenant(tenantId, slug = tenantId) {
  return {
    tenantId,
    slug,
    status: "active",
    planId: "enterprise",
    locale: "en-US",
    timeZone: "America/Los_Angeles",
    featureFlags: { realtimeVoice: true },
    limits: { attachmentBytes: 20_000_000 },
    policyVersion: "policy-1",
    resolvedAt: fixedNow,
  };
}

function tenantRecord(tenantId) {
  return {
    tenantId,
    displayName: `${tenantId} Academy`,
    tenant: tenant(tenantId),
    settings: {},
    version: 1,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function branding(tenantId, version = 1) {
  return {
    tenantId,
    version,
    assistant: {
      name: `${tenantId} Guide`,
      welcomeMessage: "How can I help?",
    },
    colors: {
      primary: "#111827",
      accent: "#14b8a6",
      canvas: "#ffffff",
      surface: "#f8fafc",
      text: "#111827",
    },
    typography: { family: "system" },
    launcher: {
      style: "bubble",
      position: "bottom_right",
    },
    attribution: { showPlatformAttribution: true },
    voice: {
      enabled: true,
      voiceId: "neutral-voice",
      displayName: "Guide",
    },
    updatedAt: fixedNow,
  };
}

function request(tenantId, role = "tenant_admin", actorId = `${tenantId}-admin`) {
  return {
    requestId: `req-${tenantId}-${role}`,
    tenantId,
    actor: {
      type: role === "student" ? "student" : "owner",
      id: actorId,
      role,
      identityTier: "verified",
    },
    fundingSource: "platform",
    deadlineMs: Date.now() + 60_000,
    traceId: `trace-${tenantId}`,
    environment: "test",
  };
}

function context(tenantId, role = "tenant_admin", actorId) {
  return authorizeTenantContext(
    request(tenantId, role, actorId),
    tenant(tenantId),
    role,
  );
}

function seededServices(extra = {}) {
  return new PlatformApplicationServices(
    {
      tenants: [tenantRecord("alpha"), tenantRecord("beta")],
      branding: [branding("alpha"), branding("beta")],
      ...extra,
    },
    { clock },
  );
}

function expectApplicationError(code) {
  return (error) => error instanceof ApplicationError && error.code === code;
}

test("SEC-01: authorization rejects a request/tenant scope mismatch", () => {
  assert.throws(
    () =>
      authorizeTenantContext(
        request("alpha"),
        tenant("beta"),
        "tenant_admin",
      ),
    expectApplicationError("INVALID_CONTEXT"),
  );
});

test("SEC-01/02: repositories cannot return or mutate another tenant's records", async () => {
  const betaCourse = {
    courseId: "beta-only-course",
    tenantId: "beta",
    title: "Beta curriculum",
    slug: "beta-curriculum",
    status: "draft",
    version: 1,
    modules: [],
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
  const services = seededServices({ courses: [betaCourse] });
  const alpha = context("alpha");

  assert.deepEqual(await services.listCourses(alpha), []);
  await assert.rejects(
    services.getCourse(alpha, betaCourse.courseId),
    expectApplicationError("RESOURCE_NOT_FOUND"),
  );
  await assert.rejects(
    services.updateCourseMetadata(
      alpha,
      betaCourse.courseId,
      1,
      { title: "Stolen" },
      "try-cross-tenant",
    ),
    expectApplicationError("RESOURCE_NOT_FOUND"),
  );

  const beta = context("beta");
  assert.equal((await services.getCourse(beta, betaCourse.courseId)).title, "Beta curriculum");
});

test("SEC-02: role permissions prevent a teacher from changing tenant configuration", async () => {
  const services = seededServices();
  await assert.rejects(
    services.updateTenantConfiguration(
      context("alpha", "teacher"),
      { displayName: "Unauthorized rename" },
      "rename-1",
    ),
    expectApplicationError("PERMISSION_DENIED"),
  );
  assert.equal(
    (await services.getTenantConfiguration(context("alpha"))).displayName,
    "alpha Academy",
  );
});

test("SEC-07: each effective mutation produces a tenant-scoped audit fact", async () => {
  const services = seededServices();
  const admin = context("alpha");
  const draft = await services.saveBrandingDraft(
    admin,
    {
      assistant: {
        name: "Nova",
        welcomeMessage: "Welcome to Alpha",
      },
      colors: branding("alpha").colors,
      typography: branding("alpha").typography,
      launcher: branding("alpha").launcher,
      attribution: branding("alpha").attribution,
      voice: branding("alpha").voice,
    },
    "brand-draft-2",
  );
  await services.publishBranding(admin, draft.version, "brand-publish-2");

  const audit = await services.listAuditRecords(admin);
  assert.equal(audit.length, 2);
  assert.deepEqual(
    audit.map((record) => record.action).sort(),
    ["branding.publish", "branding.save_draft"],
  );
  assert.ok(audit.every((record) => record.tenantId === "alpha"));
  assert.ok(audit.every((record) => record.actorId === "alpha-admin"));
  assert.ok(audit.every((record) => record.requestId.startsWith("req-alpha")));
  assert.equal((await services.listAuditRecords(context("beta"))).length, 0);
});

test("branding rollback preserves history and creates a monotonic published version", async () => {
  const services = seededServices();
  const admin = context("alpha");
  const draft = await services.saveBrandingDraft(
    admin,
    {
      assistant: {
        name: "Nova",
        welcomeMessage: "Welcome",
      },
      colors: branding("alpha").colors,
      typography: branding("alpha").typography,
      launcher: branding("alpha").launcher,
      attribution: branding("alpha").attribution,
      voice: branding("alpha").voice,
    },
    "draft-nova",
  );
  await services.publishBranding(admin, draft.version, "publish-nova");
  const rolledBack = await services.rollbackBranding(admin, 1, "rollback-one");

  assert.equal(rolledBack.version, 3);
  assert.equal(rolledBack.assistant.name, "alpha Guide");
  assert.equal((await services.getPublishedBranding(admin)).version, 3);
});

test("learning context uses verified host state, then tenant URL mappings and progress", async () => {
  const services = seededServices({
    courses: [
      {
        courseId: "course-alpha",
        tenantId: "alpha",
        title: "Momentum",
        slug: "momentum",
        status: "published",
        version: 1,
        modules: [],
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ],
  });
  const admin = context("alpha");
  await services.upsertLearningContextMapping(
    admin,
    {
      enabled: true,
      priority: 100,
      match: { type: "prefix", urlPrefix: "https://academy.test/momentum/" },
      context: {
        courseId: "course-alpha",
        course: "Momentum",
        lessonId: "lesson-3",
        lesson: "Minimum Day",
      },
    },
    "mapping-momentum",
  );
  await services.saveStudentProgress(
    admin,
    "student-1",
    {
      courseId: "course-alpha",
      lessonId: "lesson-3",
      coursePercentComplete: 58,
      completedLessonIds: ["lesson-1", "lesson-2"],
      updatedAt: fixedNow,
    },
    "progress-student-1",
  );

  const resolved = await services.resolveLearningContext(
    context("alpha", "student", "student-1"),
    {
      page: { url: "https://academy.test/momentum/minimum-day" },
      studentId: "student-1",
    },
  );
  assert.equal(resolved.source, "url_mapping");
  assert.equal(resolved.lesson, "Minimum Day");
  assert.equal(resolved.progress?.coursePercentComplete, 58);

  const verified = await services.resolveLearningContext(
    context("alpha", "student", "student-1"),
    {
      page: { url: "https://academy.test/anything" },
      hostContext: {
        url: "https://academy.test/anything",
        courseId: "course-alpha",
        course: "Momentum",
        lessonId: "lesson-live",
        lesson: "Live lesson",
      },
      studentId: "student-1",
    },
  );
  assert.equal(verified.source, "verified_host_context");
  assert.equal(verified.confidence, 1);
  assert.equal(verified.lessonId, "lesson-live");
});

test("conversation and attachments enforce both tenant and student ownership", async () => {
  const services = seededServices();
  const alphaStudent = context("alpha", "student", "student-a");
  const conversation = await services.createConversation(alphaStudent, {
    idempotencyKey: "conversation-1",
    identityTier: "verified",
    activeModality: "voice",
  });
  const attachment = await services.createAttachment(alphaStudent, {
    idempotencyKey: "attachment-1",
    conversationId: conversation.id,
    kind: "pdf",
    fileName: "worksheet.pdf",
    mediaType: "application/pdf",
    sizeBytes: 1024,
  });
  assert.equal(attachment.tenantId, "alpha");
  assert.equal((await services.getConversation(alphaStudent, conversation.id)).studentId, "student-a");

  await assert.rejects(
    services.getConversation(
      context("alpha", "student", "student-b"),
      conversation.id,
    ),
    expectApplicationError("RESOURCE_NOT_FOUND"),
  );
  await assert.rejects(
    services.getAttachment(context("beta"), attachment.attachmentId),
    expectApplicationError("RESOURCE_NOT_FOUND"),
  );
});

test("COST-01: retries are idempotent and produce one billable fact", async () => {
  const services = seededServices();
  const admin = context("alpha");
  const input = {
    idempotencyKey: "attempt-cost-1",
    referenceType: "job",
    referenceId: "job-1",
    attemptId: "attempt-1",
    feature: "content_embedding",
    capability: "embedding",
    provider: "provider-selected-at-runtime",
    adapterId: "embedding-primary",
    modelOrSku: "embedding-model",
    quantities: [{ quantity: 250, unit: "embedding_token" }],
    amount: 0.00005,
    currency: "USD",
    status: "final",
  };

  const first = await services.recordCost(admin, input);
  const replay = await services.recordCost(admin, input);
  assert.deepEqual(replay, first);
  assert.equal((await services.listCosts(admin)).length, 1);
  assert.equal((await services.listAuditRecords(admin)).length, 1);

  await assert.rejects(
    services.recordCost(admin, { ...input, amount: 9 }),
    expectApplicationError("IDEMPOTENCY_CONFLICT"),
  );
  const summary = await services.summarizeCosts(
    admin,
    "2026-01-01T00:00:00.000Z",
    "2026-12-31T23:59:59.999Z",
    "USD",
  );
  assert.equal(summary.entryCount, 1);
  assert.equal(summary.finalCost, 0.00005);
});

test("deterministic mutation IDs remain stable across process instances", async () => {
  const first = seededServices();
  const second = seededServices();
  const create = (services) =>
    services.createCourse(
      context("alpha"),
      { title: "Foundations", slug: "foundations" },
      "create-foundations",
    );
  assert.equal((await create(first)).courseId, (await create(second)).courseId);
});

test("PRO-01: production source imports contracts only and declares no named provider SDK", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const packageDirectory = dirname(testDirectory);
  const sourceDirectory = join(packageDirectory, "src");
  const files = (await readdir(sourceDirectory)).filter((file) =>
    file.endsWith(".ts"),
  );
  const sources = await Promise.all(
    files.map((file) => readFile(join(sourceDirectory, file), "utf8")),
  );
  const importSpecifiers = sources.flatMap((source) =>
    [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    ),
  );
  const namedProviderPackages = [
    "@anthropic-ai/sdk",
    "@google/generative-ai",
    "openai",
    "replicate",
    "elevenlabs",
  ];
  assert.equal(
    importSpecifiers.some((specifier) =>
      namedProviderPackages.some(
        (providerPackage) =>
          specifier === providerPackage ||
          specifier.startsWith(`${providerPackage}/`),
      ),
    ),
    false,
  );

  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies), [
    "@course-ai/contracts",
  ]);
});
