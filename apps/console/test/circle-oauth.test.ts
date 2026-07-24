import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationResumePath,
  createPkceS256Challenge,
  hashOpaque,
  isSafeCircleRedirectUri,
  parseBasicAuthorization,
  parseOAuthScopes,
} from "../src/app/api/circle/_lib";

test("Circle OAuth secrets and opaque values are hashed before persistence", () => {
  const secret = "circle-client-secret-example";
  assert.match(hashOpaque(secret), /^[0-9a-f]{64}$/u);
  assert.notEqual(hashOpaque(secret), secret);
  assert.match(createPkceS256Challenge("verifier"), /^[A-Za-z0-9_-]+$/u);
});

test("Circle redirect URIs fail closed", () => {
  assert.equal(isSafeCircleRedirectUri("https://circle.example.com/oauth/callback"), true);
  assert.equal(isSafeCircleRedirectUri("http://localhost:3100/oauth/callback"), true);
  assert.equal(isSafeCircleRedirectUri("http://circle.example.com/oauth/callback"), false);
  assert.equal(isSafeCircleRedirectUri("https://user:pass@circle.example.com/callback"), false);
  assert.equal(isSafeCircleRedirectUri("https://circle.example.com/callback#fragment"), false);
});

test("OAuth scope and Basic auth parsing are strict and interoperable", () => {
  assert.deepEqual(parseOAuthScopes("openid email profile"), ["openid", "email", "profile"]);
  assert.equal(parseOAuthScopes("openid"), null);
  assert.equal(parseOAuthScopes("openid email admin"), null);
  assert.deepEqual(
    parseBasicAuthorization(`Basic ${Buffer.from("client:secret").toString("base64")}`),
    { clientId: "client", clientSecret: "secret" },
  );
  assert.equal(parseBasicAuthorization("Bearer token"), null);
});

test("OAuth resume stays on the LearningBot origin", () => {
  const path = authorizationResumePath(
    new Request("https://clone.stack-labs.ai/api/circle/authorize?client_id=abc&state=xyz"),
  );
  assert.equal(path, "/api/circle/authorize?client_id=abc&state=xyz");
  assert.ok(path.startsWith("/"));
  assert.equal(path.startsWith("//"), false);
});
