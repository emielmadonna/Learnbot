#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultSourceRoot = "/Users/emielmadonna/Estie Starr/scraper";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const sourceRoot = resolve(args.get("--source") ?? defaultSourceRoot);
const requestedBatch = Number(args.get("--batch") ?? "-1");
const claimTokenSha256 = args.get("--claim-token-sha256") ?? "";
const chunksPerBatch = 100;

if (
  !Number.isInteger(requestedBatch) ||
  requestedBatch < -1 ||
  (requestedBatch === 0 && !/^[0-9a-f]{64}$/u.test(claimTokenSha256))
) {
  throw new Error(
    "Use --batch <number>; batch 0 also requires --claim-token-sha256 <sha256>.",
  );
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(value) {
  const bytes = Buffer.from(hash(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text = bytes.toString("hex");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function sql(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return `${sql(JSON.stringify(value))}::jsonb`;
}

function titleCase(slug) {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function preview(text) {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= 1800) return clean;
  const boundary = clean.lastIndexOf(" ", 1800);
  return `${clean.slice(0, boundary > 1200 ? boundary : 1800)}…`;
}

const rawChunks = (
  await readFile(resolve(sourceRoot, "chunks.jsonl"), "utf8")
)
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const courses = new Map();
for (const chunk of rawChunks) {
  const course = courses.get(chunk.course_slug) ?? {
    slug: chunk.course_slug,
    name: chunk.course_name || titleCase(chunk.course_slug),
    sections: new Map(),
  };
  const sectionKey = chunk.section_name || "Course lessons";
  const section = course.sections.get(sectionKey) ?? {
    name: sectionKey,
    lessons: new Map(),
  };
  const lessonKey = String(chunk.lesson_id);
  const lesson = section.lessons.get(lessonKey) ?? {
    externalId: lessonKey,
    title: chunk.lesson_name || `Lesson ${lessonKey}`,
    chunks: [],
  };
  lesson.chunks.push(chunk);
  section.lessons.set(lessonKey, lesson);
  course.sections.set(sectionKey, section);
  courses.set(chunk.course_slug, course);
}

const sortedCourses = [...courses.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);
for (const course of sortedCourses) {
  course.sections = new Map(
    [...course.sections.entries()].sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true }),
    ),
  );
  for (const section of course.sections.values()) {
    section.lessons = new Map(
      [...section.lessons.entries()].sort(([left], [right]) =>
        left.localeCompare(right, undefined, { numeric: true }),
      ),
    );
    for (const lesson of section.lessons.values()) {
      lesson.chunks.sort((left, right) => left.chunk_index - right.chunk_index);
    }
  }
}

const tenantId = uuid("learningbot:tenant:estie-starr");
const setupStatements = [
  "begin",
  `insert into public.tenants (tenant_id, slug, display_name, status, region, settings, idempotency_key)
   values (${sql(tenantId)}, 'estie-starr', 'Estie Starr', 'provisioning', 'us-east-1',
     ${json({
       planId: "enterprise",
       locale: "en-US",
       timeZone: "America/Los_Angeles",
       sourceProvenance: "authorized_legacy_estie_starr",
     })},
     'estie-import:tenant')
   on conflict (tenant_id) do update set
     display_name = excluded.display_name,
     settings = public.tenants.settings || excluded.settings`,
  `insert into public.roles (
     tenant_id, role_key, display_name, capabilities, idempotency_key
   )
   select ${sql(tenantId)}, seed.role_key, seed.display_name, seed.capabilities,
     'estie-import:role:' || seed.role_key
   from (values
     ('owner', 'Owner', array['tenant.*']::text[]),
     ('client_admin', 'Client administrator', array['tenant.manage']::text[]),
     ('client_viewer', 'Client viewer', array['tenant.read']::text[]),
     ('student', 'Student', array['learning.read']::text[]),
     ('system_worker', 'System worker', array['system.execute']::text[])
   ) seed(role_key, display_name, capabilities)
   on conflict (tenant_id, role_key) do update set
     display_name = excluded.display_name,
     capabilities = excluded.capabilities`,
  `insert into public.tenant_branding (
     tenant_id, status, version_number, assistant_name, primary_color,
     accent_color, surface_color, text_color, welcome_message,
     voice_configuration, privacy_copy, idempotency_key, published_at
   ) values (
     ${sql(tenantId)}, 'published', 1, 'Estie', '#234F40', '#D2A85F',
     '#F5F4EF', '#14231D',
     'Tell me what you are working on, and we will turn it into the next clear action.',
     ${json({
       status: "provider_configuration_required",
       rawAudioStoredByDefault: false,
       legacyVoiceSamplesImported: false,
     })},
     'Your learning activity stays inside the Estie Starr workspace.',
     'estie-import:branding:v1', now()
   )
   on conflict (tenant_id, version_number) do update set
     assistant_name = excluded.assistant_name,
     primary_color = excluded.primary_color,
     accent_color = excluded.accent_color,
     surface_color = excluded.surface_color,
     text_color = excluded.text_color,
     welcome_message = excluded.welcome_message,
     voice_configuration = excluded.voice_configuration,
     privacy_copy = excluded.privacy_copy`,
  `insert into public.onboarding_workspaces (
     tenant_id, status, circle_plan, expected_identity_mode, idempotency_key
   ) values (
     ${sql(tenantId)}, 'in_progress', 'unconfirmed', 'unconfirmed',
     'estie-import:onboarding'
   )
   on conflict (tenant_id) do nothing`,
  `insert into public.onboarding_steps (
     tenant_id, onboarding_id, step_key, status, required, idempotency_key
   )
   select ${sql(tenantId)}, w.onboarding_id, seed.step_key, 'not_started', true,
     'estie-import:onboarding-step:' || seed.step_key
   from public.onboarding_workspaces w
   cross join (values
     ('tenant_profile'), ('identity_mode'), ('provider_funding'),
     ('source_ingestion'), ('assistant_voice_guide'), ('diagram_review'),
     ('context_mapping'), ('widget_branding'), ('privacy_consent'),
     ('recording_policy'), ('retention_policy'), ('playground_qa'),
     ('install_verification'), ('client_handoff')
   ) seed(step_key)
   where w.tenant_id = ${sql(tenantId)}
   on conflict (tenant_id, onboarding_id, step_key) do nothing`,
  `insert into app_private.tenant_owner_claims (
     tenant_id, token_sha256, status, expires_at
   ) values (
     ${sql(tenantId)}, ${sql(claimTokenSha256)}, 'pending',
     now() + interval '72 hours'
   )
   on conflict (tenant_id) do update set
     token_sha256 = excluded.token_sha256,
     status = case
       when app_private.tenant_owner_claims.status = 'claimed'
         then app_private.tenant_owner_claims.status
       else 'pending'
     end,
     expires_at = case
       when app_private.tenant_owner_claims.status = 'claimed'
         then app_private.tenant_owner_claims.expires_at
       else excluded.expires_at
     end,
     updated_at = now()`,
  "commit",
];

const hierarchyStatements = ["begin"];
const chunkRows = [];
for (const course of sortedCourses) {
  const courseId = uuid(`learningbot:estie:course:${course.slug}`);
  const sourceId = uuid(`learningbot:estie:source:${course.slug}`);
  const versionId = uuid(`learningbot:estie:knowledge:${course.slug}:v1`);
  hierarchyStatements.push(
    `insert into public.courses (
       course_id, tenant_id, external_id, title, description, status,
       metadata, idempotency_key, published_at
     ) values (
       ${sql(courseId)}, ${sql(tenantId)}, ${sql(course.slug)}, ${sql(course.name)},
       ${sql(`Learn Estie Starr's ${course.name} frameworks from the authorized course library, with lesson-level source grounding.`)},
       'published',
       ${json({
         source: "authorized_legacy_estie_starr",
         importVersion: 1,
       })},
       ${sql(`estie-import:course:${course.slug}`)}, now()
     )
     on conflict (course_id) do update set
       title = excluded.title,
       description = excluded.description,
       status = 'published',
       metadata = public.courses.metadata || excluded.metadata`,
    `insert into public.learning_sources (
       source_id, tenant_id, course_id, source_type, name, status,
       external_ref, configuration, last_synced_at, idempotency_key
     ) values (
       ${sql(sourceId)}, ${sql(tenantId)}, ${sql(courseId)}, 'api',
       ${sql(`${course.name} legacy transcript library`)}, 'ready',
       ${sql(`legacy-estie-starr:${course.slug}`)},
       ${json({
         sourceKind: "authorized_cleaned_transcripts",
         secretMaterialImported: false,
         rawRecordingsImported: false,
       })},
       now(), ${sql(`estie-import:source:${course.slug}`)}
     )
     on conflict (source_id) do update set
       status = 'ready',
       last_synced_at = excluded.last_synced_at,
       configuration = excluded.configuration`,
    `insert into public.knowledge_versions (
       knowledge_version_id, tenant_id, course_id, version_number, status,
       source_manifest, content_hash, embedding_provider_key,
       embedding_model_key, embedding_dimensions, idempotency_key, published_at
     ) values (
       ${sql(versionId)}, ${sql(tenantId)}, ${sql(courseId)}, 1, 'published',
       ${json([
         {
           source: `legacy-estie-starr:${course.slug}`,
           kind: "authorized_cleaned_transcripts",
         },
       ])},
       ${sql(hash(course.slug + [...course.sections.values()].flatMap((section) => [...section.lessons.keys()]).join("|")))},
       null, null, null, ${sql(`estie-import:knowledge:${course.slug}:v1`)},
       now()
     )
     on conflict (knowledge_version_id) do update set
       status = 'published',
       source_manifest = excluded.source_manifest,
       published_at = coalesce(public.knowledge_versions.published_at, now())`,
    `update public.courses set
       active_knowledge_version_id = ${sql(versionId)}
     where tenant_id = ${sql(tenantId)} and course_id = ${sql(courseId)}`,
  );

  let modulePosition = 0;
  for (const [sectionKey, section] of course.sections) {
    const moduleId = uuid(
      `learningbot:estie:module:${course.slug}:${sectionKey}`,
    );
    hierarchyStatements.push(
      `insert into public.modules (
         module_id, tenant_id, course_id, external_id, title, position,
         status, metadata, idempotency_key
       ) values (
         ${sql(moduleId)}, ${sql(tenantId)}, ${sql(courseId)},
         ${sql(sectionKey)}, ${sql(section.name)}, ${modulePosition},
         'published', '{}'::jsonb,
         ${sql(`estie-import:module:${course.slug}:${hash(sectionKey).slice(0, 16)}`)}
       )
       on conflict (module_id) do update set
         title = excluded.title,
         position = excluded.position,
         status = 'published'`,
    );
    let lessonPosition = 0;
    for (const lesson of section.lessons.values()) {
      const lessonId = uuid(
        `learningbot:estie:lesson:${course.slug}:${lesson.externalId}`,
      );
      const documentId = uuid(
        `learningbot:estie:document:${course.slug}:${lesson.externalId}`,
      );
      const completeText = lesson.chunks.map((chunk) => chunk.text).join("\n\n");
      hierarchyStatements.push(
        `insert into public.lessons (
           lesson_id, tenant_id, course_id, module_id, external_id, title,
           position, status, metadata, idempotency_key
         ) values (
           ${sql(lessonId)}, ${sql(tenantId)}, ${sql(courseId)}, ${sql(moduleId)},
           ${sql(lesson.externalId)}, ${sql(lesson.title)}, ${lessonPosition},
           'published',
           ${json({
             source: "authorized_legacy_estie_starr",
             legacyLessonId: lesson.externalId,
             chunkCount: lesson.chunks.length,
           })},
           ${sql(`estie-import:lesson:${course.slug}:${lesson.externalId}`)}
         )
         on conflict (lesson_id) do update set
           title = excluded.title,
           position = excluded.position,
           status = 'published',
           metadata = excluded.metadata`,
        `insert into public.content_blocks (
           content_block_id, tenant_id, course_id, lesson_id, block_type,
           position, content, content_hash, idempotency_key
         ) values (
           ${sql(uuid(`learningbot:estie:block:${course.slug}:${lesson.externalId}:0`))},
           ${sql(tenantId)}, ${sql(courseId)}, ${sql(lessonId)},
           'transcript_excerpt', 0,
           ${json({
             text: preview(lesson.chunks[0]?.text ?? ""),
             format: "plain_text",
             sourceLabel: `${course.name} · ${lesson.title}`,
             sourceStart: lesson.chunks[0]?.start_hms ?? null,
           })},
           ${sql(hash(preview(lesson.chunks[0]?.text ?? "")))},
           ${sql(`estie-import:block:${course.slug}:${lesson.externalId}:0`)}
         )
         on conflict (content_block_id) do update set
           content = excluded.content,
           content_hash = excluded.content_hash`,
        `insert into public.learning_documents (
           document_id, tenant_id, course_id, source_id, knowledge_version_id,
           external_id, title, media_type, language, content_hash, status,
           metadata, idempotency_key
         ) values (
           ${sql(documentId)}, ${sql(tenantId)}, ${sql(courseId)}, ${sql(sourceId)},
           ${sql(versionId)}, ${sql(lesson.externalId)}, ${sql(lesson.title)},
           'text/markdown', 'en', ${sql(hash(completeText))}, 'ready',
           ${json({
             source: "authorized_legacy_estie_starr",
             section: section.name,
             chunkCount: lesson.chunks.length,
           })},
           ${sql(`estie-import:document:${course.slug}:${lesson.externalId}`)}
         )
         on conflict (document_id) do update set
           title = excluded.title,
           content_hash = excluded.content_hash,
           status = 'ready',
           metadata = excluded.metadata`,
      );
      for (const chunk of lesson.chunks) {
        chunkRows.push({
          tenantId,
          courseId,
          versionId,
          documentId,
          course,
          section,
          lesson,
          chunk,
        });
      }
      lessonPosition += 1;
    }
    modulePosition += 1;
  }
}
hierarchyStatements.push("commit");

const batches = [setupStatements.join(";\n"), hierarchyStatements.join(";\n")];
for (let offset = 0; offset < chunkRows.length; offset += chunksPerBatch) {
  const rows = chunkRows.slice(offset, offset + chunksPerBatch);
  const statements = ["begin"];
  for (const row of rows) {
    const { chunk } = row;
    statements.push(
      `insert into public.learning_chunks (
         chunk_id, tenant_id, course_id, knowledge_version_id, document_id,
         ordinal, body, token_count, content_hash, embedding,
         embedding_provider_key, embedding_model_key, embedding_dimensions,
         metadata, idempotency_key
       ) values (
         ${sql(uuid(`learningbot:estie:chunk:${row.course.slug}:${chunk.chunk_id}`))},
         ${sql(row.tenantId)}, ${sql(row.courseId)}, ${sql(row.versionId)},
         ${sql(row.documentId)}, ${Number(chunk.chunk_index)}, ${sql(chunk.text)},
         ${Math.ceil(Number(chunk.word_count ?? 0) * 1.33)}, ${sql(hash(chunk.text))},
         null, null, null, null,
         ${json({
           courseSlug: row.course.slug,
           courseName: row.course.name,
           sectionName: row.section.name,
           lessonId: row.lesson.externalId,
           lessonName: row.lesson.title,
           startHms: chunk.start_hms ?? null,
           legacyChunkId: chunk.chunk_id,
         })},
         ${sql(`estie-import:chunk:${row.course.slug}:${chunk.chunk_id}`)}
       )
       on conflict (chunk_id) do update set
         body = excluded.body,
         token_count = excluded.token_count,
         content_hash = excluded.content_hash,
         metadata = excluded.metadata`,
    );
  }
  statements.push("commit");
  batches.push(statements.join(";\n"));
}

if (requestedBatch === -1) {
  process.stdout.write(
    JSON.stringify({
      tenantId,
      courses: sortedCourses.length,
      lessons: sortedCourses.reduce(
        (total, course) =>
          total +
          [...course.sections.values()].reduce(
            (sectionTotal, section) => sectionTotal + section.lessons.size,
            0,
          ),
        0,
      ),
      chunks: chunkRows.length,
      batches: batches.length,
      chunksPerBatch,
    }),
  );
} else {
  if (!batches[requestedBatch]) {
    throw new Error(`Batch ${requestedBatch} does not exist.`);
  }
  process.stdout.write(batches[requestedBatch]);
}
