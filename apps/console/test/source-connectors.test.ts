import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  circleHtmlToText,
  listCircleCourses,
  readCircleCourse,
} from "../src/lib/source-connectors/circle";
import {
  YouTubeSourceError,
  parseYouTubeVideoId,
  resolveYouTubeLearningSource,
} from "../src/lib/source-connectors/youtube";

const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260730143000_learning_source_connectors.sql",
    import.meta.url,
  ),
  "utf8",
);
const component = readFileSync(
  new URL("../src/components/sections/source-connectors.tsx", import.meta.url),
  "utf8",
);
const blankWorkspaceMigration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731022436_blank_workspace_source_courses.sql",
    import.meta.url,
  ),
  "utf8",
);
const sourceHardeningMigration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731032824_harden_course_source_boundaries.sql",
    import.meta.url,
  ),
  "utf8",
);
const youtubeRoute = readFileSync(
  new URL(
    "../src/app/api/learning/connectors/youtube/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const circleRoute = readFileSync(
  new URL(
    "../src/app/api/learning/connectors/circle/route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("YouTube IDs are accepted only from known YouTube URL shapes", () => {
  assert.equal(
    parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  assert.equal(
    parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10"),
    "dQw4w9WgXcQ",
  );
  assert.throws(
    () => parseYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"),
    /invalid_youtube_url/u,
  );
});

test("YouTube sync returns real oEmbed metadata and caption transcript", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/oembed?")) {
      return Response.json({
        title: "Tenant-safe learning",
        author_name: "Course team",
      });
    }
    if (url.includes("timedtext")) {
      return Response.json({
        events: [
          { tStartMs: 0, segs: [{ utf8: "Welcome to the course." }] },
          { tStartMs: 62000, segs: [{ utf8: "Now tenant boundaries." }] },
        ],
      });
    }
    return new Response(
      `<script>var x={"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ","languageCode":"en","name":{"simpleText":"English"}}]};</script>`,
    );
  }) as typeof fetch;

  const result = await resolveYouTubeLearningSource(
    "https://youtu.be/dQw4w9WgXcQ",
    fetcher,
  );
  assert.equal(result.title, "Tenant-safe learning");
  assert.match(result.document.body, /^\[0:00\] Welcome/u);
  assert.match(result.document.body, /\[1:02\] Now tenant boundaries/u);
  assert.match(result.contentHash, /^[0-9a-f]{64}$/u);
  assert.equal(
    requests.every((url) => new URL(url).hostname === "www.youtube.com"),
    true,
  );
});

test("YouTube sync refuses videos without captions", async () => {
  const fetcher = (async (input: string | URL | Request) =>
    String(input).includes("/oembed?")
      ? Response.json({ title: "No captions", author_name: "Course team" })
      : new Response("<html>captions disabled</html>")) as typeof fetch;
  await assert.rejects(
    resolveYouTubeLearningSource("dQw4w9WgXcQ", fetcher),
    (error: unknown) =>
      error instanceof YouTubeSourceError &&
      error.code === "captions_unavailable",
  );
});

test("YouTube caption fetches cannot escape the fixed provider origin", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/oembed?")) {
      return Response.json({
        title: "Unsafe caption target",
        author_name: "Course team",
      });
    }
    return new Response(
      `<script>var x={"captionTracks":[{"baseUrl":"https://127.0.0.1/internal","languageCode":"en"}]};</script>`,
    );
  }) as typeof fetch;
  await assert.rejects(
    resolveYouTubeLearningSource("dQw4w9WgXcQ", fetcher),
    (error: unknown) =>
      error instanceof YouTubeSourceError &&
      error.code === "captions_unavailable",
  );
  assert.equal(
    requested.some((url) => new URL(url).hostname === "127.0.0.1"),
    false,
  );
});

