import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../src/app/install/circle/page.tsx", import.meta.url),
  "utf8",
);

test("Circle installer uses the canonical widget runtime contract", () => {
  assert.match(pageSource, /\/widget\.js/u);
  assert.match(pageSource, /script\.dataset\.tenant/u);
  assert.match(pageSource, /script\.defer = true/u);
  assert.match(pageSource, /wk_REPLACE_WITH_YOUR_WIDGET_KEY/u);

  assert.doesNotMatch(pageSource, /integrations\/circle-learningbot\.js/u);
  assert.doesNotMatch(pageSource, /script\.dataset\.widgetKey/u);
});

test("Circle installer points mobile users to the friendly hosted assistant", () => {
  assert.match(pageSource, /\/c\/your-course/u);
  assert.match(pageSource, /publish the\s+workspace&apos;s hosted assistant/u);
  assert.match(pageSource, /\/app\?panel=widget&view=install/u);

  assert.doesNotMatch(pageSource, /\/app\/conversation/u);
  assert.doesNotMatch(pageSource, /does not create an anonymous hosted page/u);
  assert.doesNotMatch(pageSource, /signed-in conversation page/u);
});
