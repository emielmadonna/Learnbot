import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const migrationsDirectory = resolve(root, "migrations");
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();

const migrationTexts = await Promise.all(
  migrationNames.map((name) =>
    readFile(resolve(migrationsDirectory, name), "utf8"),
  ),
);
const sql = migrationTexts.join("\n");
const tests = await readFile(
  resolve(root, "tests", "security_verification.sql"),
  "utf8",
);
const durableExecutionTests = await readFile(
  resolve(
    root,
    "tests",
    "durable_execution_primitives_verification.sql",
  ),
  "utf8",
);
const identityProvisioningTests = await readFile(
  resolve(root, "tests", "identity_provisioning_verification.sql"),
  "utf8",
);
const durableUploadTests = await readFile(
  resolve(root, "tests", "durable_upload_intents_verification.sql"),
  "utf8",
);
const onboardingTests = await readFile(
  resolve(root, "tests", "onboarding_verification.sql"),
  "utf8",
);
const authTenantBridgeTests = await readFile(
  resolve(root, "tests", "auth_tenant_bridge_verification.sql"),
  "utf8",
);
const authenticatedOnboardingRpcTests = await readFile(
  resolve(
    root,
    "tests",
    "authenticated_onboarding_rpcs_verification.sql",
  ),
  "utf8",
);
const durableLearningWorkspaceTests = await readFile(
  resolve(
    root,
    "tests",
    "durable_learning_workspace_verification.sql",
  ),
  "utf8",
);
const preprovisionedTenantClaimTests = await readFile(
  resolve(
    root,
    "tests",
    "preprovisioned_tenant_claim_verification.sql",
  ),
  "utf8",
);
const groundedLexicalRetrievalTests = await readFile(
  resolve(
    root,
    "tests",
    "grounded_lexical_retrieval_verification.sql",
  ),
  "utf8",
);
const durableLearningConversationTests = await readFile(
  resolve(
    root,
    "tests",
    "durable_learning_conversations_verification.sql",
  ),
  "utf8",
);
const agentConfigurationTests = await readFile(
  resolve(root, "tests", "agent_configuration_verification.sql"),
  "utf8",
);
const learningAnalyticsTests = await readFile(
  resolve(root, "tests", "learning_analytics_verification.sql"),
  "utf8",
);
const courseEditingTests = await readFile(
  resolve(root, "tests", "course_editing_verification.sql"),
  "utf8",
);
const tenantSectionControlTests = await readFile(
  resolve(root, "tests", "tenant_section_control_verification.sql"),
  "utf8",
);
const platformClientProvisioningTests = await readFile(
  resolve(root, "tests", "platform_client_provisioning_verification.sql"),
  "utf8",
);
const questionIntelligenceTests = await readFile(
  resolve(root, "tests", "question_intelligence_verification.sql"),
  "utf8",
);
const authoringPublishVisibilityTests = await readFile(
  resolve(root, "tests", "authoring_publish_visibility_verification.sql"),
  "utf8",
);
const widgetDeliveryTests = await readFile(
  resolve(root, "tests", "widget_delivery_verification.sql"),
  "utf8",
);
const widgetAnalyticsTests = await readFile(
  resolve(root, "tests", "widget_analytics_verification.sql"),
  "utf8",
);
const authoredContentRetrievalTests = await readFile(
  resolve(root, "tests", "authored_content_retrieval_verification.sql"),
  "utf8",
);
const operationalSafetyTests = await readFile(
  resolve(root, "tests", "operational_safety_verification.sql"),
  "utf8",
);

if (
  !sql.includes(
    "'public.auth_select_tenant(uuid,text,text)'::regprocedure",
  ) ||
  !sql.includes("#variable_conflict use_column")
) {
  fail("auth_select_tenant is missing explicit PL/pgSQL name resolution");
}

if (
  !sql.includes(
    "onboarding_update_tenant_profile.idempotency_key",
  )
) {
  fail("onboarding profile idempotency parameter is not qualified");
}

if (
  !sql.includes(
    "'public.onboarding_accept_invitation(' ||",
  ) ||
  !sql.includes("#variable_conflict use_variable")
) {
  fail(
    "onboarding_accept_invitation is missing explicit PL/pgSQL name resolution",
  );
}

