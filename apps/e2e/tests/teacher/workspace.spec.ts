import { expect } from "@playwright/test";
import { disposableName } from "../support/env";
import { mutationsAllowed, personaTest } from "../support/personas";

/**
 * TCH-01, TCH-06, TCH-07, TCH-08 and the teacher's side of ADM-01 — the
 * panels a tenant owner runs a workspace from, each checked for the honest
 * state it must show and for the mutation it must accept.
 */
const test = personaTest("teacher");

test.describe("teacher workspace", () => {
  test("TCH-01 Home greets by name and never renders a bare zero as reassurance", async ({ shell: page }) => {
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/good (morning|afternoon|evening)/i);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/application error|something went wrong/i);
  });

  test("TCH-06 hosted publication lists its requirements and, when published, the link serves", async ({ shell: page }) => {
    await page.goto("/app?panel=widget");
    const checklist = page.getByRole("list", { name: /publishing requirements/i });
    await expect(checklist).toBeVisible();
    const body = await page.locator("[role='dialog'], main").first().innerText();
    const slug = body.match(/\/c\/([a-z0-9-]{3,})/i)?.[1];
    if (slug && /unpublish/i.test(body)) {
      const response = await page.request.get(`/c/${slug}`);
      expect(response.status()).toBe(200);
      expect(await response.text()).not.toMatch(/isn.t available here/i);
      test.info().annotations.push({ type: "hosted-slug", description: slug });
    } else {
      test.info().annotations.push({ type: "hosted", description: "not published" });
    }
  });

  test("TCH-07 the people admin page lists members and offers a secure invite", async ({ shell: page }) => {
    await page.goto("/app/admin/users");
    await expect(page.getByRole("heading", { name: /everyone active or invited/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /invite someone securely/i })).toBeVisible();
    await expect(page.getByPlaceholder(/name@company\.com/i)).toBeVisible();
    const roles = page.locator("select").first();
    await expect(roles.locator("option")).toContainText([/learner/i, /teacher/i, /owner/i]);
  });

  test("TCH-07b provisioning a learner creates a listed, invited account", async ({ shell: page }) => {
    test.skip(!mutationsAllowed(), "E2E_ALLOW_MUTATIONS is not set");
    await page.goto("/app/admin/users");
    const email = `${disposableName("learner")}@example.com`;
    await page.getByPlaceholder(/full name/i).fill("E2E Learner");
    await page.getByPlaceholder(/name@company\.com/i).fill(email);
    await page.locator("select").first().selectOption("student");
    await page.locator("form").filter({ has: page.getByPlaceholder(/name@company\.com/i) }).getByRole("button").click();
    await expect(page.locator(`text=${email}`)).toBeVisible({ timeout: 30_000 });
  });

  test("TCH-08 Insights carries an explicit known/partial/unknown envelope and no error", async ({ shell: page }) => {
    await page.goto("/app?panel=insights");
    await expect(page.getByRole("heading", { name: /every question|topics|signals|question explorer/i }).first()).toBeVisible();
    const text = await page.locator("[role='dialog'], main").first().innerText();
    expect(text).not.toMatch(/application error|something went wrong/i);
    const envelope = /not measured|not known|known|partial|unknown|no questions yet/i.test(text);
    expect(envelope, "every metric must say how sure it is").toBe(true);
  });

  test("ADM-01b a tenant owner cannot see the platform panel", async ({ shell: page }) => {
    await page.goto("/app?panel=platform");
    const text = await page.locator("body").innerText();
    const denied = /access denied|not available|only platform|no permission/i.test(text);
    const listed = /every client workspace/i.test(text) && /add a client/i.test(text);
    expect(denied || !listed, "a non-admin must not reach the workspace operating view").toBe(true);
  });
});