test("Circle calls only the fixed Admin API host with Token authorization", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    const path = new URL(url).pathname;
    if (path.endsWith("/spaces")) {
      return Response.json({
        records: [
          {
            id: 17,
            name: "Onboarding",
            slug: "onboarding",
            url: "https://community.example/c/onboarding",
            space_type: "course",
            course_setting: {},
          },
        ],
      });
    }
    if (path.endsWith("/course_sections")) {
      return Response.json({ records: [{ id: 9, name: "Start here" }] });
    }
    return Response.json({
      records: [
        {
          id: 25,
          name: "Welcome",
          status: "published",
          section_id: 9,
          body_html:
            "<script>never store me</script><h2>Hello</h2><p>Real &amp; useful.</p>",
          updated_at: "2026-07-30T10:00:00Z",
        },
      ],
    });
  }) as typeof fetch;

  const choices = await listCircleCourses("secret-circle-token-value", fetcher);
  assert.deepEqual(choices.map((choice) => choice.name), ["Onboarding"]);
  const course = await readCircleCourse(
    "secret-circle-token-value",
    "17",
    fetcher,
  );
  assert.equal(course.documents.length, 1);
  assert.match(course.documents[0]!.body, /Start here\n\nHello\nReal & useful\./u);
  assert.doesNotMatch(course.documents[0]!.body, /never store me/u);
  for (const request of requests) {
    assert.equal(new URL(request.url).origin, "https://app.circle.so");
    assert.equal(request.authorization, "Token secret-circle-token-value");
    assert.doesNotMatch(request.url, /secret-circle-token-value/u);
  }
});

test("Circle HTML cleaning removes active markup and decodes text", () => {
  assert.equal(
    circleHtmlToText(
      "<style>.x{}</style><p>One&nbsp;&amp;&nbsp;two</p><li>Three</li>",
    ),
    "One & two\n• Three",
  );
});

test("connector migration is tenant-bound, Vault-backed and service-only", () => {
  assert.match(
    migration,
    /alter table app_private\.learning_source_connections enable row level security;/u,
  );
  assert.match(
    migration,
    /alter table app_private\.learning_source_connections force row level security;/u,
  );
  assert.match(
    migration,
    /supabase_auth_context_for_user\(caller_auth_user_id\)/u,
  );
  assert.match(
    migration,
    /caller\.tenant_id <> target_tenant_id/u,
  );
  assert.match(migration, /vault\.create_secret/u);
  assert.match(migration, /vault\.decrypted_secrets/u);
  assert.match(
    migration,
    /grant execute on function public\.learning_source_connector_sync\([\s\S]*?\) to service_role;/u,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.learning_source_connector_sync\([\s\S]*?\) to authenticated;/u,
  );
  assert.match(
    migration,
    /where c\.tenant_id = target_tenant_id[\s\S]*?and c\.course_id = target_course_id/u,
  );
  assert.match(
    migration,
    /on conflict \(tenant_id, course_id, source_type, external_ref\)/u,
  );
  assert.match(
    migration,
    /'contentHash', source_content_hash/u,
  );
  assert.doesNotMatch(
    migration,
    /kv\.content_hash = source_content_hash/u,
  );
  assert.match(
    migration,
    /if not replace_active_knowledge[\s\S]*?active_version\.knowledge_version_id is not null[\s\S]*?d\.source_id <> resolved_source_id/u,
  );
  assert.match(
    migration,
    /next_source_manifest := next_source_manifest \|\| jsonb_build_array/u,
  );
  assert.match(
    migration,
    /jsonb_agg\(entry\.value order by[\s\S]*?entry\.value ->> 'sourceId'/u,
  );
  assert.match(
    migration,
    /active_knowledge_version_id = new_version_id/u,
  );
  assert.match(
    migration,
    /set status = 'retired'[\s\S]*?kv\.knowledge_version_id = active_version\.knowledge_version_id/u,
  );
  assert.match(
    migration,
    /kv\.knowledge_version_id = active_version\.knowledge_version_id[\s\S]*?or kv\.source_manifest @>/u,
  );
  assert.equal(migration.match(/doc_body := btrim/gu)?.length, 2);
});

test("connector UI supports verified-source creation in a blank workspace", () => {
  assert.match(component, /Create a new course from this source/u);
  assert.doesNotMatch(component, /Create a course before connecting a source/u);
  assert.doesNotMatch(component, /Estie/iu);
  assert.match(component, /if \(!response\.ok \|\| payload\.ok !== true\)/u);
  assert.match(component, /videos without accessible captions are refused/iu);
  assert.match(youtubeRoute, /resolveYouTubeLearningSource[\s\S]*?learning_create_source_course/u);
  assert.match(circleRoute, /readCircleCourse[\s\S]*?learning_create_source_course/u);
});

test("blank-workspace destination creation inserts no sample knowledge", () => {
  assert.match(
    blankWorkspaceMigration,
    /create or replace function public\.learning_create_source_course/u,
  );
  assert.match(blankWorkspaceMigration, /'lessonCount', 0/u);
  assert.doesNotMatch(blankWorkspaceMigration, /insert into public\.lessons/iu);
  assert.doesNotMatch(blankWorkspaceMigration, /insert into public\.documents/iu);
  assert.match(
    blankWorkspaceMigration,
    /grant execute on function public\.learning_create_source_course\([\s\S]*?\) to authenticated;/u,
  );
});

test("source hardening aligns author roles and binds Circle Vault refs to the tenant", () => {
  assert.match(
    sourceHardeningMigration,
    /select \* into caller from app_private\.authoring_rpc_context\(\)/u,
  );
  assert.doesNotMatch(sourceHardeningMigration, /'teacher'/u);
  assert.match(
    sourceHardeningMigration,
    /connection\.tenant_id = target_tenant_id/u,
  );
  assert.match(
    sourceHardeningMigration,
    /'vault:\/\/' \|\| connection\.vault_secret_id::text =\s*source_credential_vault_ref/u,
  );
  assert.match(
    sourceHardeningMigration,
    /grant execute on function public\.learning_source_connector_sync\([\s\S]*?\) to service_role;/u,
  );
  assert.doesNotMatch(
    sourceHardeningMigration,
    /grant execute on function public\.learning_source_connector_sync\([\s\S]*?\) to authenticated;/u,
  );
});

/* ------------------------------------------- imported courses can publish */

const publishImportedMigration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731071000_publish_imported_source_courses.sql",
    import.meta.url,
  ),
  "utf8",
);

