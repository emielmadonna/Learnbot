import { expect } from "@playwright/test";
import { env } from "../support/env";
import { expectSaved, mutationsAllowed, personaTest } from "../support/personas";

/**
 * TCH-05 — widget setup: the panel that decides whether a customer's site
 * gets a launcher. Its status must agree with what the database serves, and
 * an origin added here must be accepted by /api/widget/config immediately.
 */
const test = personaTest("teacher");

test.describe("widget setup", () => {
  test("TCH-05a the Install panel reports a live state that matches its own explanation", async ({ shell: page }) => {
    await page.goto("/app?panel=widget");
    await expect(page.getByRole("navigation", { name: /widget settings/i })).toBeVisible();
    const status = page.getByRole("heading", { name: /^status$/i }).locator("..");
    await expect(status).toBeVisible();
    const badge = (await status.innerText()).trim();
    expect(badge).toMatch(/live|off|not published|no key/i);
    const body = await page.locator("[role='dialog'], main").first().innerText();
    if (/not published/i.test(badge)) {
      expect(body, "a not-published state must explain the appear-then-vanish symptom").toMatch(/never been published/i);
    }
    if (/live/i.test(badge)) {
      expect(body).toMatch(/on for \d+ domain|no domain is allowed/i);
    }
    test.info().annotations.push({ type: "status", description: badge.replace(/\s+/g, " ").slice(0, 60) });
  });

  test("TCH-05b the snippet is derived from this origin and the issued key, never generated in the browser", async ({ shell: page }) => {
    await page.goto("/app?panel=widget");
    const body = await page.locator("[role='dialog'], main").first().innerText();
    const hasKey = /wk_[0-9a-f]{40}/.test(body);
    if (hasKey) {
      expect(body).toContain(`${env.origin}/widget.js`);
      expect(body).toMatch(/data-tenant="wk_[0-9a-f]{40}"/);
      const circle = body.includes("document.createElement(\"script\")");
      expect(circle, "the Circle raw-JS variant is offered alongside the HTML tag").toBe(true);
    } else {
      expect(body).toMatch(/no public widget key|turn the widget on and save/i);
    }
  });

  test("TCH-05c the domain list refuses what the database would refuse", async ({ shell: page }) => {
    await page.goto("/app?panel=widget");
    const input = page.getByLabel(/add a domain/i);
    await expect(input).toBeVisible();
    for (const bad of ["http://example.com", "https://example.com/path", "example.com", "https://user:pw@example.com"]) {
      await input.fill(bad);
      await input.press("Enter");
      const error = page.getByRole("alert").or(page.locator("[id$='-error'], .error, [class*='error']"));
      await expect(error.first(), `${bad} must be refused in the panel`).toBeVisible();
    }
  });

  test("TCH-05d adding an origin makes /api/widget/config accept it; removing it makes it refuse", async ({ shell: page }) => {
    test.skip(!mutationsAllowed(), "E2E_ALLOW_MUTATIONS is not set");
    await page.goto("/app?panel=widget");
    const body = await page.locator("[role='dialog'], main").first().innerText();
    const key = body.match(/wk_[0-9a-f]{40}/)?.[0];
    test.skip(!key, "no widget key has been issued for this workspace yet");
    const origin = `https://e2e-${Date.now().toString(36)}.example`;
    await page.getByLabel(/add a domain/i).fill(origin);
    await page.getByLabel(/add a domain/i).press("Enter");
    await expect(page.locator(`text=${origin}`)).toBeVisible();
    await page.getByRole("button", { name: /save widget settings/i }).click();
    await expectSaved(page);

    const accepted = await page.request.get(`/api/widget/config?key=${key}`, { headers: { origin } });
    expect(accepted.status(), "a saved origin is served immediately").toBe(200);

    await page.locator("li").filter({ hasText: origin }).getByRole("button").first().click();
    await page.getByRole("button", { name: /save widget settings/i }).click();
    await expectSaved(page);
    const refused = await page.request.get(`/api/widget/config?key=${key}`, { headers: { origin } });
    expect(refused.status(), "a removed origin is refused immediately").toBe(404);
  });
});
