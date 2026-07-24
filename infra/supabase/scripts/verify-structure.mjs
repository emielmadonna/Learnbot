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
const expectedTables = [
  ...manifestTables,
  ...durableExecutionTables,
  ...identityTenantTables,
  ...globalIdentityTables,
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
  `Verified ${migrationNames.length} ordered migrations, ${expectedTables.length} tables, 6 security controls, 3 durable execution controls and 3 identity controls.`,
);
