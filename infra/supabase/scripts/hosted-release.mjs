#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const supabaseRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(supabaseRoot, "..", "..");
const migrationsDirectory = resolve(supabaseRoot, "migrations");
const linkedRefFile = resolve(supabaseRoot, ".temp", "project-ref");
const evidenceRoot = resolve(supabaseRoot, ".release-evidence");
const forbiddenProjectName = /\b(?:hook\s*lab|midway)\b/i;
const projectRefPattern = /^[a-z0-9]{20}$/;
const migrationNamePattern = /^(\d{4})_[a-z0-9_]+\.sql$/;
const maxApprovalLifetimeMs = 72 * 60 * 60 * 1000;
const maxPlanAgeMs = 30 * 60 * 1000;
const actions = new Set(["link", "plan", "apply", "verify"]);
export const hostedVerificationSuites = Object.freeze([
  "security_verification.sql",
  "durable_execution_primitives_verification.sql",
  "identity_provisioning_verification.sql",
  "durable_upload_intents_verification.sql",
  "onboarding_verification.sql",
  "auth_tenant_bridge_verification.sql",
  "authenticated_onboarding_rpcs_verification.sql",
]);

export function validateApproval(approval, fingerprint, action, now = new Date()) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw new Error("approval must be a JSON object");
  }
  if (approval.schemaVersion !== 1) {
    throw new Error("approval schemaVersion must be 1");
  }
  if (!projectRefPattern.test(approval.projectRef ?? "")) {
    throw new Error("projectRef must be the exact 20-character Supabase ref");
  }
  if (
    typeof approval.projectName !== "string" ||
    approval.projectName.trim().length < 3
  ) {
    throw new Error("projectName is required");
  }
  if (forbiddenProjectName.test(approval.projectName)) {
    throw new Error("the HookLab and Midway projects are outside this release lane");
  }
  if (!["staging", "production"].includes(approval.environment)) {
    throw new Error("environment must be staging or production");
  }
  if (
    typeof approval.expectedRegion !== "string" ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(approval.expectedRegion)
  ) {
    throw new Error("expectedRegion must be an exact cloud region identifier");
  }
  if (approval.dedicatedForLearningBot !== true) {
    throw new Error("dedicatedForLearningBot must be explicitly true");
  }
  if (approval.expectedDatabaseName !== "postgres") {
    throw new Error("expectedDatabaseName must be postgres");
  }
  if (
    typeof approval.expectedDatabaseRole !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(approval.expectedDatabaseRole)
  ) {
    throw new Error("expectedDatabaseRole must be an exact PostgreSQL role");
  }
  if (!/^[a-f0-9]{64}$/.test(approval.migrationFingerprint ?? "")) {
    throw new Error("migrationFingerprint must be a SHA-256 hex digest");
  }
  if (approval.migrationFingerprint !== fingerprint) {
    throw new Error("approval does not cover the current ordered migrations");
  }
  if (
    !Array.isArray(approval.allowedActions) ||
    !approval.allowedActions.every((value) => actions.has(value)) ||
    !approval.allowedActions.includes(action)
  ) {
    throw new Error(`approval does not allow ${action}`);
  }
  if (
    typeof approval.approvedBy !== "string" ||
    approval.approvedBy.trim().length < 2
  ) {
    throw new Error("approvedBy is required");
  }
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) {
    throw new Error("approvedAt and expiresAt must be ISO timestamps");
  }
  if (approvedAt > nowMs + 5 * 60 * 1000) {
    throw new Error("approval is dated in the future");
  }
  if (expiresAt <= nowMs) {
    throw new Error("approval has expired");
  }
  if (expiresAt <= approvedAt || expiresAt - approvedAt > maxApprovalLifetimeMs) {
    throw new Error("approval lifetime must be positive and no more than 72 hours");
  }
  return approval;
}

