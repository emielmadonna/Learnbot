import assert from "node:assert/strict";
import test from "node:test";
import { buildCircleSnippet, validCircleUrl } from "../src/lib/circle-installation";

test("Circle snippets carry tenant identity and durable assistant hooks", () => {
  const snippet = buildCircleSnippet({
    tenantId: "tenant-123",
    tenantSlug: "northstar-academy",
    assistantName: "Nova",
    primaryColor: "#315F50",
    accentColor: "#D8A653",
    welcomeMessage: "Ask Nova about <published> learning.",
    launcherLabel: "Ask Nova",
    communityUrl: "https://community.example.com",
  });
  assert.match(snippet, /script\.dataset\.tenantId = "tenant-123"/);
  assert.match(snippet, /script\.dataset\.tenantSlug = "northstar-academy"/);
  assert.match(snippet, /script\.dataset\.assistantPrimary = "#315F50"/);
  assert.match(snippet, /script\.dataset\.assistantWelcome = "Ask Nova about \\u003cpublished\\u003e learning\."/);
  assert.match(snippet, /script\.dataset\.communityUrl = "https:\/\/community\.example\.com"/);
});

test("Circle community URLs fail closed unless HTTPS or local development", () => {
  assert.equal(validCircleUrl("https://community.example.com"), true);
  assert.equal(validCircleUrl("http://community.example.com"), false);
  assert.equal(validCircleUrl("javascript:alert(1)"), false);
  assert.equal(validCircleUrl("http://localhost:3000"), true);
});
