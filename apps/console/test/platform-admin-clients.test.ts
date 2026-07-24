import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isTenantId,
  parsePlatformClientDetail,
  parsePlatformOverview,
} from "../src/lib/supabase/platform-admin-rpc";

test("platform client parsers accept durable records and preserve bounded fields", () => {
  const overview = parsePlatformOverview({
    ok: true,
    dataMode: "durable",
    generatedAt: "2026-07-24T00:00:00Z",
    totals: { tenants: "1", activeTenants: 1, courses: 2, members: 3, sources: 4, knowledgeChunks: 5 },
    tenants: [{ tenantId: "tenant-1", displayName: "Client A", courses: 2 }],
  });
  assert.equal(overview?.totals.knowledgeChunks, 5);
  assert.equal(overview?.tenants[0]?.displayName, "Client A");

  const detail = parsePlatformClientDetail({
    ok: true,
    dataMode: "durable",
    client: { tenantId: "tenant-1", displayName: "Client A" },
    branding: { assistantName: "Estie" },
    providerVoice: { provider: "openai", voiceEnabled: true },
    features: { analytics: true, voice: true },
    counts: { courses: 1, questions: "2" },
    courses: [{ courseId: "course-1", title: "Course", modules: 2 }],
    people: [{ personId: "person-1", name: "Learner", signal: "deep_inquiry" }],
  });
  assert.equal(detail?.counts.questions, 2);
  assert.equal(detail?.courses[0]?.modules, 2);
  assert.equal(detail?.people[0]?.signal, "deep_inquiry");
  assert.equal(parsePlatformClientDetail({ ok: false, code: "access_denied" }), null);
});

test("client detail route is platform-gated and links tenant surfaces", () => {
  const page = readFileSync(
    new URL("../src/app/app/admin/clients/[tenantId]/page.tsx", import.meta.url),
    "utf8",
  );
  const migration = readFileSync(
    new URL("../../../infra/supabase/migrations/20260724205057_platform_admin_client_detail.sql", import.meta.url),
    "utf8",
  );
  const rpc = readFileSync(
    new URL("../src/lib/supabase/platform-admin-rpc.ts", import.meta.url),
    "utf8",
  );
  const assistant = readFileSync(
    new URL("../src/app/app/admin/clients/[tenantId]/workspace-assistant.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(isTenantId("71000000-0000-4000-8000-000000000001"), true);
  assert.equal(isTenantId("not-a-tenant"), false);
  assert.match(page, /platform_admin_is_authorized/);
  assert.match(rpc, /platform_admin_client_detail/);
  assert.match(page, /getPlatformOverview/);
  assert.match(page, /summaryFallback/);
  assert.match(page, /WorkspaceAssistant/);
  assert.match(assistant, /learners, published courses/);
  assert.match(page, /Client summary is online/);
  assert.match(page, /href="\/app\/platform"/);
  assert.doesNotMatch(page, /href="\/app\/admin\/clients"/);
  for (const path of ["\/app\/conversation", "\/app", "\/onboarding", "\/install\/circle"]) {
    assert.match(page, new RegExp(path));
  }
  for (const section of ["Branding", "Provider &amp; voice", "Feature availability", "People and questions"]) {
    assert.match(page, new RegExp(section));
  }
  assert.match(migration, /create or replace function public\.platform_admin_client_detail/);
  assert.match(migration, /security definer/);
  assert.match(migration, /grant execute on function public\.platform_admin_client_detail\(uuid\)/);
  assert.doesNotMatch(migration, /message\.body|chunk\.body/);
});