if (
  !sql.includes(
    "on conflict on constraint identity_principals_pkey",
  )
) {
  fail(
    "onboarding_accept_invitation is missing its unambiguous principal conflict target",
  );
}

const manifestTables = [
  "tenants",
  "roles",
  "profiles",
  "memberships",
  "courses",
  "modules",
  "lessons",
  "content_blocks",
  "learning_sources",
  "ingestion_jobs",
  "ingestion_checkpoints",
  "ingestion_issues",
  "knowledge_versions",
  "learning_documents",
  "learning_chunks",
  "tenant_branding",
  "learning_context_mappings",
  "student_progress",
  "conversations",
  "messages",
  "attachments",
  "audit_ledger",
  "cost_ledger",
  "mcp_grants",
  "mcp_invocations",
];
const durableExecutionTables = [
  "course_revisions",
  "course_revision_heads",
  "command_receipts",
  "telemetry_outbox",
];
const identityTenantTables = [
  "identity_memberships",
  "identity_service_principals",
  "identity_invitations",
  "identity_invitation_acceptances",
  "identity_scim_bindings",
  "identity_scim_receipts",
];
const globalIdentityTables = ["identity_principals"];
const durableUploadTables = [
  "upload_intents",
  "upload_callback_receipts",
];
const onboardingTables = [
  "onboarding_workspaces",
  "onboarding_steps",
  "identity_audit_events",
];
const durableLearningTables = ["lesson_progress"];
const usageTables = ["learning_usage_events"];
const tenantControlTables = ["tenant_sections"];
const questionIntelligenceTables = ["question_labels", "question_signals"];
const widgetTables = ["tenant_widget_keys", "conversation_surfaces"];
const expectedTables = [
  ...manifestTables,
  ...durableExecutionTables,
  ...identityTenantTables,
  ...globalIdentityTables,
  ...durableUploadTables,
  ...onboardingTables,
  ...durableLearningTables,
  ...usageTables,
  ...tenantControlTables,
  ...questionIntelligenceTables,
  ...widgetTables,
];

function fail(message) {
  throw new Error(`Supabase structure verification failed: ${message}`);
}

function tableBody(name) {
  const marker = `create table public.${name} (`;
  const start = sql.indexOf(marker);
  if (start < 0) fail(`missing table ${name}`);
  const open = sql.indexOf("(", start);
  let depth = 0;
  let inSingleQuote = false;
  for (let index = open; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" && sql[index - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
    }
    if (inSingleQuote) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, index);
    }
  }
  fail(`unterminated table declaration ${name}`);
}

for (const table of expectedTables) {
  const body = tableBody(table);
  const requiredColumns = [
    "record_version",
    "idempotency_key",
    "created_at",
    "updated_at",
    "deleted_at",
    "retain_until",
  ];
  if (!globalIdentityTables.includes(table)) {
    requiredColumns.unshift("tenant_id");
  }
  for (const column of requiredColumns) {
    if (!new RegExp(`\\b${column}\\b`).test(body)) {
      fail(`${table} is missing ${column}`);
    }
  }
  if (manifestTables.includes(table) && !sql.includes(`'${table}'`)) {
    fail(`${table} is missing from the RLS/trigger table manifests`);
  }
}

if (!/\bembedding_dimensions\s+integer\b/.test(tableBody("learning_chunks"))) {
  fail("learning_chunks is missing embedding_dimensions");
}

for (const table of durableExecutionTables) {
  for (const control of [
    `alter table public.${table} enable row level security`,
    `alter table public.${table} force row level security`,
  ]) {
    if (!sql.includes(control)) {
      fail(`${table} is missing required control: ${control}`);
    }
  }
}

for (const table of [...identityTenantTables, ...globalIdentityTables]) {
  for (const control of [
    `alter table public.${table} enable row level security`,
    `alter table public.${table} force row level security`,
  ]) {
    if (!sql.includes(control)) {
      fail(`${table} is missing required identity control: ${control}`);
    }
  }
}

