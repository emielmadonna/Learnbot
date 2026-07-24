import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const migration = await readFile(
  resolve(root, "migrations", "0011_supabase_auth_tenant_bridge.sql"),
  "utf8",
);
const acceptance = await readFile(
  resolve(root, "tests", "auth_tenant_bridge_verification.sql"),
  "utf8",
);

function fail(message) {
  throw new Error(`Auth tenant bridge verification failed: ${message}`);
}

for (const table of [
  "app_private.supabase_auth_principal_links",
  "app_private.supabase_auth_tenant_selections",
]) {
  if (!migration.includes(`create table ${table}`)) {
    fail(`missing private table ${table}`);
  }
}

for (const functionName of [
  "app_private.supabase_auth_context_for_user",
  "app_private.current_tenant_id",
  "app_private.current_app_role",
  "public.auth_bootstrap_tenant_owner",
  "public.auth_list_tenant_memberships",
  "public.auth_select_tenant",
  "public.auth_current_tenant_context",
  "public.learningbot_custom_access_token_hook",
]) {
  const declaration = new RegExp(
    `create or replace function\\s+${functionName.replaceAll(".", "\\.")}`,
    "i",
  );
  if (!declaration.test(migration)) fail(`missing function ${functionName}`);
}

const definerFunctions = [
  "app_private.supabase_auth_context_for_user",
  "app_private.current_tenant_id",
  "app_private.current_app_role",
  "public.auth_bootstrap_tenant_owner",
  "public.auth_list_tenant_memberships",
  "public.auth_select_tenant",
  "public.auth_current_tenant_context",
  "public.learningbot_custom_access_token_hook",
];
for (const functionName of definerFunctions) {
  const start = migration.indexOf(`function ${functionName}`);
  const end = migration.indexOf("$$;", start);
  if (start < 0 || end < 0) fail(`cannot inspect ${functionName}`);
  const declaration = migration.slice(start, end);
  if (!declaration.includes("security definer")) {
    fail(`${functionName} is not SECURITY DEFINER`);
  }
  if (!declaration.includes("set search_path = pg_catalog")) {
    fail(`${functionName} lacks a fixed search_path`);
  }
}

for (const required of [
  "from public, anon",
  "from public, anon, authenticated",
  "from public, anon, authenticated, service_role",
  "to authenticated",
  "to supabase_auth_admin",
]) {
  if (!migration.includes(required)) {
    fail(`missing privilege boundary: ${required}`);
  }
}

for (const required of [
  "auth.uid()",
  "supabase_auth_context_for_user",
  "m.status = 'active'",
  "m.deleted_at is null",
  "on conflict (auth_user_id) do update",
  "selection_version",
  "claims_refresh_required",
  "'auth.tenant_owner.bootstrap'",
  "'auth.tenant.select'",
  "'denied'",
  "'allowed'",
  "identity_audit_events",
]) {
  if (!migration.includes(required)) {
    fail(`missing authorization/durability control: ${required}`);
  }
}

if (
  /jwt_claims\(\)[\s\S]{0,120}(?:->|->>)\s*'user_metadata'/i.test(
    migration,
  )
) {
  fail("user_metadata is used by an authorization helper");
}
if (
  /raw_user_meta_data[\s\S]{0,120}(?:tenant|role|membership)/i.test(
    migration,
  )
) {
  fail("raw_user_meta_data is used for tenant authorization");
}

for (const marker of [
  "AUTH-01",
  "AUTH-02",
  "AUTH-03",
  "AUTH-04",
  "AUTH-05",
]) {
  if (!acceptance.includes(marker)) {
    fail(`missing SQL acceptance marker ${marker}`);
  }
}
for (const negativeControl of [
  "user_metadata established authorization",
  "cross-tenant selection changed context",
  "revoked membership retained access",
  "PUBLIC can execute a definer function",
  "authenticated read private links",
]) {
  if (!acceptance.includes(negativeControl)) {
    fail(`missing SQL negative assertion: ${negativeControl}`);
  }
}

console.log(
  "Verified Supabase Auth bridge: UID binding, durable membership selection, " +
    "refresh-aware claims, audit facts, definer privilege boundaries, and " +
    "AUTH-01..AUTH-05 SQL acceptance coverage.",
);
