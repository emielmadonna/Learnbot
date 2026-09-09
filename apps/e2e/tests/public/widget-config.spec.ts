import { expect, test } from "@playwright/test";
import { BOGUS_WIDGET_KEY, OPAQUE_REFUSAL, env } from "../support/env";

/**
 * VIS-02 — the anonymous bootstrap and its allow-list.
 *
 * This is the endpoint whose refusal made a client's launcher appear and
 * vanish. Every failure — no Origin, unknown key, malformed key, key on a
 * domain that is not listed — must be the same opaque 404 with no CORS
 * headers, so the embedding page learns only "not available here" and an
 * attacker cannot tell which keys exist. A listed origin gets branding and
 * nothing that identifies the tenant.
 */
const config = (key: string) => `/api/widget/config?key=${encodeURIComponent(key)}`;

test.describe("widget bootstrap: /api/widget/config", () => {
  test("VIS-02a refuses a request that carries no Origin", async ({ request }) => {
    const response = await request.get(config(BOGUS_WIDGET_KEY));
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual(OPAQUE_REFUSAL);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toMatch(/no-store/);
  });

  test("VIS-02b refuses an unknown key and a malformed key identically", async ({ request }) => {
    const unknown = await request.get(config(BOGUS_WIDGET_KEY), {
      headers: { origin: "https://example.com" },
    });
    const malformed = await request.get(config("not-a-key"), {
      headers: { origin: "https://example.com" },
    });
    for (const response of [unknown, malformed]) {
      expect(response.status()).toBe(404);
      expect(await response.json()).toEqual(OPAQUE_REFUSAL);
      expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    }
    expect(await unknown.text()).toBe(await malformed.text());
  });

  test("VIS-02c answers preflight for any origin without disclosing anything", async ({ request }) => {
    const response = await request.fetch(config(BOGUS_WIDGET_KEY), {
      method: "OPTIONS",
      headers: {
        origin: "https://anything.example",
        "access-control-request-method": "GET",
      },
    });
    expect(response.status()).toBe(204);
    expect(response.headers()["access-control-allow-methods"]).toContain("GET");
    expect(await response.text()).toBe("");
  });

  test("VIS-02d a listed origin gets branding and no tenant identity", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const response = await request.get(config(env.widgetKey!), {
      headers: { origin: env.origin },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["access-control-allow-origin"]).toBe(env.origin);
    expect(response.headers()["vary"]).toMatch(/origin/i);
    expect(response.headers()["cache-control"]).toMatch(/private/);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.branding.assistantName).toBe("string");
    expect(body.branding.primaryColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof body.widget.anonymousQuestions).toBe("boolean");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/tenant_?id/i);
    expect(serialized).not.toMatch(/persona/i);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    test.info().annotations.push({
      type: "anonymousQuestions",
      description: String(body.widget.anonymousQuestions),
    });
  });

  test("VIS-02e the same key on an unlisted origin is refused exactly like an unknown key", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const response = await request.get(config(env.widgetKey!), {
      headers: { origin: "https://not-on-the-list.example" },
    });
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual(OPAQUE_REFUSAL);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("VIS-02f origin matching is exact: scheme, host and port all count", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const listed = new URL(env.origin);
    const variants = [
      `http://${listed.host}`, // plain http on a public host is never allowed
      `${listed.protocol}//www.${listed.hostname}`, // www is a different origin
      `${listed.protocol}//${listed.hostname}:8443`,
      `${env.origin}/`, // a path is not an origin
    ].filter((variant) => variant !== env.origin);
    for (const variant of variants) {
      const response = await request.get(config(env.widgetKey!), { headers: { origin: variant } });
      expect(response.status(), `origin ${variant} must not match ${env.origin}`).toBe(404);
    }
  });
});