for (const table of durableUploadTables) {
  for (const control of [
    `alter table public.${table} enable row level security`,
    `alter table public.${table} force row level security`,
  ]) {
    if (!sql.includes(control)) {
      fail(`${table} is missing required upload control: ${control}`);
    }
  }
}

for (const table of onboardingTables) {
  for (const control of [
    `alter table public.${table} enable row level security`,
    `alter table public.${table} force row level security`,
  ]) {
    if (!sql.includes(control)) {
      fail(`${table} is missing required onboarding control: ${control}`);
    }
  }
}

for (const table of durableLearningTables) {
  for (const control of [
    `alter table public.${table} enable row level security`,
    `alter table public.${table} force row level security`,
  ]) {
    if (!sql.includes(control)) {
      fail(`${table} is missing required learning control: ${control}`);
    }
  }
}

for (const required of [
  "enable row level security",
  "force row level security",
  "app_private.current_tenant_id()",
  "app_private.current_actor_id()",
  "app_private.current_app_role()",
  "app_private.reject_mutation()",
  "tenant_private_owner_select",
  "tenant_private_owner_insert",
  "tenant_private_owner_delete",
]) {
  if (!sql.includes(required)) fail(`missing required control: ${required}`);
}

for (const acceptanceId of [
  "SEC-01",
  "SEC-02",
  "SEC-03",
  "SEC-07",
  "ATT-02",
  "MCP-08",
]) {
  if (!tests.includes(acceptanceId)) {
    fail(`missing verification coverage marker ${acceptanceId}`);
  }
}

