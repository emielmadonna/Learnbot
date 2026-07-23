const baseUrl = process.env.COURSE_AI_CONSOLE_URL ?? "http://127.0.0.1:3100";
const smokeRunId = crypto.randomUUID();

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${body.message}`);
  }
  return body;
}

const health = await request("/api/dev/health");
if (health.status !== "healthy") throw new Error("Console health check failed.");

const session = await request("/api/dev/session", {
  headers: { "x-course-ai-tenant-id": "tenant_northstar_demo" },
});
const serializedSession = JSON.stringify(session);
if (
  session.mode !== "development_verified_fixture" ||
  session.productionIdpConfigured !== false ||
  session.tenantId !== "tenant_northstar_demo" ||
  session.role !== "tenant_owner" ||
  serializedSession.includes("accessToken") ||
  serializedSession.includes("refreshToken") ||
  serializedSession.includes("sessionId") ||
  serializedSession.includes("owner@northstar.example")
) {
  throw new Error("Development session metadata was not safely scoped.");
}

const crossTenantHeaderResponse = await fetch(`${baseUrl}/api/dev/platform`, {
  headers: { "x-course-ai-tenant-id": "tenant_other" },
  signal: AbortSignal.timeout(20_000),
});
const crossTenantHeaderBody = await crossTenantHeaderResponse.json();
if (
  crossTenantHeaderResponse.status !== 403 ||
  crossTenantHeaderBody.code !== "ACCESS_DENIED" ||
  JSON.stringify(crossTenantHeaderBody).includes("tenant_other")
) {
  throw new Error("Cross-tenant header selection did not fail closed safely.");
}

const crossTenantBodyResponse = await fetch(`${baseUrl}/api/dev/context`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    tenantId: "tenant_other",
    url: "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
    studentId: "student_maya_demo",
  }),
  signal: AbortSignal.timeout(20_000),
});
const crossTenantBody = await crossTenantBodyResponse.json();
if (
  crossTenantBodyResponse.status !== 403 ||
  crossTenantBody.code !== "ACCESS_DENIED" ||
  JSON.stringify(crossTenantBody).includes("tenant_other")
) {
  throw new Error("Cross-tenant body claim did not fail closed safely.");
}

const platform = await request("/api/dev/platform");
if (platform.tenant.tenantId !== "tenant_northstar_demo") {
  throw new Error("Platform snapshot returned the wrong tenant.");
}
if (platform.knowledge.active.status !== "active") {
  throw new Error("No active knowledge version is available.");
}

const context = await request("/api/dev/context", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
    studentId: "student_maya_demo",
  }),
});
if (
  context.courseId !== "course_momentum" ||
  context.source !== "url_mapping" ||
  context.progress.completedLessonIds.length !== 7
) {
  throw new Error("Learning context did not resolve from mapping and progress.");
}
const forgedStudentContext = await request("/api/dev/context", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
    studentId: "student_other",
  }),
});
if (
  forgedStudentContext.progress.completedLessonIds.length !== 7 ||
  forgedStudentContext.progress.courseId !== context.progress.courseId
) {
  throw new Error("Client-supplied student identity changed authenticated progress.");
}

const voiceSession = await request("/api/dev/voice", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "start" }),
});
if (
  !voiceSession.ok ||
  voiceSession.descriptor.credentialKind !== "ephemeral" ||
  voiceSession.transportMode !== "browser-speech-bridge" ||
  JSON.stringify(voiceSession.descriptor).includes("vault://")
) {
  throw new Error("Realtime voice did not return a safe scoped descriptor.");
}
const crossTenantVoiceHandoff = await fetch(`${baseUrl}/api/dev/voice`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-course-ai-tenant-id": "tenant_other",
  },
  body: JSON.stringify({
    action: "handoff",
    sessionId: voiceSession.sessionId,
    reason: "user_requested",
  }),
  signal: AbortSignal.timeout(20_000),
});
if (crossTenantVoiceHandoff.status !== 403) {
  throw new Error("Cross-tenant voice-session handoff did not fail closed.");
}
const voiceHandoff = await request("/api/dev/voice", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "handoff",
    sessionId: voiceSession.sessionId,
    reason: "user_requested",
  }),
});
if (
  !voiceHandoff.ok ||
  voiceHandoff.handoff.conversationId !== voiceSession.conversationId ||
  voiceHandoff.handoff.modality !== "text"
) {
  throw new Error("Realtime voice did not preserve the text conversation handoff.");
}

const courses = await request("/api/dev/courses");
if (!courses.courses.some((course) => course.courseId === "course_momentum")) {
  throw new Error("The shared course service did not return Momentum Method.");
}
const courseDraft = await request("/api/dev/courses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "create",
    title: `API smoke draft ${smokeRunId.slice(0, 8)}`,
    description: "Private course draft created by the development smoke.",
    idempotencyKey: `dev-api-smoke-course-${smokeRunId}`,
  }),
});
if (
  courseDraft.course.status !== "draft" ||
  courseDraft.course.tenantId !== "tenant_northstar_demo"
) {
  throw new Error("Course creation did not return a tenant-scoped private draft.");
}

const chatRequestBody = JSON.stringify({
  message: "How small should my Minimum Day be?",
  modality: "text",
  pageUrl:
    "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
  idempotencyKey: `dev-api-smoke-chat-${smokeRunId}`,
});
const chatResponse = await fetch(`${baseUrl}/api/dev/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: chatRequestBody,
  signal: AbortSignal.timeout(20_000),
});
if (!chatResponse.ok) throw new Error("Grounded chat request failed.");
const chatEvents = (await chatResponse.text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
if (
  chatEvents[0]?.type !== "context" ||
  !chatEvents.some((event) => event.type === "delta") ||
  chatEvents.at(-1)?.type !== "completed" ||
  chatEvents.at(-1)?.provider?.adapterId !== "grounded-deterministic-v1" ||
  chatEvents.at(-1)?.provider?.fundingSource !== "platform"
) {
  throw new Error(
    "Grounded chat did not stream the complete provider-routed event contract.",
  );
}

const replayResponse = await fetch(`${baseUrl}/api/dev/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: chatRequestBody,
  signal: AbortSignal.timeout(20_000),
});
const replayEvents = (await replayResponse.text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
if (
  !replayResponse.ok ||
  replayEvents.at(-1)?.provider?.replayed !== true
) {
  throw new Error("Chat request idempotency did not replay the completed result.");
}
const conflictResponse = await fetch(`${baseUrl}/api/dev/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...JSON.parse(chatRequestBody),
    message: "Different input with the same key",
  }),
  signal: AbortSignal.timeout(20_000),
});
if (conflictResponse.status !== 409) {
  throw new Error("Conflicting chat idempotency input did not fail closed.");
}
const platformAfterChat = await request("/api/dev/platform");
if (
  platformAfterChat.providers.attempts.length !==
  platform.providers.attempts.length + 1
) {
  throw new Error("Chat replay created an extra provider attempt.");
}

