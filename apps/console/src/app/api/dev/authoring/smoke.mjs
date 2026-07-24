const baseUrl = process.env.COURSE_AI_CONSOLE_URL ?? "http://127.0.0.1:3100";
const requestTimeoutMs = 60_000;

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${payload.code ?? payload.message}`);
  }
  return payload;
}

const initial = await request("/api/dev/authoring");
if (
  initial.course.courseId !== "course_momentum" ||
  initial.lesson.lessonId !== "lesson_minimum_day" ||
  initial.course.version < 12
) {
  throw new Error("Northstar authoring seed is unavailable.");
}

const imported = await request("/api/dev/authoring", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "import",
    lessonId: initial.lesson.lessonId,
    expectedVersion: initial.course.version,
    format: "markdown",
    content: "## Minimum Day\n\nA small action protects the restart loop.",
    idempotencyKey: `smoke-import-${Date.now()}`,
  }),
});

const unsafe = await fetch(`${baseUrl}/api/dev/authoring`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "add_embed",
    lessonId: imported.lesson.lessonId,
    expectedVersion: imported.course.version,
    url: "javascript:alert(1)",
    idempotencyKey: `smoke-unsafe-${Date.now()}`,
  }),
  signal: AbortSignal.timeout(requestTimeoutMs),
});
const unsafePayload = await unsafe.json();
if (unsafe.status !== 422 || unsafePayload.code !== "authoring.invalid_input") {
  throw new Error("Unsafe embed was not rejected.");
}

const validated = await request(
  `/api/dev/authoring?lessonId=${encodeURIComponent(imported.lesson.lessonId)}`,
);
if (!validated.publishValidation.valid || validated.course.status !== "draft") {
  throw new Error("Imported authoring draft did not validate.");
}

const published = await request("/api/dev/authoring", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "publish",
    expectedVersion: validated.course.version,
    auditNote: "Endpoint smoke publication.",
    idempotencyKey: `smoke-publish-${Date.now()}`,
  }),
});
if (published.course.status !== "published") {
  throw new Error("Validated draft was not published.");
}

const restored = await request("/api/dev/authoring", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "rollback",
    expectedVersion: published.course.version,
    targetVersion: 12,
    auditNote: "Restore the Northstar fixture after endpoint smoke.",
    idempotencyKey: `smoke-rollback-${Date.now()}`,
  }),
});
const republished = await request("/api/dev/authoring", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "publish",
    expectedVersion: restored.course.version,
    auditNote: "Republish restored Northstar fixture.",
    idempotencyKey: `smoke-restore-publish-${Date.now()}`,
  }),
});
if (
  republished.course.status !== "published" ||
  !republished.editorContent.includes("smallest credible version")
) {
  throw new Error("Smoke cleanup did not restore the Northstar lesson.");
}

console.log(
  `Authoring smoke passed: import, validation, unsafe rejection, publish, rollback; restored v${republished.course.version}`,
);
