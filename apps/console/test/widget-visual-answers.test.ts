import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The anonymous visual path, end to end, as a source contract.
 *
 * Before 20260731070000 every piece of this existed and none of them were
 * connected: the ranker enriched matches with visual metadata, `widget_ask`
 * dropped it on the way out, the ask route therefore never recorded a
 * disclosure, `widget_get_visual_asset_for_read` consequently refused every
 * read, and the embed adapter had no mapping for the one part kind that
 * renders a still image. Each assertion below pins one of those joints.
 */

const askProjection = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731070000_widget_answer_visual_parts.sql",
    import.meta.url,
  ),
  "utf8",
);
const disclosureMigration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731060000_widget_visual_media_disclosure.sql",
    import.meta.url,
  ),
  "utf8",
);
const askRoute = readFileSync(
  new URL("../src/app/api/widget/ask/route.ts", import.meta.url),
  "utf8",
);
const prelude = readFileSync(
  new URL("../src/app/widget.js/embed-prelude.ts", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../../../packages/widget-runtime/src/index.ts", import.meta.url),
  "utf8",
);
const widgetRpc = readFileSync(
  new URL("../src/lib/supabase/widget-rpc.ts", import.meta.url),
  "utf8",
);
const hostedAssistant = readFileSync(
  new URL("../src/app/c/[slug]/hosted-assistant.tsx", import.meta.url),
  "utf8",
);

test("widget_ask carries visual identity out of retrieval", () => {
  for (const field of [
    "'visualAssetId', match -> 'source' ->> 'visualAssetId'",
    "'visualKind', match -> 'source' ->> 'visualKind'",
    "'mediaType', match -> 'source' ->> 'mediaType'",
    "'altText', match -> 'source' ->> 'altText'",
  ]) {
    assert.ok(
      askProjection.includes(field),
      `widget_ask no longer projects ${field}`,
    );
  }
});

test("widget_ask still withholds every tenant-private identifier", () => {
  // The whole point of the narrow projection: a widget payload must never
  // carry a course, document, lesson or chunk UUID.
  for (const leaked of [
    "'courseId'",
    "'documentId'",
    "'lessonId'",
    "'chunkId'",
    "'knowledgeVersionId'",
  ]) {
    assert.ok(
      !askProjection.includes(leaked),
      `widget_ask projection leaks ${leaked}`,
    );
  }
});

test("widget_ask stays anon-only after being replaced", () => {
  assert.match(
    askProjection,
    /revoke execute on function public\.widget_ask\([\s\S]*?\) from public, authenticated, service_role;/u,
  );
  assert.match(
    askProjection,
    /grant execute on function public\.widget_ask\([\s\S]*?\) to anon;/u,
  );
});

/**
 * 20260731090000 restates the whole `widget_ask` body to add two arguments,
 * because a plpgsql body cannot be patched in place. Every assertion above is
 * therefore pinned to a definition the database no longer ends up with, and
 * would keep passing if the newest revision quietly dropped the visual
 * projection. These repeat them against the current definition.
 */
const askCurrent = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731090000_widget_self_reported_learner_identity.sql",
    import.meta.url,
  ),
  "utf8",
);

test("the current widget_ask definition keeps the visual projection and the boundary", () => {
  for (const field of [
    "'visualAssetId', match -> 'source' ->> 'visualAssetId'",
    "'visualKind', match -> 'source' ->> 'visualKind'",
    "'mediaType', match -> 'source' ->> 'mediaType'",
    "'altText', match -> 'source' ->> 'altText'",
  ]) {
    assert.ok(
      askCurrent.includes(field),
      `the current widget_ask no longer projects ${field}`,
    );
  }
  for (const leaked of [
    "'courseId'",
    "'documentId'",
    "'lessonId'",
    "'chunkId'",
    "'knowledgeVersionId'",
  ]) {
    assert.ok(
      !askCurrent.includes(leaked),
      `the current widget_ask projection leaks ${leaked}`,
    );
  }
  assert.match(
    askCurrent,
    /grant execute on function public\.widget_ask\([\s\S]*?\) to anon;/u,
  );
  assert.match(
    askCurrent,
    /revoke execute on function public\.widget_ask\([\s\S]*?\) from public, authenticated, service_role;/u,
  );
  // The pseudonym is the thing that must never come back out.
  assert.doesNotMatch(askCurrent, /'learnerKey'/u);
  assert.doesNotMatch(askCurrent, /'visitorKey'/u);
});

