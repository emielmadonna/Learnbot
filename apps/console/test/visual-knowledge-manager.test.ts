import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731021643_visual_knowledge_manager.sql",
    import.meta.url,
  ),
  "utf8",
);
const secureMigration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731045059_secure_visual_media_pipeline.sql",
    import.meta.url,
  ),
  "utf8",
);
const visualSchema = `${migration}\n${secureMigration}`;
const verification = readFileSync(
  new URL(
    "../../../infra/supabase/tests/visual_knowledge_manager_verification.sql",
    import.meta.url,
  ),
  "utf8",
);
const apiRoute = readFileSync(
  new URL("../src/app/api/learning/visuals/route.ts", import.meta.url),
  "utf8",
);
const contentRoute = readFileSync(
  new URL(
    "../src/app/api/learning/visuals/[visualAssetId]/content/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const manager = readFileSync(
  new URL(
    "../src/components/sections/visual-knowledge-manager.tsx",
    import.meta.url,
  ),
  "utf8",
);
const coursePanel = readFileSync(
  new URL("../src/components/sections/course-panel.tsx", import.meta.url),
  "utf8",
);
const respondRoute = readFileSync(
  new URL("../src/app/api/learning/respond/route.ts", import.meta.url),
  "utf8",
);
const provider = readFileSync(
  new URL("../src/lib/learning-provider.ts", import.meta.url),
  "utf8",
);
const conversation = readFileSync(
  new URL(
    "../src/app/app/conversation/conversation-client.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("visual metadata is tenant-scoped, private and RPC-only", () => {
  for (const required of [
    "create table public.visual_knowledge_assets",
    "foreign key (tenant_id, course_id)",
    "media_type in ('image/png', 'image/jpeg', 'image/webp')",
    "size_bytes between 1 and 20971520",
    "object_key like tenant_id::text || '/visuals/%'",
    "alter table public.visual_knowledge_assets force row level security",
    "visual_knowledge_assets_deny_direct",
    "app_private.visual_storage_read_allowed",
    "tenant_private_visual_select",
    "learning_create_visual_asset",
    "learning_finalize_visual_asset",
    "learning_update_visual_asset",
    "learning_archive_visual_asset",
    "learning_list_visual_assets",
    "learning_get_visual_asset_for_read",
    "learning_record_visual_usage",
  ]) {
    assert.ok(visualSchema.includes(required), `missing visual control: ${required}`);
  }
  assert.match(
    migration,
    /revoke all on table public\.visual_knowledge_assets\s+from public, anon, authenticated, service_role;/u,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete|all)[\s\S]{0,100}visual_knowledge_assets[\s\S]{0,80}to (?:anon|authenticated)/iu,
  );
  assert.match(
    migration,
    /caller\.identity_role = 'student'[\s\S]*visual\.status = 'active'[\s\S]*visual\.show_in_answers[\s\S]*course\.status = 'published'/u,
  );
});

test("answer-enabled visual descriptions use the established retrieval path", () => {
  for (const required of [
    "app_private.visual_project_asset",
    "insert into public.learning_sources",
    "insert into public.learning_documents",
    "insert into public.learning_chunks",
    "'sectionName', 'Visual knowledge'",
    "'visualAssetId', visual.visual_asset_id",
    "app_private.visual_rebuild_course",
    "next_version_number",
    "'building'",
    "set status = 'published'",
    "set active_knowledge_version_id = next_version_id",
    "app_private.authoring_append_audit",
    "learning.visual.knowledge.project",
    "drop function app_private.visual_deactivate_projection(uuid, uuid)",
    "create constraint trigger courses_reproject_visual_knowledge",
    "deferrable initially deferred",
    "courses_reproject_visual_knowledge",
  ]) {
    assert.ok(migration.includes(required), `missing projection: ${required}`);
  }
  assert.ok(
    migration.includes(
      "document.metadata ->> 'projector'\n        is distinct from 'visual_knowledge_manager'",
    ),
  );
  assert.match(
    migration,
    /update public\.knowledge_versions version[\s\S]*set status = 'published'[\s\S]*update public\.courses c[\s\S]*set active_knowledge_version_id = next_version_id/u,
  );
});

