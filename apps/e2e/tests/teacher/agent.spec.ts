import { expect } from "@playwright/test";
import { disposableName } from "../support/env";
import { expectSaved, mutationsAllowed, personaTest } from "../support/personas";

/**
 * TCH-02 — agent configuration: the identity every answer wears.
 *
 * Read-only: the panel loads, the four sub-views exist, and the panel is
 * honest about whether anything has been published. With mutations: a draft
 * save round-trips a marker in the welcome message and is then restored, and
 * Publish creates a live version.
 */
const test = personaTest("teacher");

test.describe("agent configuration", () => {
  test("TCH-02a the assistant panel opens with its sub-views and says whether a version is live", async ({ shell: page }) => {
    await page.goto("/app?panel=agent");
    const subnav = page.getByRole("navigation", { name: /assistant settings/i });
    await expect(subnav).toBeVisible();
    for (const label of [/overview/i, /the bot/i, /appearance/i, /safeguards/i]) {
      await expect(subnav.getByRole("link", { name: label }).or(subnav.getByRole("button", { name: label }))).toBeVisible();
    }
    const body = await page.locator("[role='dialog'], main").first().innerText();
    const published = /published version \d+/i.test(body);
    const never = /never published/i.test(body);
    expect(published || never, "the panel must state the live state plainly").toBe(true);
    test.info().annotations.push({ type: "live-state", description: published ? "published" : "never published" });
  });

  test("TCH-02b a draft save round-trips, and Publish makes it live", async ({ shell: page }) => {
    test.skip(!mutationsAllowed(), "E2E_ALLOW_MUTATIONS is not set");
    await page.goto("/app?panel=agent");
    await page.getByRole("navigation", { name: /assistant settings/i }).getByText(/the bot/i).click();
    const welcome = page.getByLabel(/welcome message/i);
    await expect(welcome).toBeVisible();
    const original = await welcome.inputValue();
    const marker = disposableName("welcome");
    await welcome.fill(`${original} ${marker}`.trim());
    await page.getByRole("button", { name: /save draft/i }).click();
    await expectSaved(page);
    await page.reload();
    await page.getByRole("navigation", { name: /assistant settings/i }).getByText(/the bot/i).click();
    await expect(page.getByLabel(/welcome message/i)).toHaveValue(new RegExp(marker));

    await page.getByLabel(/welcome message/i).fill(original);
    await page.getByRole("button", { name: /^publish$/i }).click();
    const confirm = page.getByRole("button", { name: /publish this version/i });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expectSaved(page);
    await expect(page.locator("text=/published version \\d+/i").first()).toBeVisible({ timeout: 20_000 });
  });
});
