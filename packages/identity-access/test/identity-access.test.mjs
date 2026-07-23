import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicHostSignatureVerifier,
  DeterministicIdentityIds,
  FixedClock,
  HostContextVerifier,
  IdentityAccessError,
  IdentityAccessService,
  MemoryAuditSink,
  MemoryHostVerificationKeyResolver,
  MemoryInvitationRepository,
  MemoryMembershipRepository,
  MemoryReplayStore,
  MemoryScimStateRepository,
  MemoryServicePrincipalRepository,
  MemoryTenantIdentityRepository,
  assertCanAssignRole,
  assertIdentityPermission,
  createDeterministicHostToken,
  sanitizeSafeDetails,
  toSafeIdentityError,
} from "../dist/index.js";

const NOW_SECONDS = 1_700_000_000;
const NOW = new Date(NOW_SECONDS * 1000);
const ids = new DeterministicIdentityIds();

function tenant(tenantId) {
  return {
    tenantId,
    slug: tenantId,
    status: "active",
    planId: "enterprise",
    locale: "en-US",
    timeZone: "UTC",
    featureFlags: {},
    limits: {},
    policyVersion: "identity-v1",
    resolvedAt: NOW.toISOString(),
  };
}

function assertion(overrides = {}) {
  return {
    method: "oidc",
    issuer: "https://id.example.test",
    subject: "user-123",
    email: "learner@example.test",
    authenticatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function membershipFor(assertionValue, tenantId, role = "student") {
  const principalId = ids.deterministic(
    "principal",
    `${assertionValue.method}\u0000${assertionValue.issuer}\u0000${assertionValue.subject}`,
  );
  return {
    membershipId: `membership_${tenantId}_${role}`,
    tenantId,
    principalId,
    role,
    status: "active",
    provisionedBy: "manual",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function invitation(overrides = {}) {
  return {
    invitationId: "invitation_1",
    tenantId: "tenant_a",
    email: "learner@example.test",
    role: "student",
    status: "pending",
    expiresAt: new Date((NOW_SECONDS + 600) * 1000).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeService({
  memberships = [],
  servicePrincipals = [],
  invitations = [],
} = {}) {
  const membershipRepository = new MemoryMembershipRepository(memberships);
  const invitationRepository = new MemoryInvitationRepository(invitations);
  const audit = new MemoryAuditSink();
  const scim = new MemoryScimStateRepository();
  const service = new IdentityAccessService({
    memberships: membershipRepository,
    tenants: new MemoryTenantIdentityRepository([
      tenant("tenant_a"),
      tenant("tenant_b"),
    ]),
    servicePrincipals: new MemoryServicePrincipalRepository(servicePrincipals),
    invitations: invitationRepository,
    scim,
    audit,
    clock: new FixedClock(NOW),
    ids,
  });
  return { service, membershipRepository, invitationRepository, audit, scim };
}

function sessionInput(assertionValue, selectedTenantId) {
  return {
    assertion: assertionValue,
    ...(selectedTenantId === undefined ? {} : { selectedTenantId }),
    requestId: "request_1",
    traceId: "trace_1",
    deadlineMs: NOW.getTime() + 10_000,
    environment: "test",
  };
}

function hostVerifier({ keys, audience = "learningbot-embed" }) {
  return new HostContextVerifier({
    policy: {
      trustedIssuer: "https://host.example.test",
      audience,
      allowedAlgorithms: ["FAKE-HASH"],
      maximumLifetimeSeconds: 120,
      clockSkewSeconds: 2,
    },
    keys: new MemoryHostVerificationKeyResolver(keys),
    signatures: new DeterministicHostSignatureVerifier(),
    replay: new MemoryReplayStore(),
    clock: new FixedClock(NOW),
    audit: new MemoryAuditSink(),
  });
}

function hostToken({
  kid = "key-current",
  secret = "current-secret",
  audience = "learningbot-embed",
  nonce = "nonce-12345678",
  issuedAt = NOW_SECONDS - 5,
  expiresAt = NOW_SECONDS + 60,
} = {}) {
  return createDeterministicHostToken({
    header: { alg: "FAKE-HASH", kid, typ: "JWT" },
    claims: {
      iss: "https://host.example.test",
      aud: audience,
      sub: "host-user-1",
      tenantId: "tenant_a",
      nonce,
      iat: issuedAt,
      exp: expiresAt,
      sessionId: "host-session-1",
    },
    secret,
  });
}

test("normalizes provider-neutral OIDC and SAML assertions into stable principals", () => {
  const { service } = makeService();
  const oidc = service.normalize(assertion());
  const saml = service.normalize(
    assertion({ method: "saml", subject: "name-id-7" }),
  );
  assert.equal(oidc.method, "oidc");
  assert.equal(oidc.kind, "human");
  assert.equal(oidc.principalId, service.normalize(assertion()).principalId);
  assert.equal(saml.method, "saml");
  assert.notEqual(saml.principalId, oidc.principalId);
});

test("denies cross-tenant selection even when the client supplies a valid tenant identifier", async () => {
  const identity = assertion();
  const { service, audit } = makeService({
    memberships: [membershipFor(identity, "tenant_a")],
  });
  await assert.rejects(
    service.resolveSession(sessionInput(identity, "tenant_b")),
    (error) =>
      error instanceof IdentityAccessError &&
      error.code === "ACCESS_DENIED" &&
      !error.message.includes("tenant_b"),
  );
  assert.equal(audit.events.at(-1)?.outcome, "denied");
  assert.equal(audit.events.at(-1)?.tenantId, undefined);
});

test("requires explicit selection for multiple memberships but accepts a membership-backed selector", async () => {
  const identity = assertion();
  const { service } = makeService({
    memberships: [
      membershipFor(identity, "tenant_a"),
      membershipFor(identity, "tenant_b"),
    ],
  });
  await assert.rejects(
    service.resolveSession(sessionInput(identity)),
    (error) =>
      error instanceof IdentityAccessError &&
      error.code === "TENANT_SELECTION_REQUIRED",
  );
  const resolved = await service.resolveSession(
    sessionInput(identity, "tenant_b"),
  );
  assert.equal(resolved.request.tenantId, "tenant_b");
  assert.equal(resolved.role, "student");
});

test("rejects forged, expired, and replayed host tokens", async () => {
  const key = {
    keyId: "key-current",
    algorithm: "FAKE-HASH",
    material: "current-secret",
  };

  await assert.rejects(
    hostVerifier({ keys: [key] }).verify(
      hostToken({ secret: "attacker-secret" }),
    ),
    (error) =>
      error instanceof IdentityAccessError && error.code === "TOKEN_INVALID",
  );

  await assert.rejects(
    hostVerifier({ keys: [key] }).verify(
      hostToken({
        nonce: "nonce-expired-1",
        issuedAt: NOW_SECONDS - 100,
        expiresAt: NOW_SECONDS - 3,
      }),
    ),
    (error) =>
      error instanceof IdentityAccessError && error.code === "TOKEN_EXPIRED",
  );

  const replayVerifier = hostVerifier({ keys: [key] });
  const token = hostToken({ nonce: "nonce-replay-1" });
  await replayVerifier.verify(token);
  await assert.rejects(
    replayVerifier.verify(token),
    (error) =>
      error instanceof IdentityAccessError && error.code === "TOKEN_REPLAYED",
  );
});

test("supports key rotation by kid and rejects a retired key", async () => {
  const verifier = hostVerifier({
    keys: [
      {
        keyId: "key-old",
        algorithm: "FAKE-HASH",
        material: "old-secret",
        retiredAfterMs: NOW.getTime(),
      },
      {
        keyId: "key-current",
        algorithm: "FAKE-HASH",
        material: "current-secret",
        activeFromMs: NOW.getTime() - 1_000,
      },
    ],
  });
  await assert.rejects(
    verifier.verify(
      hostToken({
        kid: "key-old",
        secret: "old-secret",
        nonce: "nonce-old-key1",
      }),
    ),
    (error) =>
      error instanceof IdentityAccessError && error.code === "TOKEN_INVALID",
  );
  const result = await verifier.verify(
    hostToken({ nonce: "nonce-new-key1" }),
  );
  assert.equal(result.tenantBinding, "tenant_a");
});

test("blocks confused-deputy audience mismatch after signature verification", async () => {
  const verifier = hostVerifier({
    keys: [
      {
        keyId: "key-current",
        algorithm: "FAKE-HASH",
        material: "current-secret",
      },
    ],
  });
  await assert.rejects(
    verifier.verify(
      hostToken({ audience: "billing-api", nonce: "nonce-wrong-aud" }),
    ),
    (error) =>
      error instanceof IdentityAccessError && error.code === "TOKEN_INVALID",
  );
});

test("host tenant binding still requires an active membership", async () => {
  const verified = await hostVerifier({
    keys: [
      {
        keyId: "key-current",
        algorithm: "FAKE-HASH",
        material: "current-secret",
      },
    ],
  }).verify(hostToken({ nonce: "nonce-no-member" }));
  const { service } = makeService();
  await assert.rejects(
    service.resolveSession(sessionInput(verified, "tenant_a")),
    (error) =>
      error instanceof IdentityAccessError && error.code === "ACCESS_DENIED",
  );
});

test("denies role escalation outside the delegable role lattice", () => {
  assert.throws(
    () => assertCanAssignRole("teacher", "tenant_admin"),
    (error) =>
      error instanceof IdentityAccessError && error.code === "ACCESS_DENIED",
  );
  assert.doesNotThrow(() => assertCanAssignRole("tenant_admin", "teacher"));
  assert.throws(
    () => assertCanAssignRole("tenant_admin", "tenant_owner"),
    IdentityAccessError,
  );
});

test("intersects service-principal registration, assertion scopes, and service-role permissions", async () => {
  const serviceAssertion = assertion({
    method: "service_principal",
    issuer: "https://auth.example.test",
    subject: "client-42",
    servicePrincipalId: "client-42",
    grantedScopes: ["course:read"],
    email: undefined,
  });
  const { service } = makeService({
    memberships: [membershipFor(serviceAssertion, "tenant_a", "service")],
    servicePrincipals: [
      {
        servicePrincipalId: "sp_42",
        tenantId: "tenant_a",
        clientId: "client-42",
        status: "active",
        scopes: ["course:read"],
        createdAt: NOW.toISOString(),
      },
    ],
  });
  const resolved = await service.resolveSession(
    sessionInput(serviceAssertion, "tenant_a"),
  );
  assertIdentityPermission(resolved.permissions, "course.read");
  assert.throws(
    () => assertIdentityPermission(resolved.permissions, "job.write"),
    (error) =>
      error instanceof IdentityAccessError && error.code === "ACCESS_DENIED",
  );

  await assert.rejects(
    service.resolveSession(
      sessionInput(
        {
          ...serviceAssertion,
          grantedScopes: ["course:read", "job:write"],
        },
        "tenant_a",
      ),
    ),
    (error) =>
      error instanceof IdentityAccessError && error.code === "ACCESS_DENIED",
  );
});

test("accepts invitations idempotently without duplicating membership", async () => {
  const { service, membershipRepository } = makeService({
    invitations: [invitation()],
  });
  const principal = service.normalize(assertion());
  const first = await service.acceptInvitation({
    invitationId: "invitation_1",
    principal,
    idempotencyKey: "accept-key-1",
  });
  const replay = await service.acceptInvitation({
    invitationId: "invitation_1",
    principal,
    idempotencyKey: "accept-key-1",
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.membership.membershipId, first.membership.membershipId);
  assert.equal(membershipRepository.records.length, 1);
});

test("SCIM-style provisioning is tenant-bound, scoped, idempotent, and deprovisions membership", async () => {
  const serviceAssertion = assertion({
    method: "service_principal",
    issuer: "https://auth.example.test",
    subject: "scim-client",
    servicePrincipalId: "scim-client",
    grantedScopes: ["scim:write"],
    email: undefined,
  });
  const fixture = makeService({
    memberships: [membershipFor(serviceAssertion, "tenant_a", "service")],
    servicePrincipals: [
      {
        servicePrincipalId: "sp_scim",
        tenantId: "tenant_a",
        clientId: "scim-client",
        status: "active",
        scopes: ["scim:write"],
        createdAt: NOW.toISOString(),
      },
    ],
  });
  const actor = await fixture.service.resolveSession(
    sessionInput(serviceAssertion, "tenant_a"),
  );
  const command = {
    tenantId: "tenant_a",
    externalId: "directory-user-9",
    principalId: "principal_directory_9",
    role: "teacher",
    active: true,
    idempotencyKey: "scim-write-1",
  };
  const first = await fixture.service.provisionScimUser(actor, command);
  const replay = await fixture.service.provisionScimUser(actor, command);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.membership.role, "teacher");
  await assert.rejects(
    fixture.service.provisionScimUser(actor, {
      ...command,
      tenantId: "tenant_b",
      idempotencyKey: "scim-cross-tenant",
    }),
    (error) =>
      error instanceof IdentityAccessError && error.code === "ACCESS_DENIED",
  );
  await fixture.service.deprovisionScimUser(actor, {
    tenantId: "tenant_a",
    externalId: "directory-user-9",
    idempotencyKey: "scim-delete-1",
  });
  assert.equal(
    (
      await fixture.membershipRepository.find(
        "principal_directory_9",
        "tenant_a",
      )
    )?.status,
    "revoked",
  );
});

test("invitation acceptance fails safely for the wrong identity", async () => {
  const { service } = makeService({ invitations: [invitation()] });
  const principal = service.normalize(
    assertion({ email: "attacker@example.test" }),
  );
  await assert.rejects(
    service.acceptInvitation({
      invitationId: "invitation_1",
      principal,
      idempotencyKey: "accept-key-2",
    }),
    (error) =>
      error instanceof IdentityAccessError &&
      error.code === "INVITATION_INVALID" &&
      !error.message.includes("learner@example.test"),
  );
});

test("safe error helpers redact credential-like details and hide unexpected failures", () => {
  const sanitized = sanitizeSafeDetails({
    reason: "invalid",
    token: "top-secret",
    signatureBytes: "also-secret",
    count: 2,
  });
  assert.deepEqual(sanitized, { reason: "invalid", count: 2 });
  const safe = toSafeIdentityError(
    new Error("database password=secret and raw assertion contents"),
  );
  assert.equal(safe.code, "AUTHENTICATION_FAILED");
  assert.equal(safe.message, "Authentication could not be verified.");
  assert.equal(safe.message.includes("password"), false);
});
