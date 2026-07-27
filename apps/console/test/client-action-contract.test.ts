import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
} from "../src/lib/supabase/auth-boundary";
import {
  AgentRpcError,
  agentEditableVersion,
  agentOperationFields,
  getAgentConfiguration,
  parseAgentConfigurationWrite,
  updateAgentConfiguration,
  type AgentConfiguration,
} from "../src/lib/supabase/agent-rpc";
import {
  AnalyticsRpcError,
  getAnalyticsAnswerQuality,
  getAnalyticsLearnerProgress,
  getAnalyticsQuestionDistribution,
  getAnalyticsTenantOverview,
  parseAnalyticsTenantOverview,
  requireAnalyticsRpcSuccess,
} from "../src/lib/supabase/analytics-rpc";
import {
  createContentBlock,
  createLesson,
  createModule,
  deleteContentBlock,
  deleteLesson,
  deleteModule,
  listCourseRevisions,
  reorderChildren,
  rollbackCourse,
  updateContentBlock,
  updateCourse,
  updateLesson,
  updateModule,
} from "../src/lib/supabase/authoring-rpc";
import {
  enterPlatformTenant,
  exitPlatformTenant,
  getPlatformTenantDetail,
  setPlatformTenantStatus,
  setTenantSection,
} from "../src/lib/supabase/platform-rpc";

/* ------------------------------------------------------------------ sources */

function migration(name: string) {
  return readFileSync(
    new URL(`../../../infra/supabase/migrations/${name}`, import.meta.url),
    "utf8",
  );
}

const agentSql = migration("20260725120000_agent_configuration.sql");
const analyticsSql = migration("20260725121000_learning_analytics.sql");
const authoringSql = migration("20260725122000_course_editing.sql");
const sectionsSql = migration("20260725123000_tenant_section_control.sql");
const allSql = [agentSql, analyticsSql, authoringSql, sectionsSql].join("\n");

/**
 * Parameter names declared by a `public.<name>(...)` RPC in the applied
 * migration SQL. The migrations on disk are the source of truth for what the
 * live database exposes, so comparing against them catches a wrapper that
 * sends a parameter PostgREST cannot bind — a failure that otherwise only
 * appears as an opaque runtime error against the real project.
 */
function sqlParameterNames(sql: string, functionName: string): string[] {
  const marker = `create or replace function public.${functionName}(`;
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `migration does not define public.${functionName}`);
  const open = start + marker.length;
  let depth = 1;
  let index = open;
  while (index < sql.length && depth > 0) {
    if (sql[index] === "(") depth += 1;
    if (sql[index] === ")") depth -= 1;
    index += 1;
  }
  const body = sql.slice(open, index - 1);
  if (body.trim().length === 0) return [];
  return body
    .split(",")
    .map((chunk) => chunk.replace(/--.*$/gmu, "").trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const name = /^([a-z_][a-z0-9_]*)/u.exec(chunk)?.[1];
      assert.ok(name, `unparsed parameter in ${functionName}: ${chunk}`);
      return name;
    });
}

/* ------------------------------------------------------------- fake client */

type Call = { name: string; params: Record<string, unknown> };

function recordingClient(data: unknown, calls: Call[]) {
  return {
    rpc(name: string, params?: Record<string, unknown>) {
      calls.push({ name, params: params ?? {} });
      return Promise.resolve({ data, error: null });
    },
  } as unknown as SupabaseClient;
}

function failingClient() {
  return {
    rpc() {
      return Promise.resolve({
        data: null,
        error: { code: "42883", message: "function does not exist" },
      });
    },
  } as unknown as SupabaseClient;
}

/* -------------------------------------------------------------- fixtures */

const revision = {
  revisionId: "rev-1",
  revisionNumber: 4,
  revisionKind: "edited",
  contentHash: "hash",
  beforeHash: null,
};

const authoringResult = {
  ok: true,
  dataMode: "durable",
  recordVersion: 8,
  revision,
  courseId: "11111111-1111-4111-8111-111111111111",
};

function agentVersion(version: number, status: "draft" | "published") {
  return {
    brandingId: `b-${version}`,
    status,
    version,
    assistantName: "Estie",
    iconGlyph: null,
    primaryColor: "#2F4BFF",
    accentColor: "#12B981",
    surfaceColor: "#F7F8FC",
    textColor: "#101828",
    welcomeMessage: "Hello",
    personaInstructions: null,
    tone: "neutral",
    voice: null,
    courseScope: "all",
    logoStorageKey: `t/branding/u/a${version}/logo.png`,
    avatarStorageKey: null,
    privacyCopy: null,
    publishedAt: null,
    updatedAt: "2026-07-25T00:00:00Z",
  };
}

