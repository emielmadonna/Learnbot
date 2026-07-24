import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import {
  OidcAssertionVerifier,
  OidcVerificationError,
} from "../dist/index.js";

const NOW_SECONDS = 1_700_000_000;
const NOW = new Date(NOW_SECONDS * 1_000);
const ISSUER = "https://identity.example.test";
const AUDIENCE = "learningbot-console";

async function keyFixture(kid = "key-current") {
  const pair = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, alg: "RS256", kid, use: "sig" },
  };
}

function verifier(jwks, overrides = {}) {
  return new OidcAssertionVerifier({
    policy: {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedAlgorithms: ["RS256"],
      maxTokenAgeSeconds: 300,
      clockSkewSeconds: 5,
      ...overrides,
    },
    jwks: { kind: "local", jwks: { keys: jwks } },
    now: () => NOW,
  });
}

async function token(
  fixture,
  {
    issuer = ISSUER,
    audience = AUDIENCE,
    subject = "user-123",
    includeSubject = true,
    issuedAt = NOW_SECONDS - 10,
    expiresAt = NOW_SECONDS + 120,
    notBefore,
    claims = {},
    kid = fixture.kid,
  } = {},
) {
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt);
  if (includeSubject) builder = builder.setSubject(subject);
  if (notBefore !== undefined) builder = builder.setNotBefore(notBefore);
  return builder.sign(fixture.privateKey);
}

async function rejectsWith(promise, code) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof OidcVerificationError &&
      error.code === code &&
      !error.message.includes("user-123") &&
      !error.message.includes("key-current"),
  );
}

test("maps only verified provider-neutral identity evidence", async () => {
  const key = await keyFixture();
  const assertion = await verifier([key.publicJwk]).verify(
    await token(key, {
      claims: {
        email: "learner@example.test",
        name: "A. Learner",
        sid: "session-7",
        tenantId: "attacker-tenant",
        roles: ["tenant_owner"],
        scope: "admin",
      },
    }),
  );
  assert.deepEqual(assertion, {
    method: "oidc",
    issuer: ISSUER,
    subject: "user-123",
    authenticatedAt: new Date((NOW_SECONDS - 10) * 1_000).toISOString(),
    email: "learner@example.test",
    displayName: "A. Learner",
    sessionId: "session-7",
  });
  assert.equal("tenantBinding" in assertion, false);
  assert.equal("grantedScopes" in assertion, false);
  assert.equal("roles" in assertion, false);
});

test("enforces issuer, audience, and algorithm allowlists", async () => {
  const key = await keyFixture();
  const verify = verifier([key.publicJwk]);
  await rejectsWith(
    verify.verify(await token(key, { issuer: "https://evil.example.test" })),
    "OIDC_TOKEN_INVALID",
  );
  await rejectsWith(
    verify.verify(await token(key, { audience: "billing-api" })),
    "OIDC_TOKEN_INVALID",
  );
  const secret = new TextEncoder().encode(
    "a-test-secret-that-is-long-enough-for-hs256",
  );
  const symmetricToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("user-123")
    .setIssuedAt(NOW_SECONDS - 10)
    .setExpirationTime(NOW_SECONDS + 60)
    .sign(secret);
  await rejectsWith(verify.verify(symmetricToken), "OIDC_TOKEN_INVALID");
});

test("enforces exp, nbf, iat, maximum age, and required subject", async () => {
  const key = await keyFixture();
  const verify = verifier([key.publicJwk]);
  await rejectsWith(
    verify.verify(
      await token(key, {
        issuedAt: NOW_SECONDS - 100,
        expiresAt: NOW_SECONDS - 6,
      }),
    ),
    "OIDC_TOKEN_EXPIRED",
  );
  await rejectsWith(
    verify.verify(await token(key, { notBefore: NOW_SECONDS + 6 })),
    "OIDC_TOKEN_INVALID",
  );
  await rejectsWith(
    verify.verify(await token(key, { issuedAt: NOW_SECONDS + 6 })),
    "OIDC_TOKEN_INVALID",
  );
  await rejectsWith(
    verify.verify(
      await token(key, {
        issuedAt: NOW_SECONDS - 306,
        expiresAt: NOW_SECONDS + 60,
      }),
    ),
    "OIDC_TOKEN_EXPIRED",
  );
  await rejectsWith(
    verify.verify(await token(key, { includeSubject: false })),
    "OIDC_TOKEN_INVALID",
  );
});

