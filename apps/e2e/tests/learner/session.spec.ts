import { expect } from "@playwright/test";
import { personaTest } from "../support/personas";

/** LRN-01 / LRN-07 — the session itself. */
const test = personaTest("learner");

test.describe("learner session", () => {
  test("LRN-01 the app shell loads for a signed-in learner with a primary navigation", async ({ shell: page }) => {
    await expect(page.getByRole("navigation", { name: /primary/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /account/i }).or(page.getByRole("link", { name: /account/i }))).toBeVisible();
  });

  test("LRN-06 the Learning panel shows the course or an honest empty state, never a crash", async ({ shell: page }) => {
    await page.goto("/app?panel=course");
    await expect(page.getByRole("dialog", { name: /learning/i }).or(page.getByRole("heading", { name: /learning/i }).first())).toBeVisible();
    await expect(page.locator("text=/application error|something went wrong/i")).toHaveCount(0);
  });

  test("LRN-07 sign out ends the session and the back button does not resurrect it", async ({ shell: page }) => {
    await page.goto("/app/conversation");
    await page.getByRole("button", { name: /account/i }).click().catch(() => undefined);
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/auth\/sign-in\?status=signed_out/);
    await page.goBack();
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    const response = await page.request.get("/api/widget/settings", { headers: { accept: "application/json" } });
    expect(response.status()).not.toBe(200);
  });
});