for (const acceptanceId of ["CLAIM-01", "CLAIM-02", "CLAIM-03"]) {
  if (!preprovisionedTenantClaimTests.includes(acceptanceId)) {
    fail(`missing preprovisioned owner claim marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "DLW-01",
  "DLW-02",
  "DLW-03",
  "DLW-04",
  "DLW-05",
]) {
  if (!durableLearningWorkspaceTests.includes(acceptanceId)) {
    fail(`missing durable learning verification marker ${acceptanceId}`);
  }
}

for (const acceptanceId of ["GSR-01", "GSR-02", "GSR-03", "GSR-04"]) {
  if (!groundedLexicalRetrievalTests.includes(acceptanceId)) {
    fail(`missing grounded retrieval verification marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "AGENT-01",
  "AGENT-02",
  "AGENT-03",
  "AGENT-04",
  "AGENT-05",
  "AGENT-06",
  "AGENT-07",
  "AGENT-08",
]) {
  if (!agentConfigurationTests.includes(acceptanceId)) {
    fail(`missing agent configuration verification marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "ANA-01",
  "ANA-02",
  "ANA-03",
  "ANA-04",
  "ANA-05",
  "ANA-06",
  "ANA-07",
]) {
  if (!learningAnalyticsTests.includes(acceptanceId)) {
    fail(`missing learning analytics verification marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "CED-01",
  "CED-02",
  "CED-03",
  "CED-04",
  "CED-05",
  "CED-06",
  "CED-07",
  "CED-08",
]) {
  if (!courseEditingTests.includes(acceptanceId)) {
    fail(`missing course editing verification marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "TSC-01",
  "TSC-02",
  "TSC-03",
  "TSC-04",
  "TSC-05",
  "TSC-06",
]) {
  if (!tenantSectionControlTests.includes(acceptanceId)) {
    fail(`missing tenant section control verification marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "PCP-01",
  "PCP-02",
  "PCP-03",
  "PCP-04",
  "PCP-05",
  "PCP-06",
]) {
  if (!platformClientProvisioningTests.includes(acceptanceId)) {
    fail(
      `missing platform client provisioning verification marker ${acceptanceId}`,
    );
  }
}

// The owner claim a platform admin mints must stay unreachable from the browser:
// only its digest is stored, and the provisioning table denies all direct access.
for (const required of [
  "app_private.platform_client_provisionings",
  "app_private.platform_mint_owner_claim",
  "platform_client_provisionings_no_direct_access",
]) {
  if (!sql.includes(required)) {
    fail(`missing client provisioning control: ${required}`);
  }
}

for (const acceptanceId of [
  "QIN-01",
  "QIN-02",
  "QIN-03",
  "QIN-04",
  "QIN-05",
  "QIN-06",
]) {
  if (!questionIntelligenceTests.includes(acceptanceId)) {
    fail(`missing question intelligence verification marker ${acceptanceId}`);
  }
}

// Labels are written only through the operation-token path, never by a browser
// session, and are readable only by tenant administrators.
for (const required of [
  "app_private.question_signal_detections",
  "app_private.question_signal_fingerprint",
  "app_private.question_intelligence_audit",
  "app_private.question_intent_taxonomy",
  "question_labels_admin_read",
  "question_signals_admin_read",
  "question_labels_deny_anon",
  "question_signals_deny_anon",
]) {
  if (!sql.includes(required)) {
    fail(`missing question intelligence control: ${required}`);
  }
}

for (const acceptanceId of ["APV-01", "APV-02", "APV-03", "APV-04"]) {
  if (!authoringPublishVisibilityTests.includes(acceptanceId)) {
    fail(`missing authoring publish visibility marker ${acceptanceId}`);
  }
}

for (const [label, suite, markers] of [
  ["widget delivery", widgetDeliveryTests, ["WID-01", "WID-02", "WID-03", "WID-04", "WID-05", "WID-06"]],
  ["widget analytics", widgetAnalyticsTests, ["WAN-01", "WAN-02", "WAN-03", "WAN-04", "WAN-05"]],
  ["authored content retrieval", authoredContentRetrievalTests, ["ACR-01", "ACR-02", "ACR-03", "ACR-04", "ACR-05"]],
  ["operational safety", operationalSafetyTests, ["OPS-01", "OPS-02", "OPS-03", "OPS-04", "OPS-05"]],
]) {
  for (const acceptanceId of markers) {
    if (!suite.includes(acceptanceId)) {
      fail(`missing ${label} verification marker ${acceptanceId}`);
    }
  }
}

// The widget is the only surface reachable without a Supabase session. These
// controls are what keep a leaked widget key from becoming a tenant oracle.
for (const required of [
  "app_private.widget_resolve",
  "app_private.widget_origin_allowed",
  "app_private.widget_rate_limit",
  "app_private.widget_append_message",
  "tenant_widget_keys_deny_anon",
  "app_private.conversation_surface_view",
  "app_private.surface_visitor_key",
  "conversation_surfaces_deny_anon",
  // Authored content must reach retrieval, and imported knowledge must not be
  // silently replaced by a thinner authored projection.
  "app_private.knowledge_project_course",
  "app_private.knowledge_projection_hash",
  '"kind": "authored_content_blocks"',
]) {
  if (!sql.includes(required)) {
    fail(`missing widget/knowledge control: ${required}`);
  }
}

for (const table of widgetTables) {
  if (
    !sql.includes(`alter table public.${table} enable row level security`) ||
    !sql.includes(`alter table public.${table} force row level security`)
  ) {
    fail(`${table} is missing forced row level security`);
  }
}

// canAuthor must be read from the authoring gate itself, never restated as a
// role list, so the editor cannot be shown to a role the RPCs will refuse.
// Matched on collapsed whitespace so reformatting the SQL cannot break this.
const collapsedSql = sql.replace(/\s+/gu, " ");
if (
  !collapsedSql.includes(
    "'canAuthor', exists ( select 1 from app_private.authoring_rpc_context() )",
  ) &&
  !collapsedSql.includes(
    "'canAuthor', exists (select 1 from app_private.authoring_rpc_context())",
  )
) {
  fail(
    "learning_get_workspace must derive canAuthor from app_private.authoring_rpc_context()",
  );
}

for (const table of questionIntelligenceTables) {
  if (
    !sql.includes(`alter table public.${table} enable row level security`) ||
    !sql.includes(`alter table public.${table} force row level security`)
  ) {
    fail(`${table} is missing forced row level security`);
  }
}

// The agent columns arrive by ALTER, so tableBody() cannot see them.
for (const column of [
  "icon_glyph",
  "persona_instructions",
  "agent_tone",
  "agent_voice",
  "agent_course_scope",
]) {
  if (!sql.includes(`add column if not exists ${column}`)) {
    fail(`tenant_branding is missing agent column ${column}`);
  }
}

for (const required of [
  // Agent configuration: persona must never reach a learner payload.
  "app_private.agent_directive_for_tenant",
  "public.learning_get_agent_directive",
  "when caller.identity_role in ('tenant_owner', 'tenant_admin')",
  "tenant_private_branding_read",
  "tenant_private_branding_write_guard",
  "tenant_private_branding_delete_guard",
  // Analytics helpers and their supporting indexes.
  "app_private.analytics_context",
  "app_private.analytics_window",
  "app_private.analytics_metric",
  "messages_analytics_actor_time_idx",
  "conversations_analytics_context_idx",
  // Course editing revision and audit machinery.
  "app_private.authoring_commit_revision",
  "app_private.authoring_lock_course",
  "app_private.authoring_append_audit",
  // Platform tenant control.
  "app_private.platform_admin_tenant_sessions",
  "app_private.platform_admin_write_audit",
  "tenant_sections_deny_anon",
]) {
  if (!sql.includes(required)) {
    fail(`missing 2026-07-25 platform control: ${required}`);
  }
}

for (const table of tenantControlTables) {
  if (
    !sql.includes(`alter table public.${table} enable row level security`) ||
    !sql.includes(`alter table public.${table} force row level security`)
  ) {
    fail(`${table} is missing forced row level security`);
  }
}

for (const acceptanceId of [
  "DLC-01",
  "DLC-02",
  "DLC-03",
  "DLC-04",
  "DLC-05",
  "DLC-06",
]) {
  if (!durableLearningConversationTests.includes(acceptanceId)) {
    fail(`missing durable conversation verification marker ${acceptanceId}`);
  }
}

for (const required of [
  "app_private.learning_operation_secrets",
  "app_private.learning_operation_token_is_valid",
  "public.learning_start_conversation",
  "public.learning_get_conversations",
  "public.learning_record_user_message",
  "public.learning_record_assistant_message",
  "public.learning_get_completed_turn",
]) {
  if (!sql.includes(required)) {
    fail(`missing durable conversation control: ${required}`);
  }
}

for (const acceptanceId of ["DUR-01", "DUR-02", "DUR-03"]) {
  if (!durableExecutionTests.includes(acceptanceId)) {
    fail(`missing durable verification coverage marker ${acceptanceId}`);
  }
}

for (const acceptanceId of ["IAM-01", "IAM-02", "IAM-03"]) {
  if (!identityProvisioningTests.includes(acceptanceId)) {
    fail(`missing identity verification coverage marker ${acceptanceId}`);
  }
}

for (const acceptanceId of ["UPL-01", "UPL-02", "UPL-03"]) {
  if (!durableUploadTests.includes(acceptanceId)) {
    fail(`missing upload verification coverage marker ${acceptanceId}`);
  }
}

for (const acceptanceId of ["ONB-01", "ONB-02", "ONB-03"]) {
  if (!onboardingTests.includes(acceptanceId)) {
    fail(`missing onboarding verification coverage marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "AUTH-01",
  "AUTH-02",
  "AUTH-03",
  "AUTH-04",
  "AUTH-05",
]) {
  if (!authTenantBridgeTests.includes(acceptanceId)) {
    fail(`missing auth bridge verification coverage marker ${acceptanceId}`);
  }
}

for (const acceptanceId of [
  "ORPC-01",
  "ORPC-02",
  "ORPC-03",
  "ORPC-04",
  "ORPC-05",
]) {
  if (!authenticatedOnboardingRpcTests.includes(acceptanceId)) {
    fail(`missing onboarding RPC verification coverage marker ${acceptanceId}`);
  }
}

for (const required of [
  "list_active_identity_memberships",
  "resolve_identity_invitation_tenant",
  "resolve_identity_service_principal_tenant",
  "identity_memberships_deny_authenticated",
  "identity_invitation_acceptances_reject_update",
  "identity_scim_receipts_reject_update",
]) {
  if (!sql.includes(required)) {
    fail(`missing required identity control: ${required}`);
  }
}

for (const required of [
  "supabase_auth_context_for_user",
  "auth_bootstrap_tenant_owner",
  "auth_list_tenant_memberships",
  "auth_select_tenant",
  "auth_current_tenant_context",
  "learningbot_custom_access_token_hook",
]) {
  if (!sql.includes(required)) {
    fail(`missing required Supabase Auth bridge control: ${required}`);
  }
}

const onboardingRpcFunctions = [
  "onboarding_get_snapshot",
  "onboarding_update_tenant_profile",
  "onboarding_update_step",
  "onboarding_create_invitation",
  "onboarding_revoke_invitation",
  "onboarding_accept_invitation",
];
for (const functionName of onboardingRpcFunctions) {
  const marker = `create or replace function public.${functionName}(`;
  const start = sql.indexOf(marker);
  if (start < 0) fail(`missing authenticated onboarding RPC ${functionName}`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) fail(`unterminated authenticated onboarding RPC ${functionName}`);
  const body = sql.slice(start, end);
  if (!body.includes("security definer")) {
    fail(`${functionName} must be SECURITY DEFINER`);
  }
  if (!body.includes("set search_path = pg_catalog")) {
    fail(`${functionName} must fix search_path to pg_catalog`);
  }
  if (!sql.includes(`grant execute on function public.${functionName}(`)) {
    fail(`${functionName} is missing its authenticated execute grant`);
  }
}

const learningRpcFunctions = [
  "learning_get_workspace",
  "learning_mark_lesson_progress",
  "learning_create_course_draft",
  "learning_publish_course",
  "learning_search_chunks",
  // Agent configuration (20260725120000).
  "tenant_get_agent_configuration",
  "tenant_update_agent_configuration",
  "learning_get_agent_directive",
  // Learning analytics (20260725121000).
  "analytics_tenant_overview",
  "analytics_question_distribution",
  "analytics_answer_quality",
  "analytics_learner_progress",
  // Course editing (20260725122000).
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
  // Tenant section control (20260725123000).
  "tenant_get_sections",
  "platform_admin_set_tenant_section",
  "platform_admin_set_tenant_status",
  "platform_admin_enter_tenant",
  "platform_admin_exit_tenant",
  "platform_admin_tenant_detail",
  // Client provisioning (20260726090000).
  "platform_admin_create_tenant",
  "platform_admin_list_client_claims",
  "platform_admin_revoke_client_claim",
  // Question intelligence (20260726091000).
  "learning_record_question_label",
  "analytics_question_labels",
  "analytics_signals",
  "analytics_signal_review",
  // Widget delivery admin side (20260726093000). The three anon-granted
  // widget_* functions are deliberately excluded: this loop asserts an
  // authenticated grant, which they must not have.
  "tenant_get_widget_settings",
  "tenant_update_widget_settings",
  // Widget analytics (20260726094000).
  "learning_record_conversation_surface",
  "analytics_surface_breakdown",
  "analytics_widget_engagement",
  "analytics_widget_content_gaps",
  // Authored content retrieval (20260726095000). The *_embedding_work
  // functions are excluded for the same reason — they are worker-token gated,
  // never granted to authenticated.
  "learning_project_course_knowledge",
  "learning_course_knowledge_state",
];
for (const functionName of learningRpcFunctions) {
  const marker = `create or replace function public.${functionName}(`;
  const start = sql.indexOf(marker);
  if (start < 0) fail(`missing durable learning RPC ${functionName}`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) fail(`unterminated durable learning RPC ${functionName}`);
  const body = sql.slice(start, end);
  if (!body.includes("security definer")) {
    fail(`${functionName} must be SECURITY DEFINER`);
  }
  if (!body.includes("set search_path = pg_catalog")) {
    fail(`${functionName} must fix search_path to pg_catalog`);
  }
  if (!sql.includes(`grant execute on function public.${functionName}(`)) {
    fail(`${functionName} is missing its authenticated execute grant`);
  }
}
for (const forbidden of [
  "grant execute on function public.onboarding_get_snapshot()\n  to service_role",
  "grant execute on function public.onboarding_update_tenant_profile",
  "grant execute on function public.onboarding_update_step",
  "grant execute on function public.onboarding_create_invitation",
  "grant execute on function public.onboarding_revoke_invitation",
  "grant execute on function public.onboarding_accept_invitation",
]) {
  if (
    forbidden.includes("get_snapshot")
      ? sql.includes(forbidden)
      : sql.includes(`${forbidden}(\n`) &&
        sql.slice(sql.indexOf(`${forbidden}(\n`), sql.indexOf(`${forbidden}(\n`) + 400)
          .includes("to service_role")
  ) {
    fail("authenticated onboarding RPCs must not grant service_role execution");
  }
}

for (const required of [
  "learning_chunks_body_fts_idx",
  "websearch_to_tsquery('english', normalized_query)",
  "querytree(parsed_query) in ('', 'T')",
  "c.active_knowledge_version_id = ch.knowledge_version_id",
  "kv.status = 'published'",
  "d.status = 'ready'",
]) {
  if (!sql.includes(required)) {
    fail(`missing required grounded retrieval control: ${required}`);
  }
}
for (const required of [
  "onboarding_rpc_context",
  "onboarding_begin_command",
  "onboarding_complete_command",
  "onboarding_append_audit",
  "onboarding_snapshot_for_tenant",
  "policy_decision_required",
]) {
  if (!sql.includes(required)) {
    fail(`missing required onboarding RPC control: ${required}`);
  }
}

for (const required of [
  "onboarding_workspaces_deny_authenticated",
  "onboarding_steps_deny_authenticated",
  "identity_audit_events_deny_authenticated",
  "identity_audit_events_reject_update",
  "identity_audit_events_reject_delete",
]) {
  if (!sql.includes(required)) {
    fail(`missing required onboarding control: ${required}`);
  }
}

for (const required of [
  "upload_intents_deny_authenticated",
  "upload_callback_receipts_deny_authenticated",
  "upload_intents_protect_update",
  "upload_callback_receipts_reject_update",
]) {
  if (!sql.includes(required)) {
    fail(`missing required upload control: ${required}`);
  }
}

for (const ledger of ["audit_ledger", "cost_ledger"]) {
  if (!sql.includes(`${ledger}_reject_update`)) {
    fail(`${ledger} lacks immutable update protection`);
  }
  if (!sql.includes(`${ledger}_reject_delete`)) {
    fail(`${ledger} lacks immutable delete protection`);
  }
}

for (const immutableTable of ["course_revisions", "command_receipts"]) {
  if (!sql.includes(`${immutableTable}_reject_delete`)) {
    fail(`${immutableTable} lacks immutable delete protection`);
  }
}
if (!sql.includes("course_revisions_reject_update")) {
  fail("course_revisions lacks immutable update protection");
}
if (!sql.includes("protect_command_receipt_identity")) {
  fail("command_receipts lacks immutable identity protection");
}
if (!sql.includes("protect_telemetry_outbox_payload")) {
  fail("telemetry_outbox lacks immutable payload protection");
}
for (const required of [
  "user_access_accounts",
  "auth_current_access_state",
  "auth_complete_password_change",
  "admin_provision_auth_user",
  "learning_record_usage_event",
  "learning_usage_events_reject_update",
  "learning_usage_events_reject_delete",
]) {
  if (!sql.includes(required)) {
    fail(`missing managed access or usage control: ${required}`);
  }
}
if (!sql.includes("caller_membership_id")) {
  fail("usage events do not resolve the verified active membership");
}

const forbiddenCredentialAssignments = [
  /\bapi_key\s+text\b/i,
  /\baccess_token\s+text\b/i,
  /\brefresh_token\s+text\b/i,
  /\bpassword\s+text\b/i,
  /\bsecret_value\s+text\b/i,
];
for (const pattern of forbiddenCredentialAssignments) {
  if (pattern.test(sql)) fail(`raw credential column matched ${pattern}`);
}

console.log(
  `Verified ${migrationNames.length} ordered migrations, ${expectedTables.length} tables, 6 security controls, 3 durable execution controls, 3 identity controls, 3 upload controls, 3 onboarding controls, 5 auth controls, 5 onboarding RPC controls, 5 durable learning controls and 4 grounded retrieval controls.`,
);
