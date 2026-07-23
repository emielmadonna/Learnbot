import assert from "node:assert/strict";
import test from "node:test";
import type { RequestContext } from "@course-ai/contracts";
import {
  AuthoringError,
  CourseAuthoringService,
  InMemoryCourseAuthoringRepository,
  importMarkdown,
  importPlainText,
  sanitizeHtmlToPlainText,
  validateCourse,
} from "../src/index.js";

function context(
  tenantId = "tenant_alpha",
  requestId = "request_1",
): RequestContext {
  return {
    requestId,
    tenantId,
    actor: { type: "creator", id: "creator_1", role: "course_editor" },
    fundingSource: "platform",
    deadlineMs: Date.now() + 60_000,
    traceId: `trace_${requestId}`,
    environment: "test",
  };
}

function isCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AuthoringError && error.code === code;
}

async function createPopulatedCourse(
  service: CourseAuthoringService,
  tenantId = "tenant_alpha",
) {
  const ctx = context(tenantId);
  const created = await service.create(ctx, {
    idempotencyKey: "create-course",
    title: "Safe Systems",
    slug: "safe-systems",
  });
  const seeded = await service.execute(ctx, {
    courseId: created.courseId,
    expectedVersion: created.version,
    idempotencyKey: "seed-course",
    operations: [
      { op: "module.create", moduleId: "module_a", title: "Foundations" },
      {
        op: "lesson.create",
        moduleId: "module_a",
        lessonId: "lesson_a",
        title: "Start Here",
        slug: "start-here",
      },
      {
        op: "block.insert",
        lessonId: "lesson_a",
        position: 0,
        blocks: [{ type: "paragraph", content: [{ text: "Begin with one safe step." }] }],
      },
    ],
  });
  return { ctx, course: seeded.course };
}

test("plain-text and Markdown imports are deterministic and sanitize HTML", () => {
  const unsafe = "Hello <script>steal()</script>world\n\nSecond paragraph";
  const first = importPlainText(unsafe, "import:one");
  const second = importPlainText(unsafe, "import:one");
  assert.deepEqual(first, second);
  assert.equal(first.blocks.length, 2);
  assert.equal(JSON.stringify(first.blocks).includes("steal"), false);
  assert.equal(sanitizeHtmlToPlainText("<b>safe</b><iframe>bad</iframe>"), "safe");

  const markdown = importMarkdown(
    "# Heading\n\n- First\n- Second\n\n> A quote\n\n```ts\nconst ok = true;\n```",
    "markdown:one",
  );
  assert.deepEqual(
    markdown.blocks.map((block) => block.type),
    ["heading", "list", "quote", "code"],
  );
  assert.equal(markdown.warnings.length, 0);
});

test("module, lesson, and block operations preserve contiguous explicit ordering", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const ctx = context();
  const created = await service.create(ctx, {
    idempotencyKey: "create-ordering",
    title: "Ordering",
    slug: "ordering",
  });
  const assembled = await service.execute(ctx, {
    courseId: created.courseId,
    expectedVersion: 1,
    idempotencyKey: "assemble-ordering",
    operations: [
      { op: "module.create", moduleId: "m1", title: "One" },
      { op: "module.create", moduleId: "m2", title: "Two", position: 0 },
      { op: "lesson.create", moduleId: "m1", lessonId: "l1", title: "One", slug: "one" },
      { op: "lesson.create", moduleId: "m1", lessonId: "l2", title: "Two", slug: "two", position: 0 },
      {
        op: "block.insert",
        lessonId: "l1",
        position: 0,
        blocks: [
          { type: "paragraph", content: [{ text: "A" }] },
          { type: "paragraph", content: [{ text: "B" }] },
          { type: "paragraph", content: [{ text: "C" }] },
        ],
      },
    ],
  });
  assert.deepEqual(
    assembled.course.modules.map((module) => [module.moduleId, module.position]),
    [
      ["m2", 0],
      ["m1", 1],
    ],
  );
  assert.deepEqual(
    assembled.course.modules[1]!.lessons.map((lesson) => [lesson.lessonId, lesson.position]),
    [
      ["l2", 0],
      ["l1", 1],
    ],
  );
  const l1 = assembled.course.modules[1]!.lessons[1]!;
  const moved = await service.execute(ctx, {
    courseId: created.courseId,
    expectedVersion: assembled.course.version,
    idempotencyKey: "move-ordering",
    operations: [
      { op: "block.move", lessonId: "l1", blockId: l1.blocks[2]!.id, position: 0 },
      {
        op: "block.update",
        lessonId: "l1",
        blockId: l1.blocks[1]!.id,
        block: { type: "heading", level: 2, content: [{ text: "<b>Updated</b>" }] },
      },
      { op: "block.delete", lessonId: "l1", blockIds: [l1.blocks[0]!.id] },
    ],
  });
  const blocks = moved.course.modules[1]!.lessons[1]!.blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.id, l1.blocks[2]!.id);
  assert.equal(blocks[1]!.type, "heading");
  assert.equal(JSON.stringify(blocks).includes("<b>"), false);
});

