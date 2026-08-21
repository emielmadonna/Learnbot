import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Guards the fix for the sign-in path that took three blank page loads.
 *
 * Every authenticated page decides where the visitor belongs by calling
 * `redirect()` while it renders. Next can only answer that with an HTTP 307
 * while the response headers are still unsent. Put a Suspense boundary ABOVE
 * such a page — a `<Suspense>` in the segment layout, or a `loading.tsx`, which
 * compiles to the same thing — and React has already begun streaming by the
 * time the redirect throws. The status line is then committed as 200 and the
 * destination is serialised into the RSC payload as a NEXT_REDIRECT marker
 * instead, which only the client can act on, and only after it has downloaded
 * every chunk and hydrated. With `fallback={null}` that is a blank screen, and
 * /app/entry -> /app/admin -> /app repeated it three times.
 *
 * The observable symptom is a status code, so that is what this pins:
 *
 *   before   GET /app -> 200, 9420 bytes, redirect buried in the payload
 *   after    GET /app -> 307, Location: /auth/sign-in?...
 *
 * Following the source-assertion style of operational-debt-contract.test.ts —
 * nothing in this suite stands up a Next server to observe the status directly.
 */

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/**
 * Source with comments removed.
 *
 * These files carry long comments explaining exactly which construct was
 * removed and why, so a naive search for the construct's name matches the
 * explanation of its absence.
 */
function code(relativePath: string) {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const authenticatedRoot = fileURLToPath(new URL("../src/app/app", import.meta.url));

/** Every route segment under /app, which is the whole authenticated area. */
function segments(directory: string): string[] {
  const found: string[] = [directory];
  for (const entry of readdirSync(directory)) {
    const path = `${directory}/${entry}`;
    if (statSync(path).isDirectory()) found.push(...segments(path));
  }
  return found;
}

test("no Suspense boundary sits above the authenticated pages", () => {
  const layout = code("../src/app/app/layout.tsx");

  assert.ok(
    !/\bSuspense\b/.test(layout),
    "src/app/app/layout.tsx must not wrap its children in Suspense: it would " +
      "turn every redirect() under /app back into a 200 with a NEXT_REDIRECT " +
      "body, which the browser can only follow after a full hydration.",
  );
});

test("no loading.tsx is introduced under the authenticated area", () => {
  const offenders = segments(authenticatedRoot).filter((directory) =>
    existsSync(`${directory}/loading.tsx`),
  );

  assert.deepEqual(
    offenders,
    [],
    "a loading.tsx creates the same Suspense boundary the layout was fixed to " +
      "remove. A loading state under /app has to live inside the page, below " +
      "the redirect decisions, not above them.",
  );
});

test("the useSearchParams bailout still exists, around the shell itself", () => {
  const page = source("../src/app/app/page.tsx");

  // The boundary is still required — AppShell reads useSearchParams via
  // usePanelRouter. It just has to sit below the redirects rather than above.
  assert.match(
    page,
    /<Suspense fallback=\{null\}>\s*<AppShell/,
    "AppShell reads useSearchParams and must stay wrapped in Suspense inside " +
      "the page, now that the segment layout no longer provides a boundary.",
  );
});

test("the authenticated entry point does not hop through a constant redirect", () => {
  const entry = code("../src/app/app/entry/page.tsx");

  assert.ok(
    !entry.includes('"/app/admin"'),
    "/app/admin is nothing but a redirect() to a constant URL, so routing " +
      "through it spends a whole extra request — and an extra proxy auth " +
      "round trip — to learn something already known here.",
  );
});

test("the marketing page does not prefetch the dynamic sign-in route", () => {
  const landing = source("../src/app/page.tsx");

  const signInLinks = landing.match(/<Link[^>]*href="\/auth\/sign-in"[^>]*>/gs) ?? [];
  assert.ok(signInLinks.length > 0, "the landing page should still link to sign-in");

  for (const link of signInLinks) {
    assert.match(
      link,
      /prefetch=\{false\}/,
      "/auth/sign-in is a dynamic route, so prefetching it renders it on the " +
        "server — an auth round trip per link, before the visitor has clicked " +
        `anything. Offending link: ${link}`,
    );
  }
});

test("the app serves an icon, so browsers stop requesting a missing favicon", () => {
  assert.ok(
    existsSync(fileURLToPath(new URL("../src/app/icon.svg", import.meta.url))),
    "without src/app/icon.svg every page load 404s on /favicon.ico",
  );
});

test("the proxy verifies sessions without a mandatory network round trip", () => {
  const proxy = code("../src/proxy.ts");

  assert.ok(
    proxy.includes("supabase.auth.getClaims()"),
    "the proxy runs on every /app, /onboarding and /auth request. getClaims " +
      "verifies the JWT locally against cached JWKS where the project allows " +
      "it, and falls back to getUser where it does not.",
  );
  assert.ok(
    !proxy.includes("supabase.auth.getUser()"),
    "a direct getUser() in the proxy is an unconditional network call to " +
      "Supabase Auth on every matched request.",
  );
});