const agentInput = {
  assistantName: "Estie",
  iconGlyph: null,
  primaryColor: "#2F4BFF",
  accentColor: "#12B981",
  surfaceColor: "#F7F8FC",
  textColor: "#101828",
  welcomeMessage: "Hello",
  personaInstructions: null,
  tone: "neutral",
  voice: null,
  courseScope: "all" as const,
  logoStorageKey: null,
  avatarStorageKey: null,
  publish: false,
  expectedVersion: 3,
};

const courseId = "11111111-1111-4111-8111-111111111111";
const moduleId = "22222222-2222-4222-8222-222222222222";
const lessonId = "33333333-3333-4333-8333-333333333333";
const blockId = "44444444-4444-4444-8444-444444444444";
const tenantId = "55555555-5555-4555-8555-555555555555";

/* ------------------------------------------------ agent configuration path */

test("agent configuration write binds exactly the RPC's declared parameters", async () => {
  const calls: Call[] = [];
  await updateAgentConfiguration(
    recordingClient(
      {
        ok: true,
        dataMode: "durable",
        tenantId,
        expectedVersion: 4,
        configuration: agentVersion(4, "draft"),
      },
      calls,
    ),
    agentInput,
    agentOperationFields("agent-configuration"),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "tenant_update_agent_configuration");
  assert.deepEqual(
    Object.keys(calls[0]?.params ?? {}).sort(),
    sqlParameterNames(agentSql, "tenant_update_agent_configuration").sort(),
  );
});

test("agent configuration read takes no parameters, matching the RPC", async () => {
  const calls: Call[] = [];
  await getAgentConfiguration(
    recordingClient(
      {
        ok: true,
        dataMode: "durable",
        tenantId,
        expectedVersion: 2,
        published: agentVersion(2, "published"),
        draft: null,
        defaults: {},
        toneOptions: ["neutral"],
        assetPrefix: `${tenantId}/branding/`,
      },
      calls,
    ),
  );
  assert.equal(calls[0]?.name, "tenant_get_agent_configuration");
  assert.deepEqual(Object.keys(calls[0]?.params ?? {}), []);
  assert.deepEqual(
    sqlParameterNames(agentSql, "tenant_get_agent_configuration"),
    [],
  );
});

test("a missing or refused agent RPC is not reported as an authentication failure", async () => {
  await assert.rejects(
    () => getAgentConfiguration(failingClient()),
    (error: unknown) => {
      assert.ok(
        error instanceof AgentRpcError,
        "an unreachable RPC must not raise the authentication boundary error",
      );
      assert.equal((error as AgentRpcError).code, "request_failed");
      return true;
    },
  );
});

test("consecutive saves thread the returned head version forward", () => {
  // The write returns the version it just created. Feeding that straight back
  // as the next `expectedVersion` is what keeps a second consecutive save from
  // being rejected as a stale write.
  const first = parseAgentConfigurationWrite({
    ok: true,
    dataMode: "durable",
    tenantId,
    expectedVersion: 4,
    configuration: agentVersion(4, "draft"),
  });
  assert.equal(first.expectedVersion, 4);
  assert.equal(first.configuration.version, first.expectedVersion);
  assert.equal(
    agentInput.expectedVersion + 1,
    first.expectedVersion,
    "the write must advance the version chain by exactly one",
  );
});

test("the editable agent version is the chain head, not a superseded draft", () => {
  // After publishing version 5, the version-3 draft row still exists. Choosing
  // "draft ?? published" would render and sign the stale draft's assets.
  const afterPublish: AgentConfiguration = {
    ok: true,
    dataMode: "durable",
    tenantId,
    expectedVersion: 5,
    published: agentVersion(5, "published"),
    draft: agentVersion(3, "draft"),
    defaults: {},
    toneOptions: [],
    assetPrefix: `${tenantId}/branding/`,
  } as unknown as AgentConfiguration;
  assert.equal(agentEditableVersion(afterPublish)?.version, 5);

  const draftAhead: AgentConfiguration = {
    ...afterPublish,
    expectedVersion: 6,
    draft: agentVersion(6, "draft"),
  } as unknown as AgentConfiguration;
  assert.equal(agentEditableVersion(draftAhead)?.version, 6);
});