test("optimistic version checks reject concurrent editors without a lost update", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const { ctx, course } = await createPopulatedCourse(service);
  const commands = ["Editor A", "Editor B"].map((title, index) =>
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: `concurrent-${index}`,
      operations: [{ op: "course.update", patch: { title } }],
    }),
  );
  const results = await Promise.allSettled(commands);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(isCode("authoring.version_conflict")(rejected.reason));
  const current = await service.getCourse(ctx, course.courseId);
  assert.equal(current.version, course.version + 1);
});

test("tenant scope is enforced for reads and diagram candidate approval", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const { ctx, course } = await createPopulatedCourse(service, "tenant_alpha");
  await assert.rejects(
    service.getCourse(context("tenant_beta"), course.courseId),
    isCode("authoring.not_found"),
  );
  await assert.rejects(
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: "foreign-diagram",
      operations: [
        {
          op: "diagram.approve",
          lessonId: "lesson_a",
          position: 1,
          candidate: {
            candidateId: "candidate_1",
            tenantId: "tenant_beta",
            assetId: "asset_1",
          },
          altText: "A meaningful visual flow",
          caption: "The learning flow.",
        },
      ],
    }),
    isCode("authoring.tenant_mismatch"),
  );
});

test("unsafe rich-text links and embeds are rejected before a revision commits", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository, {
    urlPolicy: {
      allowedLinkProtocols: ["https:", "mailto:"],
      allowedEmbedHosts: ["youtube.com", "vimeo.com"],
      allowSubdomains: true,
    },
  });
  const { ctx, course } = await createPopulatedCourse(service);
  await assert.rejects(
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: "unsafe-link",
      operations: [
        {
          op: "block.insert",
          lessonId: "lesson_a",
          position: 1,
          blocks: [
            {
              type: "paragraph",
              content: [{ text: "click", href: "javascript:alert(1)" }],
            },
          ],
        },
      ],
    }),
    isCode("authoring.invalid_input"),
  );
  await assert.rejects(
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: "unsafe-embed",
      operations: [
        {
          op: "block.insert",
          lessonId: "lesson_a",
          position: 1,
          blocks: [
            {
              type: "embed",
              provider: "custom",
              url: "https://127.0.0.1/private",
            },
          ],
        },
      ],
    }),
    isCode("authoring.invalid_input"),
  );
  await assert.rejects(
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: "invalid-schema",
      operations: [
        {
          op: "block.insert",
          lessonId: "lesson_a",
          position: 1,
          blocks: [
            {
              type: "list",
              style: "bullet",
              items: undefined,
            } as never,
          ],
        },
      ],
    }),
    isCode("authoring.invalid_input"),
  );
  const unchanged = await service.getCourse(ctx, course.courseId);
  assert.equal(unchanged.version, course.version);
});

test("diagrams require tenant-bound approval, alt text, and captions before publish", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const { ctx, course } = await createPopulatedCourse(service);
  await assert.rejects(
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: "diagram-no-alt",
      operations: [
        {
          op: "diagram.approve",
          lessonId: "lesson_a",
          position: 1,
          candidate: {
            candidateId: "candidate_1",
            tenantId: ctx.tenantId,
            assetId: "asset_1",
          },
          altText: "",
          caption: "A visual.",
        },
      ],
    }),
    isCode("authoring.validation_failed"),
  );
  await assert.rejects(
    service.execute(ctx, {
      courseId: course.courseId,
      expectedVersion: course.version,
      idempotencyKey: "diagram-spoofed-approval",
      operations: [
        {
          op: "block.insert",
          lessonId: "lesson_a",
          position: 1,
          blocks: [
            {
              type: "diagram",
              assetId: "asset_spoofed",
              altText: "A plausible but unreviewed diagram",
              caption: "Not actually approved.",
              metadata: {
                approvalStatus: "approved",
                diagramCandidateId: "spoofed",
              },
            },
          ],
        },
      ],
    }),
    isCode("authoring.validation_failed"),
  );
  const approved = await service.execute(ctx, {
    courseId: course.courseId,
    expectedVersion: course.version,
    idempotencyKey: "diagram-approved",
    operations: [
      {
        op: "diagram.approve",
        lessonId: "lesson_a",
        position: 1,
        candidate: {
          candidateId: "candidate_1",
          tenantId: ctx.tenantId,
          assetId: "asset_1",
        },
        altText: "Three steps connected from intake to publication",
        caption: "Course publication flow.",
      },
    ],
  });
  const published = await service.publish(ctx, {
    courseId: course.courseId,
    expectedVersion: approved.course.version,
    idempotencyKey: "publish-approved",
    auditNote: "Approved by course owner.",
  });
  assert.equal(published.status, "published");
  assert.equal(published.modules[0]!.lessons[0]!.status, "published");

  const diagram = published.modules[0]!.lessons[0]!.blocks[1]!;
  assert.equal(diagram.type, "diagram");
  assert.equal(diagram.metadata?.approvalStatus, "approved");
  assert.equal(validateCourse(published, "publish").valid, true);
});

