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
  const originalFixturePreview = process.env.LEARNINGBOT_FIXTURE_PREVIEW;
  const originalFixtureAcknowledgement =
    process.env.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT;
  const originalVercelEnvironment = process.env.VERCEL_ENV;
  const originalVercelBranch = process.env.VERCEL_GIT_COMMIT_REF;
  const mutableEnvironment = process.env as Record<string, string | undefined>;
  mutableEnvironment.NODE_ENV = "production";
  delete mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW;
  delete mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT;
  try {
    const response = await proxy(
      new NextRequest("https://learning.example/dev/chat"),
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  } finally {
    if (originalNodeEnvironment === undefined) delete mutableEnvironment.NODE_ENV;
    else mutableEnvironment.NODE_ENV = originalNodeEnvironment;
    if (originalFixturePreview === undefined) {
      delete mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW;
    } else {
      mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW = originalFixturePreview;
    }
    if (originalFixtureAcknowledgement === undefined) {
      delete mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT;
    } else {
      mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT =
        originalFixtureAcknowledgement;
    }
    if (originalVercelEnvironment === undefined) delete mutableEnvironment.VERCEL_ENV;
    else mutableEnvironment.VERCEL_ENV = originalVercelEnvironment;
    if (originalVercelBranch === undefined) delete mutableEnvironment.VERCEL_GIT_COMMIT_REF;
    else mutableEnvironment.VERCEL_GIT_COMMIT_REF = originalVercelBranch;
  }
});

test("protected Vercel preview permits fixture surfaces on the approved branch", async () => {
  const mutableEnvironment = process.env as Record<string, string | undefined>;
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    LEARNINGBOT_FIXTURE_PREVIEW: process.env.LEARNINGBOT_FIXTURE_PREVIEW,
    LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT:
      process.env.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
  };
  mutableEnvironment.NODE_ENV = "production";
  mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW = "enabled";
  mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT = acknowledgement;
  mutableEnvironment.VERCEL_ENV = "preview";
  mutableEnvironment.VERCEL_GIT_COMMIT_REF = "codex/platform-foundations";
  try {
    const response = await proxy(
      new NextRequest("https://learning.example/dev/chat"),
    );
    assert.equal(response.status, 200);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete mutableEnvironment[key];
      else mutableEnvironment[key] = value;
    }
  }
});

test("fixture preview remains denied outside the approved Vercel branch", async () => {
  const mutableEnvironment = process.env as Record<string, string | undefined>;
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    LEARNINGBOT_FIXTURE_PREVIEW: process.env.LEARNINGBOT_FIXTURE_PREVIEW,
    LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT:
      process.env.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
  };
  mutableEnvironment.NODE_ENV = "production";
  mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW = "enabled";
  mutableEnvironment.LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT = acknowledgement;
  mutableEnvironment.VERCEL_ENV = "preview";
  mutableEnvironment.VERCEL_GIT_COMMIT_REF = "someone-else";
  try {
    const response = await proxy(
      new NextRequest("https://learning.example/dev/chat"),
    );
    assert.equal(response.status, 404);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete mutableEnvironment[key];
      else mutableEnvironment[key] = value;
    }
  }
});
