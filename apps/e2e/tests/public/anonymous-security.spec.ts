import { expect, test } from "@playwright/test";

/**
 * SEC-A — what an anonymous caller can and cannot do.
 *
 * Every console API must refuse a caller with no session; every cookie-backed
 * mutation must also refuse a cross-origin caller (CSRF); the app shell must
 * redirect to sign-in; and the security headers the platform promises must be
 * present on every surface. A missing Content-Security-Policy is reported as
 * a known gap rather than failed, because it is a decision, not a regression.
 */
const protectedApis: Array<{ method: "GET" | "POST"; path: string }> = [
  { method: "GET", path: "/api/widget/settings" },
  { method: "POST", path: "/api/widget/settings" },
  { method: "GET", path: "/api/agent" },
  { method: "POST", path: "/api/agent" },
  { method: "GET", path: "/api/analytics" },
  { method: "GET", path: "/api/platform" },
  { method: "POST", path: "/api/platform" },
  { method: "GET", path: "/api/admin/users" },
  { method: "POST", path: "/api/admin/users" },
  { method: "POST", path: "/api/learning/respond" },
  { method: "POST", path: "/api/authoring" },
  { method: "GET", path: "/api/widget/hosted-publication" },
];

test.describe("anonymous security surface", () => {
  for (const api of protectedApis) {
    test(`SEC-A1 ${api.method} ${api.path} refuses a caller with no session`, async ({ request }) => {
      const response = await request.fetch(api.path, {
        method: api.method,
        headers: { accept: "application/json", "content-type": "application/json" },
        data: api.method === "POST" ? {} : undefined,
        maxRedirects: 0,
      });
      expect([401, 403, 404, 405, 307, 308], `${api.method} ${api.path} → ${response.status()}`).toContain(
        response.status(),
      );
      expect(response.status(), "never a 200 and never a 500 for an anonymous caller").not.toBe(200);
      expect(response.status()).toBeLessThan(500);
      const text = await response.text();
      expect(text).not.toMatch(/tenant_id|service_role|sb_secret|stack trace|at .*\.ts:\d+/i);
    });
  }

  test("SEC-A2 a cookie-backed mutation from a foreign origin is refused before authentication", async ({ request }) => {
    const response = await request.post("/api/agent", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      data: {},
      maxRedirects: 0,
    });
    expect([401, 403]).toContain(response.status());
  });

  test("SEC-A3 the app shell sends an anonymous visitor to sign-in", async ({ page }) => {
    const response = await page.goto("/app", { waitUntil: "domcontentloaded" });
    expect(response).not.toBeNull();
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page.getByRole("button", { name: /continue/i })).toBeVisible();
  });

  test("SEC-A4 security headers are present on the sign-in page", async ({ request }) => {
    const response = await request.get("/auth/sign-in");
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"] ?? headers["content-security-policy"]).toBeTruthy();
    expect(headers["referrer-policy"]).toBeTruthy();
    if (new URL(response.url()).protocol === "https:") {
      expect(headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    }
    if (!headers["content-security-policy"]) {
      test.info().annotations.push({
        type: "known-gap",
        description: "no Content-Security-Policy header (console and hosted page) — tracked in docs/TESTING.md",
      });
    }
  });

  test("SEC-A5 the sign-in form rejects a wrong password without revealing whether the account exists", async ({ page }) => {
    await page.goto("/auth/sign-in");
    await page.getByLabel(/email/i).fill(`nobody-${Date.now()}@example.com`);
    await page.getByLabel(/password/i).fill("definitely-not-the-password");
    await page.getByRole("button", { name: /continue/i }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText(/no such user|does not exist|not found/i);
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });
});