test("rejects malformed mapped claims instead of coercing them", async () => {
  const key = await keyFixture();
  await rejectsWith(
    verifier([key.publicJwk]).verify(
      await token(key, { claims: { email: ["not", "an", "email"] } }),
    ),
    "OIDC_TOKEN_INVALID",
  );
});

test("selects keys by kid and supports a rotated local JWKS", async () => {
  const oldKey = await keyFixture("key-old");
  const currentKey = await keyFixture("key-current");
  const verify = verifier([oldKey.publicJwk, currentKey.publicJwk]);
  assert.equal(
    (await verify.verify(await token(currentKey))).subject,
    "user-123",
  );
  assert.equal(
    (
      await verify.verify(
        await token(oldKey, { claims: { sid: "old-session" } }),
      )
    ).sessionId,
    "old-session",
  );
  await rejectsWith(
    verify.verify(await token(currentKey, { kid: "key-unknown" })),
    "OIDC_TOKEN_INVALID",
  );
});

test("uses an injected remote JWKS fetcher and refreshes for a rotated kid", async () => {
  const oldKey = await keyFixture("remote-old");
  const currentKey = await keyFixture("remote-current");
  let publishedKeys = [oldKey.publicJwk];
  let fetchCalls = 0;
  const verify = new OidcAssertionVerifier({
    policy: {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedAlgorithms: ["RS256"],
      maxTokenAgeSeconds: 300,
      clockSkewSeconds: 5,
    },
    jwks: {
      kind: "remote",
      uri: "https://identity.example.test/.well-known/jwks.json",
      cooldownMs: 0,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ keys: publishedKeys }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    now: () => NOW,
  });

  assert.equal(
    (await verify.verify(await token(oldKey))).subject,
    "user-123",
  );
  publishedKeys = [oldKey.publicJwk, currentKey.publicJwk];
  assert.equal(
    (await verify.verify(await token(currentKey))).subject,
    "user-123",
  );
  assert.equal(fetchCalls, 2);
});

test("maps remote key transport failures without leaking provider details", async () => {
  const key = await keyFixture();
  const verify = new OidcAssertionVerifier({
    policy: {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedAlgorithms: ["RS256"],
      maxTokenAgeSeconds: 300,
    },
    jwks: {
      kind: "remote",
      uri: "https://identity.example.test/.well-known/jwks.json",
      fetch: async () => {
        throw new TypeError("provider-secret-host failed");
      },
    },
    now: () => NOW,
  });

  await assert.rejects(
    verify.verify(await token(key)),
    (error) =>
      error instanceof OidcVerificationError &&
      error.code === "OIDC_KEY_UNAVAILABLE" &&
      !error.message.includes("provider-secret-host"),
  );
});

test("supports explicit claim mapping", async () => {
  const key = await keyFixture();
  const verify = verifier([key.publicJwk], {
    claimMapping: {
      emailClaim: "mail",
      displayNameClaim: "display_name",
      sessionIdClaim: "session_id",
    },
  });
  const assertion = await verify.verify(
    await token(key, {
      claims: {
        mail: "mapped@example.test",
        display_name: "Mapped User",
        session_id: "mapped-session",
      },
    }),
  );
  assert.equal(assertion.email, "mapped@example.test");
  assert.equal(assertion.displayName, "Mapped User");
  assert.equal(assertion.sessionId, "mapped-session");
});

test("rejects unsafe configuration with stable safe errors", async () => {
  const key = await keyFixture();
  assert.throws(
    () => verifier([key.publicJwk], { allowedAlgorithms: ["none"] }),
    (error) =>
      error instanceof OidcVerificationError &&
      error.code === "OIDC_CONFIGURATION_INVALID",
  );
  assert.throws(
    () =>
      new OidcAssertionVerifier({
        policy: {
          issuer: ISSUER,
          audience: AUDIENCE,
          allowedAlgorithms: ["RS256"],
          maxTokenAgeSeconds: 300,
        },
        jwks: {
          kind: "remote",
          uri: "http://identity.example.test/jwks.json",
        },
      }),
    (error) =>
      error instanceof OidcVerificationError &&
      error.code === "OIDC_CONFIGURATION_INVALID",
  );
});
