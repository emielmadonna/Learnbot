import { expect, test } from "@playwright/test";
import { env } from "../support/env";

/**
 * VIS-01 — the one file a customer pastes.
 *
 * `/widget.js` is the Corso host adapter concatenated with the built runtime.
 * It must be servable to any origin, cacheable, revalidatable, and must carry
 * nothing tenant-specific and no secret of any kind.
 */
test.describe("widget delivery: /widget.js", () => {
  test("VIS-01a serves the runtime as public, immutable JavaScript", async ({ request }) => {
    const response = await request.get("/widget.js");
    expect(response.status(), "the runtime artifact must be built and served").toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toMatch(/^text\/javascript/);
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["cache-control"]).toMatch(/public/);
    expect(headers["cache-control"]).toMatch(/immutable/);
    expect(headers["etag"], "an ETag is what lets a customer page revalidate cheaply").toBeTruthy();
    expect(headers["x-content-type-options"]).toBe("nosniff");

    const body = await response.text();
    expect(body).toContain("CourseAiWidgetAdapter");
    expect(body).toContain("course-ai-widget");
    expect(body.length).toBeGreaterThan(50_000);
    test.info().annotations.push({ type: "bytes", description: String(body.length) });
  });

  test("VIS-01b revalidates with If-None-Match", async ({ request }) => {
    const first = await request.get("/widget.js");
    const etag = first.headers()["etag"];
    expect(etag).toBeTruthy();
    const second = await request.get("/widget.js", { headers: { "if-none-match": etag } });
    expect(second.status()).toBe(304);
  });

  test("VIS-01c carries no secret, key, tenant id or provider name", async ({ request }) => {
    const body = await (await request.get("/widget.js")).text();
    for (const pattern of [
      /sb_publishable_/,
      /sb_secret_/,
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // a JWT
      /\bsk-[A-Za-z0-9]{20,}/, // an OpenAI key
      /supabase\.co/,
      /wk_[0-9a-f]{40}/,
      /\bopenai\b|\banthropic\b|\belevenlabs\b/i,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
    ]) {
      expect(body, `served script must not match ${pattern}`).not.toMatch(pattern);
    }
  });

  test("VIS-01d the Circle install page derives the snippet from the request origin", async ({ page }) => {
    await page.goto("/install/circle");
    await expect(page).toHaveTitle(/.+/);
    const text = await page.locator("body").innerText();
    expect(text).toContain(`${env.origin}/widget.js`);
    expect(text, "the placeholder domain from the old bug must never reappear").not.toContain(
      "YOUR-CORSO-DOMAIN",
    );
  });
});
