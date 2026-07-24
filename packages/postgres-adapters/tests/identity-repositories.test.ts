import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableAdapterError,
  PostgresIdentityPrincipalRepository,
  PostgresInvitationRepository,
  PostgresMembershipRepository,
  PostgresScimStateRepository,
  PostgresServicePrincipalRepository,
  PostgresTenantIdentityRepository,
  type PostgresExecutor,
  type PostgresTransaction,
  type SqlQueryResult,
} from "../src/index.js";

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: QueryCall[] = [];

  constructor(private readonly results: SqlQueryResult<object>[]) {}

  async transaction<TResult>(
    work: (transaction: PostgresTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return work({
      query: async <TRow extends object>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlQueryResult<TRow>> => {
        this.calls.push({ text, values });
        const result = this.results.shift();
        if (result === undefined) {
          throw new Error(`No scripted result for SQL: ${text}`);
        }
        return result as SqlQueryResult<TRow>;
      },
    });
  }
}

function rows(...items: object[]): SqlQueryResult<object> {
  return { rows: items, rowCount: items.length };
}

const tenantId = "10000000-0000-4000-8000-000000000001";
const principalId = "principal_opaque";
const now = "2026-07-23T12:00:00.000Z";
const membershipRow = {
  membership_id: "membership_1",
  tenant_id: tenantId,
  principal_id: principalId,
  role: "service",
  status: "active",
  provisioned_by: "scim",
  created_at: now,
  updated_at: now,
};

test("verified principal registration is exact and conflict-safe", async () => {
  const database = new ScriptedExecutor([
    rows({
      principal_id: principalId,
      principal_kind: "human",
      authentication_method: "oidc",
      issuer: "https://id.example",
      subject: "subject-1",
      created_at: now,
      updated_at: now,
    }),
  ]);
  const repository = new PostgresIdentityPrincipalRepository(database);

  const principal = await repository.registerVerified(
    {
      principalId,
      kind: "human",
      method: "oidc",
      issuer: "https://id.example",
      subject: "subject-1",
      authenticatedAt: now,
      grantedScopes: new Set(),
    },
    now,
  );

  assert.equal(principal.principalId, principalId);
  assert.ok(
    /on conflict \(authentication_method, issuer, subject\)/.test(
      database.calls[0]!.text,
    ),
  );
  assert.ok(/principal_id = \$1/.test(database.calls[0]!.text));
  assert.deepEqual(database.calls[0]!.values.slice(0, 5), [
    principalId,
    "human",
    "oidc",
    "https://id.example",
    "subject-1",
  ]);

  const conflictDatabase = new ScriptedExecutor([{ rows: [], rowCount: 0 }]);
  await assert.rejects(
    () =>
      new PostgresIdentityPrincipalRepository(conflictDatabase).registerVerified(
        {
          principalId,
          kind: "human",
          method: "oidc",
          issuer: "https://id.example",
          subject: "subject-1",
          authenticatedAt: now,
          grantedScopes: new Set(),
        },
        now,
      ),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.idempotency_conflict",
  );
});

test("membership bootstrap is principal-exact and tenant operations remain scoped", async () => {
  const listDatabase = new ScriptedExecutor([rows(membershipRow)]);
  const list = await new PostgresMembershipRepository(
    listDatabase,
  ).listActiveForPrincipal(principalId);
  assert.equal(list[0]!.role, "service");
  assert.ok(
    /app_private\.list_active_identity_memberships\(\$1\)/.test(
      listDatabase.calls[0]!.text,
    ),
  );
  assert.deepEqual(listDatabase.calls[0]!.values, [principalId]);

  const findDatabase = new ScriptedExecutor([rows(membershipRow)]);
  await new PostgresMembershipRepository(findDatabase).find(
    principalId,
    tenantId,
  );
  assert.ok(
    /where tenant_id = \$1 and principal_id = \$2/.test(
      findDatabase.calls[0]!.text,
    ),
  );
  assert.deepEqual(findDatabase.calls[0]!.values, [tenantId, principalId]);

  const noQueryDatabase = new ScriptedExecutor([]);
  await assert.rejects(() =>
    new PostgresMembershipRepository(noQueryDatabase).upsert({
      tenantId,
      principalId,
      role: "platform_admin",
      provisionedBy: "manual",
      now,
    }),
  );
  assert.equal(noQueryDatabase.calls.length, 0);
});

