import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const home = source("../src/components/sections/home-section.tsx");
const homeStyles = source(
  "../src/components/sections/home-section.module.css",
);
const settings = source("../src/components/sections/settings-panel.tsx");
const settingsStyles = source(
  "../src/components/sections/settings-panel.module.css",
);

test("the selected client opens on the tenant home even for the platform owner", () => {
  assert.doesNotMatch(home, /if \(payload\.role === "platform_owner"\)/u);
  assert.match(home, /<OperatorHome accountName=\{accountName\} payload=\{payload\}/u);
  assert.match(home, /parseAnalyticsAnswerQuality\(body\.answerQuality\)/u);
  assert.match(home, /parseAnalyticsQuestionDistribution\(body\.distribution\)/u);
});

test("tenant home follows the prototype's one-thing, activity and course hierarchy", () => {
  assert.match(home, /Today&apos;s one thing/u);
  assert.match(home, /What they asked about/u);
  assert.match(home, /See every question/u);
  assert.match(home, /Your course/u);
  assert.match(homeStyles, /\.activityGrid[\s\S]*grid-template-columns:/u);
  assert.match(homeStyles, /\.courseFacts[\s\S]*repeat\(3/u);
});

test("settings follows the prototype sidebar and bot-detail layout", () => {
  for (const label of [
    "The bot",
    "Appearance",
    "Install",
    "People",
    "Plan & usage",
    "Privacy & data",
    "Your account",
  ]) {
    assert.ok(settings.includes(label), `${label} is present`);
  }
  assert.match(settings, /Always show which lesson it used/u);
  assert.match(settings, /When it doesn&apos;t know/u);
  assert.match(settingsStyles, /grid-template-columns: 236px minmax\(0, 1fr\)/u);
  assert.match(settingsStyles, /\.groupCard[\s\S]*border-radius: 16px/u);
});

test("settings affordances route into durable configuration pages", () => {
  assert.match(settings, /panel: "agent", extra: \{ view: "appearance" \}/u);
  assert.match(settings, /panel: "agent", extra: \{ view: "model" \}/u);
  assert.match(settings, /panel: "widget", extra: \{ view: "install" \}/u);
  assert.match(settings, /panel: "settings", extra: \{ view: "plan-usage" \}/u);
  assert.match(settings, /panel: "settings", extra: \{ view: "privacy-data" \}/u);
  assert.doesNotMatch(settings, /onClick=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/u);
});