test("draft validation blocks incomplete publication and editing a publication reopens a draft", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const ctx = context();
  const empty = await service.create(ctx, {
    idempotencyKey: "create-empty",
    title: "Incomplete",
    slug: "incomplete",
  });
  const draftValidation = await service.validate(ctx, empty.courseId);
  assert.equal(draftValidation.valid, true);
  assert.equal(
    draftValidation.issues.some((issue) => issue.code === "course.modules_required"),
    true,
  );
  await assert.rejects(
    service.publish(ctx, {
      courseId: empty.courseId,
      expectedVersion: empty.version,
      idempotencyKey: "publish-empty",
      auditNote: "Try publication.",
    }),
    isCode("authoring.validation_failed"),
  );

  const { course } = await createPopulatedCourse(service, "tenant_second");
  const secondContext = context("tenant_second");
  const published = await service.publish(secondContext, {
    courseId: course.courseId,
    expectedVersion: course.version,
    idempotencyKey: "publish-second",
    auditNote: "Ready.",
  });
  const edited = await service.execute(secondContext, {
    courseId: course.courseId,
    expectedVersion: published.version,
    idempotencyKey: "edit-publication",
    operations: [{ op: "course.update", patch: { description: "A new draft." } }],
  });
  assert.equal(edited.course.status, "draft");
  assert.equal(edited.course.publishedAt, undefined);
});

test("the existing CourseEditorService adapter handles nested adds and atomic replacement", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const ctx = context();
  const created = await service.createCourse(ctx, {
    title: "Contract Course",
    slug: "contract-course",
  });
  const edited = await service.applyEdits(ctx, {
    courseId: created.courseId,
    expectedVersion: created.version,
    idempotencyKey: "contract-nested-add",
    operations: [
      {
        op: "module.add",
        module: {
          moduleId: "contract_module",
          title: "Contract Module",
          position: 0,
          lessons: [
            {
              lessonId: "contract_lesson",
              title: "Contract Lesson",
              slug: "contract-lesson",
              position: 0,
              status: "draft",
              blocks: [
                { id: "original", type: "paragraph", content: [{ text: "Original" }] },
              ],
              sourceDocumentIds: [],
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      },
    ],
  });
  assert.equal(edited.course.modules[0]!.lessons[0]!.blocks[0]!.id, "original");
  const replaced = await service.applyEdits(ctx, {
    courseId: created.courseId,
    expectedVersion: edited.course.version,
    idempotencyKey: "contract-replace",
    operations: [
      {
        op: "blocks.replace",
        lessonId: "contract_lesson",
        blocks: [{ id: "replacement", type: "paragraph", content: [{ text: "Replacement" }] }],
      },
    ],
  });
  assert.deepEqual(
    replaced.course.modules[0]!.lessons[0]!.blocks.map((block) => block.id),
    ["replacement"],
  );
});

test("idempotent replay returns the original result and mismatched reuse conflicts", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const { ctx, course } = await createPopulatedCourse(service);
  const command = {
    courseId: course.courseId,
    expectedVersion: course.version,
    idempotencyKey: "rename-once",
    operations: [{ op: "course.update" as const, patch: { title: "Renamed once" } }],
  };
  const first = await service.execute(ctx, command);
  const replay = await service.execute(ctx, command);
  assert.deepEqual(replay, first);
  assert.equal((await service.listRevisions(ctx, course.courseId)).length, 3);

  await assert.rejects(
    service.execute(ctx, {
      ...command,
      operations: [{ op: "course.update", patch: { title: "Different payload" } }],
    }),
    isCode("authoring.idempotency_conflict"),
  );
});

test("rollback appends an immutable revision and restores an exact prior snapshot atomically", async () => {
  const repository = new InMemoryCourseAuthoringRepository();
  const service = new CourseAuthoringService(repository);
  const { ctx, course } = await createPopulatedCourse(service);
  const changed = await service.execute(ctx, {
    courseId: course.courseId,
    expectedVersion: course.version,
    idempotencyKey: "change-before-rollback",
    operations: [
      { op: "course.update", patch: { title: "Temporary title" } },
      { op: "module.create", moduleId: "temporary", title: "Temporary module" },
    ],
  });
  const before = await service.listRevisions(ctx, course.courseId);
  const rolledBack = await service.rollback(ctx, {
    courseId: course.courseId,
    expectedVersion: changed.course.version,
    targetVersion: course.version,
    idempotencyKey: "rollback-to-seeded",
    auditNote: "Restore approved structure.",
  });
  assert.equal(rolledBack.title, course.title);
  assert.equal(rolledBack.modules.length, course.modules.length);
  assert.equal(rolledBack.version, changed.course.version + 1);

  const after = await service.listRevisions(ctx, course.courseId);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.at(-1)?.kind, "rolled_back");
  assert.equal(after.at(-1)?.rollbackTargetVersion, course.version);
  assert.equal(after[1]!.snapshot.title, course.title);
  assert.equal(after[2]!.snapshot.title, "Temporary title");
});