test("publishing accepts imported knowledge, not only hand-authored lessons", () => {
  // The gate that made every connector import a dead end: a course created by
  // `learning_create_source_course` has zero lessons and zero content blocks,
  // so the authored-content check raised unconditionally and the course could
  // never leave 'draft' — while retrieval requires 'published'.
  assert.match(publishImportedMigration, /has_authored_content := exists \(/u);
  assert.match(publishImportedMigration, /has_imported_knowledge := exists \(/u);
  assert.match(
    publishImportedMigration,
    /if not has_authored_content and not has_imported_knowledge then/u,
  );
  assert.match(
    publishImportedMigration,
    /raise check_violation using message = 'Course has no publishable content';/u,
  );
});

test("imported knowledge only unlocks a publish when it is live and active", () => {
  // Anything weaker would let a retired or superseded import publish a course
  // that then answers nothing.
  for (const predicate of [
    "kv.knowledge_version_id = c.active_knowledge_version_id",
    "and kv.deleted_at is null",
    "and kv.status = 'published'",
    "and ch.deleted_at is null",
  ]) {
    assert.ok(
      publishImportedMigration.includes(predicate),
      `the imported-knowledge gate dropped ${predicate}`,
    );
  }
});

test("an import-only publish does not mint an empty authored knowledge version", () => {
  assert.match(publishImportedMigration, /if has_authored_content then/u);
  assert.match(
    publishImportedMigration,
    /projection := app_private\.knowledge_project_course\(/u,
  );
  assert.match(
    publishImportedMigration,
    /projection := app_private\.knowledge_active_version_state\(/u,
  );
});

test("publishing stays an authenticated, authored act", () => {
  assert.match(
    publishImportedMigration,
    /revoke execute on function public\.learning_publish_course\(uuid, text\)\s*from public, anon, service_role;/u,
  );
  assert.match(
    publishImportedMigration,
    /grant execute on function public\.learning_publish_course\(uuid, text\)\s*to authenticated;/u,
  );
  // The connector still must not publish anything by itself.
  assert.doesNotMatch(migration, /set status = 'published'[\s\S]{0,80}public\.courses/u);
});

test("the connector stops calling an unpublished import answerable", () => {
  assert.match(
    publishImportedMigration,
    /'activationBlockedReason', 'course_not_published'/u,
  );
  assert.match(publishImportedMigration, /'retrievable', false/u);
  assert.match(publishImportedMigration, /and c\.status = 'published'/u);
  // A refusal must be passed through untouched rather than rewritten.
  assert.match(
    publishImportedMigration,
    /when coalesce\(\(projected\.result ->> 'ok'\)::boolean, false\) is not true\s*then projected\.result/u,
  );
});

test("the connector panel tells the creator what actually unblocks the import", () => {
  assert.match(component, /activationBlockedReason/u);
  assert.match(
    component,
    /"Imported — publish this course to make it answerable"/u,
  );
  assert.match(
    component,
    /Publish the course to let the assistant answer from it\./u,
  );
});