test("the upload API signs private paths and never returns object keys", () => {
  assert.match(
    apiRoute,
    /authenticatedLearningClient\(request, \{ mutation \}\)/u,
  );
  assert.match(apiRoute, /createSignedUploadUrl\(objectKey/u);
  assert.match(
    apiRoute,
    /tenantId,[\s\S]*"visuals",[\s\S]*user\.id,[\s\S]*visualAssetId/u,
  );
  assert.match(apiRoute, /privateObjectKey: _privateKey/u);
  assert.match(
    apiRoute,
    /previewUrl:[\s\S]*`\/api\/learning\/visuals\/\$\{visualAssetId\}\/content`/u,
  );
  assert.doesNotMatch(apiRoute, /SUPABASE_SERVICE_ROLE/u);
  assert.doesNotMatch(apiRoute, /objectKey:\s*objectKey/u);

  assert.match(contentRoute, /learning_get_visual_asset_for_read/u);
  assert.match(contentRoute, /createSignedUrl\(objectKey/u);
  assert.match(contentRoute, /status: 206/u);
  assert.match(contentRoute, /status: 416/u);
  assert.match(contentRoute, /"Content-Range"/u);
  assert.match(contentRoute, /"X-Content-Type-Options": "nosniff"/u);
  assert.doesNotMatch(contentRoute, /NextResponse\.redirect/u);
  assert.doesNotMatch(contentRoute, /privateObjectKey\s*\}/u);
});

test("manager matches the complete visual-library and chart workflow", () => {
  for (const required of [
    "Add a visual",
    "PNG, JPG, WebP, safe SVG, or MP4",
    "Build a chart from data",
    "Generate preview",
    "Add chart",
    "Show archived",
    "Alt text for screen readers",
    "showInAnswers",
    "usageCount",
    "FileDrop",
    'action: "prepare"',
    'action: "finalize"',
    'action: "update"',
    'action: "archive"',
  ]) {
    assert.ok(manager.includes(required), `missing manager behavior: ${required}`);
  }
  assert.match(coursePanel, /<VisualKnowledgeManager/u);
  assert.doesNotMatch(coursePanel, /VisualsUnavailable/u);
});

test("blank visual workspaces never leak prototype-specific demo copy", () => {
  assert.doesNotMatch(manager, /Most of the fear is in the smallest outcome/iu);
  assert.match(
    manager,
    /Choose (?:or add )?a visual to preview its learner presentation/u,
  );
});

test("visuals are grounded, rendered and usage-counted in learner answers", () => {
  assert.match(respondRoute, /sectionName === "Visual knowledge"/u);
  assert.match(
    respondRoute,
    /url: `\/api\/learning\/visuals\/\$\{visualAssetId\}\/content`/u,
  );
  assert.match(respondRoute, /learning_record_visual_usage/u);
  assert.match(respondRoute, /visual_asset_ids: usedVisuals/u);
  assert.match(respondRoute, /mediaType: visualMediaType\(source\)/u);
  assert.match(provider, /Available visual:/u);
  assert.match(provider, /Visual alt text:/u);
  assert.match(conversation, /visual\.altText/u);
  assert.match(conversation, /visual\.mediaType/u);
  assert.match(conversation, /<video/u);
  assert.match(conversation, /src=\{visual\.url\}/u);
  assert.match(
    conversation,
    /visualUrl === `\/api\/learning\/visuals\/\$\{visualAssetId\}\/content`/u,
  );
});

test("server validation receipts and retrieval media metadata cannot be bypassed", () => {
  for (const required of [
    "learning.visual.finalize",
    "validated_sha256",
    "validation_profile",
    "server_media_inspection_v1",
    "learning_finalize_validated_visual_asset",
    "observed_sha256",
    "revoke execute on function public.learning_finalize_visual_asset(uuid)",
    "'mediaType', asset.media_type",
    "'visualKind', asset.visual_kind",
    "'altText'",
    "learning_search_chunks",
    "learning_chunk_matches",
  ]) {
    assert.ok(
      secureMigration.includes(required),
      `missing secure visual pipeline control: ${required}`,
    );
  }
  assert.match(
    apiRoute,
    /verifyVisualMedia\(bytes, mediaType\)[\s\S]*learning_finalize_validated_visual_asset/u,
  );
  assert.match(
    apiRoute,
    /LEARNINGBOT_VISUAL_VALIDATION_OPERATION_TOKEN/u,
  );
  assert.doesNotMatch(secureMigration, /widget_ask_legacy/u);
  assert.match(
    secureMigration,
    /Public widget matches deliberately remain unchanged/u,
  );
});

test("post-migration SQL verification covers the security boundary", () => {
  for (const tag of ["VKM-01", "VKM-02", "VKM-03", "VKM-04", "VKM-05"]) {
    assert.ok(verification.includes(tag), `missing verification tag: ${tag}`);
  }
});
