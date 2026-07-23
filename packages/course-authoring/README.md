# `@course-ai/course-authoring`

Provider-neutral, tenant-scoped course authoring over the shared
`@course-ai/contracts` `CourseDraft`, `CourseModule`, `CourseLesson`, and
`ContentBlock` types.

## What this package owns

- deterministic course, module, lesson, block, list-item, and revision ids;
- course/module/lesson create, update, order, move, and delete commands;
- content block insert, update, move, delete, and atomic replace commands;
- optimistic course-version compare-and-swap;
- tenant-bound, fingerprinted idempotency receipts;
- schema and publishing validation;
- rich-text cleaning, safe link protocols, HTTPS-only embeds, private-network
  embed/link rejection, and optional embed-host allowlists;
- plain-text and core Markdown import;
- explicit diagram-candidate approval with tenant, alt-text, and caption checks;
- immutable revision snapshots and append-only rollback revisions; and
- compatibility with the existing `CourseEditorService` contract.

The package contains no LLM, diagram, storage, or database provider calls.

## Integration

```ts
import {
  CourseAuthoringService,
  InMemoryCourseAuthoringRepository,
} from "@course-ai/course-authoring";

const authoring = new CourseAuthoringService(
  new InMemoryCourseAuthoringRepository(),
  {
    urlPolicy: {
      allowedLinkProtocols: ["https:", "mailto:"],
      allowedEmbedHosts: ["youtube.com", "vimeo.com"],
      allowSubdomains: true,
    },
  },
);

const course = await authoring.create(context, {
  idempotencyKey: "course:create:welcome-v1",
  title: "Welcome",
  slug: "welcome",
});

const result = await authoring.execute(context, {
  courseId: course.courseId,
  expectedVersion: course.version,
  idempotencyKey: "course:welcome:add-first-module",
  operations: [
    { op: "module.create", title: "Start here" },
  ],
});
```

Primary integration APIs:

- `create`, `execute`, `publish`, `rollback`, `listRevisions`;
- `createCourse`, `getCourse`, `applyEdits`, `validate`, `publishCourse` for the
  shared `CourseEditorService` shape;
- `importPlainText`, `importMarkdown`;
- `sanitizeBlock`, `sanitizeLinkUrl`, `sanitizeEmbedUrl`; and
- `CourseAuthoringRepository`, with `InMemoryCourseAuthoringRepository` for
  deterministic tests and local development.

An edit to a published course creates a new draft state and removes
`publishedAt`; it never presents the edited state as already published.
Rollback restores the selected snapshot as a **new** monotonically increasing
version, preserving every intervening revision.

## Durable adapter contract

A production repository must atomically:

1. scope every lookup by `(tenant_id, course_id)`;
2. compare the stored version with `expectedVersion`;
3. write the next course version;
4. append its immutable revision; and
5. insert the `(tenant_id, idempotency_key)` receipt with a unique constraint.

The entire sequence must be one database transaction. Enforce tenant RLS in
addition to the service guard. Store revisions and receipts append-only and
emit audit/outbox records in that same transaction.

## Deliberate remaining gaps

- The included repository is process-local and is not a production persistence
  adapter. It demonstrates the atomic contract but does not survive restarts.
- Authentication and trusted tenant resolution happen upstream; this package
  accepts only a boundary-authorized `RequestContext` and applies an additional
  creator/owner/system role guard.
- Serving an old published version while a new draft is edited requires the
  platform's separate versioned publication pointer/store. This package marks
  the authoring copy as draft but does not host the learner read model.
- Diagram candidate generation and asset existence/scanning belong to the
  learning pipeline and asset service. This package verifies tenant ownership
  supplied in the approval command and records approval metadata.
- Markdown import intentionally covers safe core structures rather than
  executing arbitrary HTML or plugin extensions.
- Callers must still render all text using framework escaping and apply a
  browser Content Security Policy; input sanitization is not an output-encoding
  substitute.
- Collaborative CRDT/OT editing is not included. Editors receive explicit
  version conflicts and must refresh/rebase.

## Verification

```sh
pnpm --filter @course-ai/course-authoring typecheck
pnpm --filter @course-ai/course-authoring build
pnpm --filter @course-ai/course-authoring test
```

The tests cover deterministic import and sanitization, ordering, concurrent
edit conflict, tenant isolation, unsafe links/embeds, diagram accessibility,
draft/publish transitions, shared-contract adaptation, idempotent replay and
payload conflict, immutable history, and atomic rollback.