test("learning_get_workspace publishes presentation branding and withholds directives", () => {
  const start = agentSql.indexOf(
    "create or replace function public.learning_get_workspace(",
  );
  assert.ok(start >= 0);
  const brandingStart = agentSql.indexOf("'branding', case when", start);
  const brandingEnd = agentSql.indexOf("'courses',", brandingStart);
  assert.ok(brandingStart >= 0 && brandingEnd > brandingStart);
  const branding = agentSql.slice(brandingStart, brandingEnd);

  // Every field the shell themes from must be present for every role.
  for (const field of [
    "'assistantName'",
    "'primaryColor'",
    "'accentColor'",
    "'surfaceColor'",
    "'textColor'",
    "'iconGlyph'",
    "'welcomeMessage'",
    "'logoStorageKey'",
    "'avatarStorageKey'",
  ]) {
    assert.ok(branding.includes(field), `branding is missing ${field}`);
  }

  // The persona and tone are a deliberate security boundary: they may only be
  // emitted inside the owner/admin branch. This asserts the boundary, it does
  // not ask for the fields to be added back for other roles.
  const adminBranch = branding.slice(
    branding.indexOf("caller.identity_role in ('tenant_owner', 'tenant_admin')"),
  );
  assert.ok(adminBranch.length > 0, "the admin-only branding branch is gone");
  assert.equal(
    branding.indexOf("'personaInstructions'"),
    adminBranch.indexOf("'personaInstructions'") +
      (branding.length - adminBranch.length),
    "personaInstructions escaped the owner/admin branch",
  );
  assert.ok(adminBranch.includes("'tone'"));
});

test("a draft-only agent save is invisible to learning_get_workspace by design", () => {
  // The workspace read orders published rows ahead of every other status, so a
  // draft save cannot re-theme the app while a published row exists. Publishing
  // is the only action that changes what a learner sees.
  const start = agentSql.indexOf("branding_record as (");
  const end = agentSql.indexOf("select jsonb_build_object(", start);
  const brandingRecord = agentSql.slice(start, end);
  assert.ok(
    brandingRecord.includes(
      "case b.status when 'published' then 0 else 1 end",
    ),
    "published branding must sort ahead of drafts",
  );
  assert.ok(
    brandingRecord.includes("b.status = 'published'") &&
      brandingRecord.includes("caller.identity_role <> 'student'"),
    "students must only ever see published branding",
  );

  // The answer path reads the persona from the published row only, so a draft
  // persona never reaches the assistant either.
  const directive = agentSql.slice(
    agentSql.indexOf(
      "create or replace function app_private.agent_directive_for_tenant(",
    ),
  );
  assert.ok(directive.slice(0, 800).includes("b.status = 'published'"));
});

/* -------------------------------------------------------- authoring path */