test("the ask route records a disclosure before it hands out any media URL", () => {
  assert.match(askRoute, /widgetRecordVisualDisclosure/u);
  const disclosureAt = askRoute.indexOf("await widgetRecordVisualDisclosure");
  const partsAt = askRoute.indexOf("parts: visualParts(disclosed)");
  assert.ok(disclosureAt > 0, "the ask route never records a disclosure");
  assert.ok(partsAt > 0, "the ask route never emits parts");
  assert.ok(
    disclosureAt < partsAt,
    "media URLs are emitted before the disclosure that authorises reading them",
  );
  // A failed disclosure must degrade to a text answer, never to broken images.
  assert.ok(
    askRoute.includes("disclosed = []"),
    "a failed disclosure does not fall back to a text-only answer",
  );
});

test("the ask route re-validates what the database returned", () => {
  assert.match(askRoute, /isUuid\(visualAssetId\)/u);
  assert.match(askRoute, /VISUAL_MEDIA_EXTENSIONS\.has\(mediaType\)/u);
  assert.match(askRoute, /MAX_ANSWER_VISUALS = 2/u);
});

test("media URLs are absolute and carry the visitor's own credentials", () => {
  // Relative would resolve against the CUSTOMER's page, not the console.
  assert.match(
    askRoute,
    /new URL\(\s*`\/api\/widget\/visuals\/\$\{visualAssetId\}\/content`,\s*requestUrl,\s*\)/u,
  );
  assert.match(askRoute, /url\.searchParams\.set\("key", widgetKey\)/u);
  assert.match(
    askRoute,
    /url\.searchParams\.set\("conversationRef", conversationRef\)/u,
  );
});

test("the emitted part kinds are ones the shipped runtime renders", () => {
  assert.match(askRoute, /kind: "video" as const/u);
  assert.match(askRoute, /kind: "diagram" as const/u);
  assert.match(runtime, /case "diagram": \{/u);
  assert.match(runtime, /case "video": \{/u);
});

test("the embed adapter maps diagram parts and never self-approves them", () => {
  assert.match(prelude, /raw\.kind === "diagram"/u);
  assert.match(prelude, /approved: raw\.approved === true/u);
  assert.match(prelude, /parts\.concat\(mapRichParts\(message\.parts\)\)/u);
});

test("the disclosure grant stays necessary but never sufficient", () => {
  // A disclosure row alone must not resurrect an unpublished or
  // no-longer-answerable asset.
  for (const predicate of [
    "and visual.status = 'active'",
    "and visual.show_in_answers",
    "and visual.validation_profile = 'server_media_inspection_v1'",
    "and course.status = 'published'",
  ]) {
    assert.ok(
      disclosureMigration.includes(predicate),
      `widget_get_visual_asset_for_read dropped ${predicate}`,
    );
  }
});

test("the hosted assistant renders the parts it already receives", () => {
  // /c/[slug] forwards to /api/widget/ask and got `message.parts` back all
  // along; it simply threw them away, so a grounded image never appeared on
  // the friendly public link even though the embedded widget showed it.
  assert.match(hostedAssistant, /parts\?: unknown;/u);
  assert.match(hostedAssistant, /parseVisuals\(\s*payload\.message\.parts/u);
  assert.match(hostedAssistant, /message\.visuals\.map\(/u);
  assert.match(hostedAssistant, /<video/u);
  assert.match(hostedAssistant, /<img/u);
});

test("the hosted assistant reuses the runtime's part vocabulary", () => {
  // A second vocabulary would be a silent divergence: the same payload feeds
  // the embed adapter, the runtime and this page.
  assert.match(hostedAssistant, /record\.kind === "diagram"/u);
  assert.match(hostedAssistant, /record\.kind === "video"/u);
  assert.match(hostedAssistant, /record\.approved === true/u);
  assert.match(hostedAssistant, /typeof record\.caption === "string"/u);
  assert.match(hostedAssistant, /typeof record\.title === "string"/u);
});

test("the hosted assistant re-checks everything the server asserted", () => {
  // Same posture as the authenticated console and the ask route: cap at two,
  // UUID ids, and a URL that can only be this origin's own visual endpoint.
  assert.match(hostedAssistant, /MAX_ANSWER_VISUALS = 2/u);
  assert.match(hostedAssistant, /uuidPattern\.test\(id\)/u);
  assert.match(
    hostedAssistant,
    /url\.pathname !== `\/api\/widget\/visuals\/\$\{id\}\/content`/u,
  );
  assert.match(hostedAssistant, /url\.origin !== origin/u);
  // A part kind this build does not know is skipped, never guessed at.
  assert.doesNotMatch(hostedAssistant, /kind: record\.kind/u);
});

test("the widget match contract exposes the visual fields as optional", () => {
  assert.match(widgetRpc, /visualAssetId\?: string;/u);
  assert.match(widgetRpc, /mediaType\?: string;/u);
  assert.match(widgetRpc, /altText\?: string;/u);
});
