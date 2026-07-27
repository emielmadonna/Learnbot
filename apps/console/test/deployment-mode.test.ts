import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentFixturesAllowed,
  fixturePreviewEnabled,
} from "../src/lib/deployment-mode";

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