test("every authoring wrapper binds exactly its RPC's declared parameters", async () => {
  const expectations: Array<{
    rpc: string;
    call: (client: SupabaseClient) => Promise<unknown>;
  }> = [
    {
      rpc: "learning_update_course",
      call: (client) =>
        updateCourse(client, {
          courseId,
          title: "New title",
          description: null,
          expectedVersion: 3,
          idempotencyKey: "course-update-1",
        }),
    },
    {
      rpc: "learning_create_module",
      call: (client) =>
        createModule(client, {
          courseId,
          title: "Module",
          expectedVersion: 3,
          idempotencyKey: "module-create-1",
        }),
    },
    {
      rpc: "learning_update_module",
      call: (client) =>
        updateModule(client, {
          moduleId,
          title: "Module",
          status: "published",
          expectedVersion: 3,
          idempotencyKey: "module-update-1",
        }),
    },
    {
      rpc: "learning_delete_module",
      call: (client) =>
        deleteModule(client, {
          moduleId,
          expectedVersion: 3,
          idempotencyKey: "module-delete-1",
        }),
    },
    {
      rpc: "learning_create_lesson",
      call: (client) =>
        createLesson(client, {
          moduleId,
          title: "Lesson",
          content: "Body",
          expectedVersion: 3,
          idempotencyKey: "lesson-create-1",
        }),
    },
    {
      rpc: "learning_update_lesson",
      call: (client) =>
        updateLesson(client, {
          lessonId,
          title: "Lesson",
          status: "draft",
          expectedVersion: 3,
          idempotencyKey: "lesson-update-1",
        }),
    },
    {
      rpc: "learning_delete_lesson",
      call: (client) =>
        deleteLesson(client, {
          lessonId,
          expectedVersion: 3,
          idempotencyKey: "lesson-delete-1",
        }),
    },
    {
      rpc: "learning_create_content_block",
      call: (client) =>
        createContentBlock(client, {
          lessonId,
          blockType: "rich_text",
          content: { text: "Body", format: "plain" },
          expectedVersion: 3,
          idempotencyKey: "block-create-1",
        }),
    },
    {
      rpc: "learning_update_content_block",
      call: (client) =>
        updateContentBlock(client, {
          contentBlockId: blockId,
          blockType: "rich_text",
          content: { text: "Body", format: "plain" },
          expectedVersion: 3,
          idempotencyKey: "block-update-1",
        }),
    },
    {
      rpc: "learning_delete_content_block",
      call: (client) =>
        deleteContentBlock(client, {
          contentBlockId: blockId,
          expectedVersion: 3,
          idempotencyKey: "block-delete-1",
        }),
    },
    {
      rpc: "learning_reorder",
      call: (client) =>
        reorderChildren(client, {
          parentKind: "course",
          parentId: courseId,
          orderedIds: [moduleId],
          expectedVersion: 3,
          idempotencyKey: "reorder-1",
        }),
    },
    {
      rpc: "learning_rollback_course",
      call: (client) =>
        rollbackCourse(client, {
          courseId,
          targetRevisionId: "rev-abc",
          expectedVersion: 3,
          idempotencyKey: "rollback-1",
        }),
    },
  ];

  for (const expectation of expectations) {
    const calls: Call[] = [];
    await expectation.call(recordingClient(authoringResult, calls));
    assert.equal(calls[0]?.name, expectation.rpc);
    assert.deepEqual(
      Object.keys(calls[0]?.params ?? {}).sort(),
      sqlParameterNames(authoringSql, expectation.rpc).sort(),
      `${expectation.rpc} parameter names drifted from the migration`,
    );
  }
});

test("revision history binds the RPC's declared parameter", async () => {
  const calls: Call[] = [];
  await listCourseRevisions(
    recordingClient(
      {
        ok: true,
        dataMode: "durable",
        courseId,
        headRevisionId: "rev-1",
        headRevisionNumber: 1,
        revisions: [],
      },
      calls,
    ),
    { courseId },
  );
  assert.equal(calls[0]?.name, "learning_list_course_revisions");
  assert.deepEqual(
    Object.keys(calls[0]?.params ?? {}).sort(),
    sqlParameterNames(authoringSql, "learning_list_course_revisions").sort(),
  );
});

test("the authoring route classifies every refusal the RPCs can produce", () => {
  const route = readFileSync(
    new URL("../src/app/api/authoring/route.ts", import.meta.url),
    "utf8",
  );
  // learning_list_course_revisions is the one authoring RPC that answers with
  // an ok:false envelope rather than a SQLSTATE. Its two codes must not fall
  // through to the generic denial, whose copy blames an unapplied migration.
  for (const code of ["access_denied", "course_not_found"]) {
    assert.ok(
      authoringSql.includes(`jsonb_build_object('ok', false, 'code', '${code}')`),
      `the migration no longer returns ${code}`,
    );
    assert.ok(
      route.includes(`"${code}"`),
      `the authoring route does not classify ${code}`,
    );
  }
  assert.ok(
    route.includes('["request_failed", 503]'),
    "an unreachable authoring RPC must not be reported as a client error",
  );
});

test("every authoring SQLSTATE the RPCs raise is translated by the wrapper", () => {
  const wrapper = readFileSync(
    new URL("../src/lib/supabase/authoring-rpc.ts", import.meta.url),
    "utf8",
  );
  const raised = new Set(
    [...authoringSql.matchAll(/raise\s+([a-z_]+)\s/gu)].map(
      (match) => match[1] as string,
    ),
  );
  const sqlstateByCondition: Record<string, string> = {
    insufficient_privilege: "42501",
    invalid_parameter_value: "22023",
    no_data_found: "P0002",
    unique_violation: "23505",
    serialization_failure: "40001",
    check_violation: "23514",
  };
  for (const condition of raised) {
    const sqlstate = sqlstateByCondition[condition];
    assert.ok(
      sqlstate,
      `the migration raises an untranslated condition: ${condition}`,
    );
    assert.ok(
      wrapper.includes(`"${sqlstate}"`),
      `authoring-rpc does not translate SQLSTATE ${sqlstate} (${condition})`,
    );
  }
});

