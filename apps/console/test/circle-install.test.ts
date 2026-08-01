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

const nextConfig = readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);
const widgetPanel = readFileSync(
  new URL("../src/components/sections/widget-panel.tsx", import.meta.url),
  "utf8",
);
const embedPrelude = readFileSync(
  new URL("../src/app/widget.js/embed-prelude.ts", import.meta.url),
  "utf8",
);

test("the pasted snippet points at the origin the page is served from", () => {
  // It used to read NEXT_PUBLIC_APP_URL ?? NEXT_PUBLIC_SITE_URL ??
  // "https://YOUR-CORSO-DOMAIN" at module scope. Neither variable is set or
  // documented anywhere, so every customer pasted a snippet aimed at a domain
  // that does not exist.
  assert.match(pageSource, /await installPageOrigin\(\)/u);
  assert.match(pageSource, /x-forwarded-host/u);
  assert.match(pageSource, /export default async function CircleInstallPage/u);
  // The snippet has to be built per request now, not frozen at module scope.
  assert.doesNotMatch(pageSource, /^const snippet = /mu);
});

test("the install page names every prerequisite that is a hard gate", () => {
  // Allowlist: widget_origin_allowed refuses an unlisted origin, and the
  // widget cannot even be enabled with an empty list.
  assert.match(pageSource, /Circle community&apos;s domain to the allowed list/u);
  // Key minting: the key does not exist before the first successful save.
  assert.match(pageSource, /issued by the server on that first save/u);
  // anonymousQuestions defaults to false and gates widget_ask only, so the
  // launcher paints and every question fails.
  assert.match(pageSource, /Let signed-out visitors ask/u);
  assert.match(pageSource, /off by\s+default/u);
});

test("the install page describes the real blocked-origin failure", () => {
  // configure() renders with FALLBACK_BRANDING before awaiting bootstrap, so a
  // blocked origin flashes a generic launcher and then hides it. The old copy
  // claimed it "stays hidden", which sends a customer looking for the wrong
  // fault.
  assert.match(pageSource, /and then removes itself/u);
  assert.doesNotMatch(pageSource, /makes the launcher stay hidden/u);
});

test("the widget runtime artifact is traced into the deployed bundle", () => {
  // /widget.js readFileSync's an artifact no static import references, so
  // without this it is dropped from a standalone/serverless build and the
  // route serves its 503 to every embed.
  assert.match(nextConfig, /outputFileTracingIncludes/u);
  assert.match(
    nextConfig,
    /"\/widget\.js": \["\.\.\/\.\.\/packages\/widget-runtime\/dist\/widget\.iife\.js"\]/u,
  );
  assert.match(nextConfig, /outputFileTracingRoot/u);
});

test("the console does not promise an embed identity path that does not exist", () => {
  // Anonymous is still the default and still what an install that opts into
  // nothing gets: the identity object starts at that tier and is only raised
  // when the host page actually declared one.
  assert.match(embedPrelude, /var identity = \{ tier: "anonymous" \}/u);
  assert.doesNotMatch(
    widgetPanel,
    /Only a visitor your site has identified to the widget can ask/u,
  );
  assert.match(
    widgetPanel,
    /Nobody can ask through the embedded widget/u,
  );
});

test("a host-declared identity is self-reported and can never reach verified", () => {
  // The whole point of the three-tier type. window.circleUser is unsigned
  // client-side data, so a page script may claim an identity and may never
  // assert that anyone verified it. "verified" must not appear as a tier the
  // embed can send, and it must not appear in the install instructions as
  // something the customer is being given.
  assert.match(embedPrelude, /tier: "self_reported"/u);
  assert.match(embedPrelude, /visitorTier = "self_reported"/u);
  assert.doesNotMatch(embedPrelude, /tier: "verified"/u);
  assert.doesNotMatch(embedPrelude, /visitorTier = "verified"/u);
  assert.match(pageSource, /Identity not verified/u);
  assert.match(pageSource, /not a login/u);
});

test("the identity hook is host-agnostic and opt-in", () => {
  // Circle is the documented example, not the mechanism. The hook is a global
  // any host page can define, and an install that defines nothing must send
  // nothing new.
  assert.match(embedPrelude, /globalThis\.CourseAiWidgetIdentity/u);
  assert.match(embedPrelude, /if \(!declared \|\| typeof declared !== "object"\) return null;/u);
  assert.match(pageSource, /window\.CourseAiWidgetIdentity/u);
  assert.match(pageSource, /window\.circleUser/u);
  // An email address must be refused at the boundary rather than hashed.
  assert.match(embedPrelude, /\/\^\[A-Za-z0-9_\.:-\]\{3,180\}\$\//u);
});

const widgetRpc = readFileSync(
  new URL("../src/lib/supabase/widget-rpc.ts", import.meta.url),
  "utf8",
);
const askRoute = readFileSync(
  new URL("../src/app/api/widget/ask/route.ts", import.meta.url),
  "utf8",
);

test("the visitor reference is validated at the route and never logged", () => {
  // Same pattern in three places on purpose: embed, route, and public.widget_ask.
  assert.match(widgetRpc, /\/\^\[A-Za-z0-9_\.:-\]\{3,180\}\$\/u/u);
  assert.match(askRoute, /isVisitorRef\(input\.visitorRef\)/u);
  // The peppered hash in the database is pointless if a plaintext copy sits
  // in a log line, so no console call in the route may name the reference.
  for (const line of askRoute.split("\n")) {
    if (!/console\.(log|warn|error)/u.test(line)) continue;
    assert.doesNotMatch(line, /visitorRef/u);
  }
  assert.doesNotMatch(askRoute, /\$\{visitorRef\}/u);
});

test("the identity arguments are omitted rather than sent as nulls", () => {
  // Migrations here are applied by hand. Sending visitor_ref unconditionally
  // would make PostgREST fail to match widget_ask on every database that has
  // not been given 20260731090000, breaking the anonymous path that every
  // install uses today.
  assert.match(widgetRpc, /\.\.\.\(identified/u);
  assert.match(askRoute, /20260731090000/u);
});

test("the Circle instructions are reachable from the console", () => {
  assert.match(widgetPanel, /href="\/install\/circle"/u);
});
