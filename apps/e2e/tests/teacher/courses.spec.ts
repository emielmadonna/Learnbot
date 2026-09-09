import { expect } from "@playwright/test";
import { disposableName } from "../support/env";
import { mutationsAllowed, personaTest } from "../support/personas";

/**
 * TCH-03 / TCH-04 — authoring and publishing, proven by retrieval.
 *
 * With mutations, a disposable `e2e-` course is created with a module, a
 * lesson and one unmistakable sentence, published, and then the teacher asks
 * the bot about that sentence in the Conversation panel. The answer citing it
 * is the only proof that publishing projected content into knowledge.
 */
const test = personaTest("teacher");

test.describe("course authoring and publishing", () => {
  test("TCH-03a the Learning panel lists courses or explains that there are none", async ({ shell: page }) => {
    await page.goto("/app?panel=course");
    await expect(page.getByRole("navigation", { name: /learning sections/i })).toBeVisible();
    const text = await page.locator("[role='dialog'], main").first().innerText();
    expect(text).toMatch(/course/i);
    expect(text).not.toMatch(/application error|something went wrong/i);
  });

  test("TCH-03b/TCH-04 create → module → lesson → publish → the bot cites it", async ({ shell: page }) => {
    test.skip(!mutationsAllowed(), "E2E_ALLOW_MUTATIONS is not set");
    test.setTimeout(240_000);
    const courseTitle = disposableName("course");
    const fact = `The secret phrase for ${courseTitle} is periwinkle-${Date.now().toString(36)}.`;

    await page.goto("/app?panel=course");
    const createHeading = page.getByRole("heading", { name: /add learning/i });
    if (!(await createHeading.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /add learning|new course|create course/i }).first().click();
    }
    await page.getByLabel(/course title/i).fill(courseTitle);
    const description = page.getByLabel(/what learners will be able to do|description/i);
    if (await description.isVisible().catch(() => false)) await description.fill("Disposable end-to-end course.");
    const firstModule = page.getByPlaceholder(/build your foundation/i);
    if (await firstModule.isVisible().catch(() => false)) await firstModule.fill("Module one");
    const firstLesson = page.getByPlaceholder(/start with your vision/i);
    if (await firstLesson.isVisible().catch(() => false)) await firstLesson.fill("Lesson one");
    const firstBody = page.getByPlaceholder(/paste or write the first lesson/i);
    if (await firstBody.isVisible().catch(() => false)) await firstBody.fill(fact);
    await page.getByRole("button", { name: /create|add learning|save/i }).first().click();
    await expect(page.locator(`text=${courseTitle}`).first()).toBeVisible({ timeout: 30_000 });

    // Publish the course. The panel names the exact scope it will publish.
    await page.getByRole("button", { name: /^publish$/i }).first().click();
    const publish = page.getByRole("button", { name: /publish course|publish changes/i });
    await expect(publish).toBeVisible();
    await publish.click();
    await expect(page.locator("text=/published/i").first()).toBeVisible({ timeout: 60_000 });

    // Retrieval proof: the teacher's own conversation surface.
    await page.goto("/app/conversation");
    const composer = page.getByRole("textbox", { name: /^message/i });
    let cited = false;
    for (let attempt = 0; attempt < 4 && !cited; attempt += 1) {
      await composer.fill(`What is the secret phrase for ${courseTitle}?`);
      await page.getByRole("button", { name: /send message/i }).click();
      await expect(composer).toBeEnabled({ timeout: 60_000 });
      const transcript = await page.locator("main").innerText();
      cited = transcript.includes("periwinkle-");
      if (!cited) await page.waitForTimeout(10_000);
    }
    expect(cited, "the published lesson must be retrievable and cited within a minute").toBe(true);
  });
});
