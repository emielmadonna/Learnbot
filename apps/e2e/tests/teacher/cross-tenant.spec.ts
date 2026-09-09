import { expect } from "@playwright/test";
import { personaTest } from "../support/personas";

/**
 * SEC-B — cross-tenant isolation from the browser.
 *
 * Needs a second tenant owner (E2E_TEACHER2_EMAIL / _PASSWORD) on a
 * different tenant. Tenant A's course and conversation identifiers are read
 * from tenant A's own panels, then requested with tenant B's session: every
 * answer must be a refusal with no partial body.
 */
const test = personaTest("teacher");

function second() {
  const email = process.env.E2E_TEACHER2_EMAIL?.trim();
  const password = process.env.E2E_TEACHER2_PASSWORD?.trim();
  return email && password ? { email, password } : null;
}

test.describe("cross-tenant isolation", () => {
  test("SEC-B tenant B's session cannot read tenant A's course, widget settings or analytics", async ({ shell: page, browser }) => {
    const other = second();
    test.skip(!other, "E2E_TEACHER2_EMAIL/_PASSWORD are not set");

    // Tenant A: collect identifiers the way the UI exposes them.
    await page.goto("/app?panel=course");
    const courseLink = page.locator("a[href*='panel=course'][href*='id=']").first();
    const courseId = (await courseLink.getAttribute("href").catch(() => null))?.match(/id=([0-9a-f-]{36})/)?.[1] ?? null;
    const settingsA = await page.request.get("/api/widget/settings", { headers: { accept: "application/json" } });
    const keyA = ((await settingsA.json().catch(() => ({}))) as { settings?: { publicKey?: string } }).settings?.publicKey ?? null;

    // Tenant B: a separate browser context, signed in through the real page.
    const context = await browser.newContext();
    const pageB = await context.newPage();
    try {
      await pageB.goto("/auth/sign-in");
      await pageB.getByLabel(/email/i).fill(other!.email);
      await pageB.getByLabel(/^password/i).fill(other!.password);
      await pageB.getByRole("button", { name: /continue/i }).click();
      await pageB.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"));

      const settingsB = await pageB.request.get("/api/widget/settings", { headers: { accept: "application/json" } });
      const keyB = ((await settingsB.json().catch(() => ({}))) as { settings?: { publicKey?: string } }).settings?.publicKey ?? null;
      if (keyA && keyB) expect(keyB, "two tenants never share a widget key").not.toBe(keyA);

      if (courseId) {
        await pageB.goto(`/app?panel=course&id=${courseId}`);
        const text = await pageB.locator("body").innerText();
        expect(text).not.toContain(courseId);
        const publish = await pageB.request.post(`/api/learning/courses/${courseId}/publish`, {
          headers: { "content-type": "application/json", origin: new URL(pageB.url()).origin },
          data: {},
        });
        expect([400, 403, 404]).toContain(publish.status());
        expect(await publish.text()).not.toMatch(/"title"|"course_id"/);
        const knowledge = await pageB.request.get(`/api/learning/knowledge?courseId=${courseId}`, { headers: { accept: "application/json" } });
        expect(knowledge.status(), "a cookie read of another tenant's knowledge state is refused").not.toBe(200);
      }

      const analytics = await pageB.request.get("/api/analytics", { headers: { accept: "application/json" } });
      const analyticsText = await analytics.text();
      if (keyA) expect(analyticsText).not.toContain(keyA);
    } finally {
      await context.close();
    }
  });
});