const attachmentForm = new FormData();
attachmentForm.append(
  "file",
  new Blob(["A safe student worksheet for the development smoke test."], {
    type: "text/plain",
  }),
  "student-worksheet.txt",
);
const attachment = await request("/api/dev/attachments", {
  method: "POST",
  body: attachmentForm,
});
if (
  attachment.attachment.status !== "ready" ||
  attachment.promotedToCourseKnowledge !== false
) {
  throw new Error("Attachment did not complete the safe conversation pipeline.");
}

const quarantineForm = new FormData();
quarantineForm.append(
  "file",
  new Blob(["EICAR-STANDARD-ANTIVIRUS-TEST-FILE"], { type: "text/plain" }),
  "quarantine-test.txt",
);
const quarantineResponse = await fetch(`${baseUrl}/api/dev/attachments`, {
  method: "POST",
  body: quarantineForm,
  signal: AbortSignal.timeout(20_000),
});
const quarantine = await quarantineResponse.json();
if (
  quarantineResponse.status !== 422 ||
  quarantine.attachment?.status !== "quarantined"
) {
  throw new Error("Unsafe attachment did not fail closed in quarantine.");
}

const ingestion = await request("/api/dev/ingestion", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "start",
    title: "API smoke learning",
    body: "A restart loop protects momentum. Diagram: Disruption -> Minimum Day -> Evidence -> Momentum.",
    idempotencyKey: "dev-api-smoke-ingestion-v1",
  }),
});
if (
  ingestion.job.status !== "succeeded" ||
  !ingestion.job.draftVersionId ||
  ingestion.active.status !== "active"
) {
  throw new Error("Ingestion did not create a safe draft beside the active version.");
}

const branding = await request("/api/dev/branding", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    assistantName: "Nova",
    primary: "#315f50",
    accent: "#d8a653",
    surface: "#fffdf8",
    welcome: "Ask a question, upload a file, or talk it through.",
    voice: "Harbor",
    attribution: true,
    privacyLink: true,
    idempotencyKey: "dev-api-smoke-branding-v1",
  }),
});
if (branding.published.assistant.name !== "Nova") {
  throw new Error("Branding did not publish through application services.");
}

console.log(
  "Development API smoke passed: membership-backed safe session metadata, cross-tenant denial, authenticated student progress, health, tenant snapshot, course draft, learning context, tenant-bound realtime voice handoff, idempotent provider-routed chat, attachment readiness/quarantine, ingestion draft and branding publish.",
);
