import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentFixturesAllowed,
  fixturePreviewEnabled,
} from "../src/lib/deployment-mode";
import { proxy } from "../src/proxy";
import { NextRequest } from "next/server";

const acknowledgement =
  "I_UNDERSTAND_THIS_USES_EPHEMERAL_FIXTURES";

test("development permits fixture services without a preview override", () => {
  assert.equal(developmentFixturesAllowed({ NODE_ENV: "development" }), true);
});

test("production denies fixture services by default", () => {
  assert.equal(developmentFixturesAllowed({ NODE_ENV: "production" }), false);
  assert.equal(fixturePreviewEnabled({ NODE_ENV: "production" }), false);
});

test("a flag alone cannot enable production fixture services", () => {
  const environment = {
    NODE_ENV: "production",
    LEARNINGBOT_FIXTURE_PREVIEW: "enabled",
  };

  assert.equal(developmentFixturesAllowed(environment), false);
});

test("an acknowledgement alone cannot enable production fixture services", () => {
  const environment = {
    NODE_ENV: "production",
    LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT: acknowledgement,
  };

  assert.equal(developmentFixturesAllowed(environment), false);
});

test("both exact values enable an explicitly private fixture preview", () => {
  const environment = {
    NODE_ENV: "production",
    LEARNINGBOT_FIXTURE_PREVIEW: "enabled",
    LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT: acknowledgement,
  };

  assert.equal(fixturePreviewEnabled(environment), true);
  assert.equal(developmentFixturesAllowed(environment), true);
});

test("near-match values remain denied", () => {
  const environment = {
    NODE_ENV: "production",
    LEARNINGBOT_FIXTURE_PREVIEW: "true",
    LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT: acknowledgement.toLowerCase(),
  };

  assert.equal(developmentFixturesAllowed(environment), false);
});

test("production proxy returns a non-discoverable 404 for development surfaces", async () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  const mutableEnvironment = process.env as Record<string, string | undefined>;
  mutableEnvironment.NODE_ENV = "production";
  try {
    const response = await proxy(
      new NextRequest("https://learning.example/dev/chat"),
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  } finally {
    if (originalNodeEnvironment === undefined) delete mutableEnvironment.NODE_ENV;
    else mutableEnvironment.NODE_ENV = originalNodeEnvironment;
  }
});