test("tenant identity requires explicit typed settings and never invents policy", async () => {
  const validDatabase = new ScriptedExecutor([
    rows({
      tenant_id: tenantId,
      slug: "tenant-a",
      status: "active",
      region: "us-west",
      settings: {
        planId: "enterprise",
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        featureFlags: { realtimeVoice: true },
        limits: { seats: 100 },
        policyVersion: "identity-v1",
      },
      updated_at: now,
    }),
  ]);
  const tenant = await new PostgresTenantIdentityRepository(
    validDatabase,
  ).getActive(tenantId);
  assert.equal(tenant?.policyVersion, "identity-v1");
  assert.deepEqual(validDatabase.calls[0]!.values, [tenantId]);
  assert.ok(/where tenant_id = \$1/.test(validDatabase.calls[0]!.text));

  const incompleteDatabase = new ScriptedExecutor([
    rows({
      tenant_id: tenantId,
      slug: "tenant-a",
      status: "active",
      region: null,
      settings: {},
      updated_at: now,
    }),
  ]);
  await assert.rejects(
    () =>
      new PostgresTenantIdentityRepository(incompleteDatabase).getActive(
        tenantId,
      ),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.invalid_row",
  );
});

test("service-principal lookup bootstraps tenant then uses both predicates", async () => {
  const database = new ScriptedExecutor([
    rows({ tenant_id: tenantId }),
    rows({
      service_principal_id: "service_1",
      tenant_id: tenantId,
      client_id: "client_1",
      status: "active",
      scopes: ["scim:write"],
      created_at: now,
    }),
  ]);
  const service = await new PostgresServicePrincipalRepository(
    database,
  ).findByClientId("client_1");
  assert.equal(service?.tenantId, tenantId);
  assert.ok(
    /resolve_identity_service_principal_tenant\(\$1\)/.test(
      database.calls[0]!.text,
    ),
  );
  assert.ok(
    /where tenant_id = \$1 and client_id = \$2/.test(
      database.calls[1]!.text,
    ),
  );
  assert.deepEqual(database.calls[1]!.values, [tenantId, "client_1"]);
});

test("invitation acceptance replay never updates immutable facts", async () => {
  const database = new ScriptedExecutor([
    rows({ tenant_id: tenantId }),
    { rows: [], rowCount: 0 },
    rows({ principal_id: principalId, membership_id: "membership_1" }),
  ]);
  await new PostgresInvitationRepository(database).saveAcceptance({
    invitationId: "invitation_1",
    idempotencyKey: "accept-1",
    principalId,
    membershipId: "membership_1",
  });
  assert.ok(/on conflict .* do nothing/s.test(database.calls[1]!.text));
  assert.ok(!/do update/i.test(database.calls[1]!.text));
  assert.ok(/tenant_id = \$1/.test(database.calls[2]!.text));
  assert.deepEqual(database.calls[2]!.values, [
    tenantId,
    "invitation_1",
    "accept-1",
    principalId,
    "membership_1",
  ]);

  const conflictDatabase = new ScriptedExecutor([
    rows({ tenant_id: tenantId }),
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ]);
  await assert.rejects(
    () =>
      new PostgresInvitationRepository(conflictDatabase).saveAcceptance({
        invitationId: "invitation_1",
        idempotencyKey: "accept-1",
        principalId: "attacker",
        membershipId: "membership_2",
      }),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.idempotency_conflict",
  );
});

test("SCIM receipts are tenant-scoped immutable replays and reject cross-tenant data", async () => {
  const membership = {
    membershipId: "membership_1",
    tenantId,
    principalId,
    role: "student" as const,
    status: "active" as const,
    provisionedBy: "scim" as const,
    createdAt: now,
    updatedAt: now,
  };
  const database = new ScriptedExecutor([
    { rows: [], rowCount: 0 },
    rows({ membership_id: "membership_1" }),
  ]);
  await new PostgresScimStateRepository(database).saveIdempotentResult(
    tenantId,
    "scim-1",
    membership,
  );
  assert.ok(/on conflict .* do nothing/s.test(database.calls[0]!.text));
  assert.ok(!/do update/i.test(database.calls[0]!.text));
  assert.ok(/where tenant_id = \$1/.test(database.calls[1]!.text));

  const hostileDatabase = new ScriptedExecutor([]);
  await assert.rejects(
    () =>
      new PostgresScimStateRepository(hostileDatabase).saveIdempotentResult(
        tenantId,
        "scim-1",
        { ...membership, tenantId: "other-tenant" },
      ),
    (error: unknown) =>
      error instanceof DurableAdapterError &&
      error.code === "durable.idempotency_conflict",
  );
  assert.equal(hostileDatabase.calls.length, 0);
});