/* -------------------------------------------------------- analytics path */

test("every analytics wrapper binds the RPC's declared range parameters", async () => {
  const overview = {
    ok: true,
    dataMode: "durable",
    generatedAt: "2026-07-25T00:00:00Z",
    range: { start: "a", end: "b", timeZone: "UTC", dayCount: 1 },
    definitions: {},
    limits: { courses: 1, modulesPerCourse: 1, lessonsPerModule: 1, truncated: false },
    stalledThresholdDays: 14,
    distribution: { state: "unknown", evidenceRefs: [], limitations: [] },
    metrics: {
      questionVolume: { state: "unknown", evidenceRefs: [], limitations: [] },
      activeLearners: { state: "unknown", evidenceRefs: [], limitations: [] },
      channelSplit: { state: "unknown", evidenceRefs: [], limitations: [] },
      answerLatencyMs: { state: "unknown", evidenceRefs: [], limitations: [] },
      turnRecordingIntervalMs: {
        state: "unknown",
        evidenceRefs: [],
        limitations: [],
      },
      groundingCoverage: { state: "unknown", evidenceRefs: [], limitations: [] },
      retrievalConfidence: { state: "unknown", evidenceRefs: [], limitations: [] },
      contentGapSignals: { state: "unknown", evidenceRefs: [], limitations: [] },
      courseFunnel: { state: "unknown", evidenceRefs: [], limitations: [] },
      courseCompletionTiming: {
        state: "unknown",
        evidenceRefs: [],
        limitations: [],
      },
    },
  };
  const range = { rangeStart: null, rangeEnd: null };
  const wrappers: Array<[string, (c: SupabaseClient) => Promise<unknown>]> = [
    ["analytics_tenant_overview", (c) => getAnalyticsTenantOverview(c, range)],
    [
      "analytics_question_distribution",
      (c) => getAnalyticsQuestionDistribution(c, range),
    ],
    ["analytics_answer_quality", (c) => getAnalyticsAnswerQuality(c, range)],
    ["analytics_learner_progress", (c) => getAnalyticsLearnerProgress(c, range)],
  ];
  for (const [rpc, call] of wrappers) {
    const calls: Call[] = [];
    await call(recordingClient(overview, calls));
    assert.equal(calls[0]?.name, rpc);
    assert.deepEqual(
      Object.keys(calls[0]?.params ?? {}).sort(),
      sqlParameterNames(analyticsSql, rpc).sort(),
    );
  }
});

test("an unknown analytics metric can never be rendered as a measured zero", () => {
  // The RPC omits `value` entirely for an unknown metric. A payload that
  // carries both must be rejected rather than displayed.
  assert.throws(
    () =>
      parseAnalyticsTenantOverview({
        ok: true,
        dataMode: "durable",
        range: {},
        metrics: {
          questionVolume: {
            state: "unknown",
            value: { totalQuestions: 0 },
            evidenceRefs: [],
            limitations: [],
          },
        },
      }),
    AnalyticsRpcError,
  );
  // A known metric with no value is equally unrenderable and equally rejected.
  assert.throws(
    () =>
      parseAnalyticsTenantOverview({
        ok: true,
        dataMode: "durable",
        range: {},
        metrics: {
          questionVolume: {
            state: "known",
            evidenceRefs: [],
            limitations: [],
          },
        },
      }),
    AnalyticsRpcError,
  );
  assert.throws(
    () => requireAnalyticsRpcSuccess({ ok: false, code: "access_denied" }),
    AnalyticsRpcError,
  );
});

test("the analytics migration never emits a value for an unknown metric", () => {
  const helper = analyticsSql.slice(
    analyticsSql.indexOf(
      "create or replace function app_private.analytics_metric(",
    ),
  );
  assert.ok(
    helper.slice(0, 1200).includes("when metric_state = 'unknown'"),
    "analytics_metric must omit 'value' for an unknown metric",
  );
});

/* --------------------------------------------------------- platform path */