export function validateDatabaseUrl(rawUrl, approval) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("SUPABASE_DATABASE_URL must be a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("SUPABASE_DATABASE_URL must use PostgreSQL");
  }
  if (!url.password) {
    throw new Error("SUPABASE_DATABASE_URL must include an ephemeral password");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (databaseName !== approval.expectedDatabaseName) {
    throw new Error("database URL name does not match the approval");
  }
  const username = decodeURIComponent(url.username);
  const refInUsername = username.split(".").at(-1);
  const refInHost = url.hostname.split(".").includes(approval.projectRef);
  if (refInUsername !== approval.projectRef && !refInHost) {
    throw new Error("database URL is not bound to the approved project ref");
  }
  const sslMode = url.searchParams.get("sslmode");
  if (!["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error("database URL must explicitly require strict TLS");
  }
  return {
    databaseName,
    hostname: url.hostname,
    username,
  };
}

export function validatePlanEvidence(manifest, approval, fingerprint, now = new Date()) {
  if (manifest?.kind !== "supabase-hosted-release-plan") {
    throw new Error("plan evidence has the wrong kind");
  }
  if (
    manifest.projectRef !== approval.projectRef ||
    manifest.environment !== approval.environment ||
    manifest.expectedRegion !== approval.expectedRegion ||
    manifest.migrationFingerprint !== fingerprint
  ) {
    throw new Error("plan evidence does not match this release");
  }
  const createdAt = Date.parse(manifest.createdAt);
  if (!Number.isFinite(createdAt) || now.getTime() - createdAt > maxPlanAgeMs) {
    throw new Error("plan evidence is older than 30 minutes");
  }
  if (createdAt > now.getTime() + 60_000 || manifest.success !== true) {
    throw new Error("plan evidence is invalid or unsuccessful");
  }
  return manifest;
}

async function migrationManifest() {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) throw new Error("no migrations found");
  const numbers = names.map((name) => {
    const match = migrationNamePattern.exec(name);
    if (!match) throw new Error(`invalid migration filename ${name}`);
    return Number(match[1]);
  });
  numbers.forEach((number, index) => {
    if (number !== index + 1) {
      throw new Error("migrations must be an unbroken sequence beginning at 0001");
    }
  });
  const hash = createHash("sha256");
  const files = [];
  for (const name of names) {
    const contents = await readFile(resolve(migrationsDirectory, name));
    const fileHash = createHash("sha256").update(contents).digest("hex");
    hash.update(`${name}\0${fileHash}\n`);
    files.push({ name, sha256: fileHash });
  }
  return { fingerprint: hash.digest("hex"), files };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--") || index + 1 >= rest.length) {
      throw new Error(`invalid argument ${key}`);
    }
    options[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function redact(text) {
  const secrets = [
    process.env.SUPABASE_DB_PASSWORD,
    process.env.SUPABASE_DATABASE_URL,
    process.env.SUPABASE_ACCESS_TOKEN,
  ].filter(Boolean);
  return secrets.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"),
    String(text),
  );
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${output.trim()}`);
  }
  return output.trim();
}

async function readApproval(path, fingerprint, action) {
  if (!path) throw new Error("--approval is required");
  const approval = JSON.parse(await readFile(resolve(path), "utf8"));
  return validateApproval(approval, fingerprint, action);
}

async function assertLinkedRef(expectedRef) {
  let linkedRef;
  try {
    linkedRef = (await readFile(linkedRefFile, "utf8")).trim();
  } catch {
    throw new Error("Supabase is not linked; run the guarded link action first");
  }
  if (linkedRef !== expectedRef) {
    throw new Error(
      `linked project mismatch: expected ${expectedRef}, found ${linkedRef || "empty"}`,
    );
  }
}

function requireDatabasePassword() {
  if (!process.env.SUPABASE_DB_PASSWORD) {
    throw new Error("SUPABASE_DB_PASSWORD is required and must not be written to disk");
  }
}

async function verifyProjectCatalog(approval) {
  const output = run("supabase", ["projects", "list", "--output", "json"]);
  const projects = JSON.parse(output);
  const project = projects.find((item) => item.id === approval.projectRef);
  if (!project) throw new Error("approved project ref is unavailable to this CLI profile");
  if (project.name !== approval.projectName) {
    throw new Error(
      `project name mismatch: approval says ${approval.projectName}, catalog says ${project.name}`,
    );
  }
  if (project.region !== approval.expectedRegion) {
    throw new Error(
      `project region mismatch: approval says ${approval.expectedRegion}, catalog says ${project.region ?? "unknown"}`,
    );
  }
  if (forbiddenProjectName.test(project.name)) {
    throw new Error("the selected project is explicitly outside this release lane");
  }
  if (project.status !== "ACTIVE_HEALTHY") {
    throw new Error(`approved project is not healthy: ${project.status ?? "unknown"}`);
  }
  return { id: project.id, name: project.name, region: project.region, status: project.status };
}

async function evidenceDirectory(approval, action) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const directory = resolve(
    evidenceRoot,
    `${stamp}-${approval.environment}-${approval.projectRef}-${action}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function writeEvidence(directory, name, contents) {
  await writeFile(resolve(directory, name), redact(contents), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function verifyDatabaseIdentity(approval) {
  const rawUrl = process.env.SUPABASE_DATABASE_URL;
  if (!rawUrl) {
    throw new Error("SUPABASE_DATABASE_URL is required for SQL verification");
  }
  validateDatabaseUrl(rawUrl, approval);
  const output = run(
    "psql",
    [
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--field-separator",
      "|",
      "--command",
      "select 'LEARNINGBOT_DB_IDENTITY:' || current_user || ':' || current_database();",
    ],
    { PGDATABASE: rawUrl },
  );
  const identityLine = output
    .split("\n")
    .find((line) => line.startsWith("LEARNINGBOT_DB_IDENTITY:"));
  if (!identityLine) throw new Error("database identity query returned no trusted marker");
  const [, role, database] = identityLine.split(":");
  if (role !== approval.expectedDatabaseRole) {
    throw new Error(`database role mismatch: expected ${approval.expectedDatabaseRole}`);
  }
  if (database !== approval.expectedDatabaseName) {
    throw new Error(`database name mismatch: expected ${approval.expectedDatabaseName}`);
  }
  return { role, database };
}

async function verifyMigrationHistory(approval, migration) {
  const output = run(
    "psql",
    [
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--command",
      "select 'LEARNINGBOT_MIGRATION:' || version from supabase_migrations.schema_migrations order by version;",
    ],
    { PGDATABASE: process.env.SUPABASE_DATABASE_URL },
  );
  const actual = output
    .split("\n")
    .filter((line) => line.startsWith("LEARNINGBOT_MIGRATION:"))
    .map((line) => line.slice("LEARNINGBOT_MIGRATION:".length));
  const expected = migration.files.map((file) => file.name.slice(0, 4));
  if (
    actual.length !== expected.length ||
    actual.some((version, index) => version !== expected[index])
  ) {
    throw new Error(
      `remote migration history mismatch for approved project ${approval.projectRef}`,
    );
  }
  return actual;
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const migration = await migrationManifest();

  if (command === "fingerprint") {
    console.log(migration.fingerprint);
    return;
  }
  if (command === "inspect") {
    console.log(JSON.stringify(migration, null, 2));
    return;
  }
  if (!actions.has(command)) {
    throw new Error("usage: hosted-release.mjs fingerprint|inspect|link|plan|apply|verify");
  }

  const approval = await readApproval(options.approval, migration.fingerprint, command);

  if (command === "link") {
    requireDatabasePassword();
    const project = await verifyProjectCatalog(approval);
    const databaseIdentity = await verifyDatabaseIdentity(approval);
    run("supabase", [
      "link",
      "--workdir",
      "infra",
      "--project-ref",
      approval.projectRef,
      "--yes",
    ]);
    await assertLinkedRef(approval.projectRef);
    console.log(
      `Linked ${project.name} (${approval.environment}, ${project.id}) as ${databaseIdentity.role}.`,
    );
    return;
  }

  await assertLinkedRef(approval.projectRef);
  requireDatabasePassword();
  const project = await verifyProjectCatalog(approval);
  const databaseIdentity = await verifyDatabaseIdentity(approval);

  if (command === "plan") {
    const directory = await evidenceDirectory(approval, command);
    const migrationList = run("supabase", [
      "migration",
      "list",
      "--workdir",
      "infra",
      "--linked",
    ]);
    const dryRun = run("supabase", [
      "db",
      "push",
      "--workdir",
      "infra",
      "--linked",
      "--dry-run",
    ]);
    await writeEvidence(directory, "migration-list.txt", migrationList);
    await writeEvidence(directory, "dry-run.txt", dryRun);
    const manifest = {
      kind: "supabase-hosted-release-plan",
      createdAt: new Date().toISOString(),
      success: true,
      projectRef: approval.projectRef,
      projectName: project.name,
      environment: approval.environment,
      expectedRegion: approval.expectedRegion,
      migrationFingerprint: migration.fingerprint,
      databaseIdentity,
      migrations: migration.files,
    };
    await writeEvidence(directory, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Plan passed. Evidence: ${resolve(directory, "manifest.json")}`);
    return;
  }

  if (command === "apply") {
    if (!options["plan-evidence"]) throw new Error("--plan-evidence is required");
    const plan = JSON.parse(await readFile(resolve(options["plan-evidence"]), "utf8"));
    validatePlanEvidence(plan, approval, migration.fingerprint);
    const expectedConfirmation = `APPLY:${approval.environment}:${approval.projectRef}:${migration.fingerprint}`;
    if (process.env.SUPABASE_RELEASE_CONFIRMATION !== expectedConfirmation) {
      throw new Error(
        `SUPABASE_RELEASE_CONFIRMATION must exactly equal ${expectedConfirmation}`,
      );
    }
    const directory = await evidenceDirectory(approval, command);
    const output = run("supabase", [
      "db",
      "push",
      "--workdir",
      "infra",
      "--linked",
      "--yes",
    ]);
    await writeEvidence(directory, "apply.txt", output);
    const migrationHistory = await verifyMigrationHistory(approval, migration);
    const migrationList = run("supabase", [
      "migration",
      "list",
      "--workdir",
      "infra",
      "--linked",
    ]);
    await writeEvidence(directory, "migration-list-after-apply.txt", migrationList);
    await writeEvidence(
      directory,
      "manifest.json",
      `${JSON.stringify({
        kind: "supabase-hosted-release-apply",
        createdAt: new Date().toISOString(),
        success: true,
        projectRef: approval.projectRef,
        projectName: project.name,
        environment: approval.environment,
        expectedRegion: approval.expectedRegion,
        migrationFingerprint: migration.fingerprint,
        databaseIdentity,
        migrationHistory,
      }, null, 2)}\n`,
    );
    console.log(`Migrations applied to ${project.name}. Evidence: ${directory}`);
    return;
  }

  const migrationHistory = await verifyMigrationHistory(approval, migration);
  const directory = await evidenceDirectory(approval, command);
  const suites = hostedVerificationSuites;
  for (const suite of suites) {
    const output = run(
      "psql",
      [
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--file",
        resolve(supabaseRoot, "tests", suite),
      ],
      { PGDATABASE: process.env.SUPABASE_DATABASE_URL },
    );
    await writeEvidence(directory, `${suite}.txt`, output);
  }
  await writeEvidence(
    directory,
    "manifest.json",
    `${JSON.stringify({
      kind: "supabase-hosted-release-verification",
      createdAt: new Date().toISOString(),
      success: true,
      projectRef: approval.projectRef,
      projectName: project.name,
      environment: approval.environment,
      expectedRegion: approval.expectedRegion,
      migrationFingerprint: migration.fingerprint,
      databaseIdentity,
      migrationHistory,
      suites,
    }, null, 2)}\n`,
  );
  console.log(`All hosted SQL suites passed. Evidence: ${directory}`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error) => {
    console.error(`Supabase hosted release refused: ${redact(error.message)}`);
    process.exitCode = 1;
  });
}