test("platform wrappers bind exactly the section-control RPC parameters", async () => {
  const detail = {
    ok: true,
    dataMode: "durable",
    tenant: { tenantId },
    sections: [],
    counts: {},
    readiness: {},
    section: { sectionKey: "insights", enabled: true, updatedAt: null },
    tenantId,
    exited: true,
  };
  const cases: Array<[string, (c: SupabaseClient) => Promise<unknown>]> = [
    [
      "platform_admin_tenant_detail",
      (c) => getPlatformTenantDetail(c, tenantId),
    ],
    [
      "platform_admin_set_tenant_section",
      (c) =>
        setTenantSection(c, {
          tenantId,
          sectionKey: "insights",
          enabled: true,
        }),
    ],
    [
      "platform_admin_set_tenant_status",
      (c) => setPlatformTenantStatus(c, { tenantId, status: "suspended" }),
    ],
    ["platform_admin_enter_tenant", (c) => enterPlatformTenant(c, tenantId)],
    ["platform_admin_exit_tenant", (c) => exitPlatformTenant(c)],
  ];
  for (const [rpc, call] of cases) {
    const calls: Call[] = [];
    await call(recordingClient(detail, calls));
    assert.equal(calls[0]?.name, rpc);
    assert.deepEqual(
      Object.keys(calls[0]?.params ?? {}).sort(),
      sqlParameterNames(sectionsSql, rpc).sort(),
    );
  }
});

/* ------------------------------------------------------- honest failures */

test("only a real sign-in failure is reported as 401", () => {
  const cases: Array<[string, number, string]> = [
    ["auth.authentication_required", 401, "authentication_required"],
    ["auth.password_change_required", 403, "password_change_required"],
    ["auth.invalid_origin", 403, "invalid_origin"],
    ["auth.context_lookup_failed", 503, "request_failed"],
    ["auth.access_state_failed", 503, "request_failed"],
    ["agent.configuration_failed", 503, "request_failed"],
    ["analytics.request_failed", 503, "request_failed"],
    ["platform.authorization_failed", 503, "request_failed"],
    ["learning.workspace_failed", 503, "request_failed"],
    ["something.unforeseen", 503, "request_failed"],
  ];
  for (const [code, status, reported] of cases) {
    const failure = classifyAuthBoundaryError(
      new AuthenticationBoundaryError(code, "message"),
    );
    assert.equal(failure.status, status, `${code} status`);
    assert.equal(failure.code, reported, `${code} code`);
  }
});

test("no client-facing route answers every failure with a blanket 401", () => {
  const routes = [
    "../src/app/api/agent/route.ts",
    "../src/app/api/agent/asset/route.ts",
    "../src/app/api/analytics/route.ts",
    "../src/app/api/authoring/route.ts",
    "../src/app/api/platform/route.ts",
    "../src/app/api/learning/workspace/route.ts",
  ];
  for (const path of routes) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.ok(
      source.includes("classifyAuthBoundaryError"),
      `${path} does not classify authentication boundary failures`,
    );
    assert.ok(
      !/catch\s*\{\s*\n\s*return NextResponse\.json\(\s*\n?\s*\{\s*ok:\s*false,\s*code:\s*"authentication_required"/u.test(
        source,
      ),
      `${path} still swallows every failure into a 401`,
    );
  }
});

test("the applied migrations grant every RPC the console calls", () => {
  const called = [
    "tenant_get_agent_configuration",
    "tenant_update_agent_configuration",
    "learning_get_workspace",
    "learning_get_agent_directive",
    "analytics_tenant_overview",
    "analytics_question_distribution",
    "analytics_answer_quality",
    "analytics_learner_progress",
    "learning_update_course",
    "learning_create_module",
    "learning_update_module",
    "learning_delete_module",
    "learning_create_lesson",
    "learning_update_lesson",
    "learning_delete_lesson",
    "learning_create_content_block",
    "learning_update_content_block",
    "learning_delete_content_block",
    "learning_reorder",
    "learning_list_course_revisions",
    "learning_rollback_course",
    "tenant_get_sections",
    "platform_admin_set_tenant_section",
    "platform_admin_set_tenant_status",
    "platform_admin_enter_tenant",
    "platform_admin_exit_tenant",
    "platform_admin_tenant_detail",
  ];
  for (const name of called) {
    assert.ok(
      new RegExp(
        `grant execute on function public\\.${name}\\s*\\(`,
        "u",
      ).test(allSql),
      `public.${name} is never granted to authenticated callers`,
    );
  }
});
