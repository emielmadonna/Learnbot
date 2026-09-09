import { expect, type Page } from "@playwright/test";
import { disposableName } from "../support/env";
import { mutationsAllowed, personaTest } from "../support/personas";

/**
 * ADM-01 to ADM-05 — the platform owner's operating view.
 *
 * Read-only: the workspace list, the provisioning wizard, and the privileged
 * actions are present and named. With mutations: a disposable `e2e-` client
 * is provisioned, entered, exited, suspended and reactivated. Every dangerous
 * action requires typing the client's name, and the tests type it.
 */
const test = personaTest("admin");

const panel = (page: Page) => page.locator("[role='dialog'], main").first();

test.describe("platform administration", () => {
  test("ADM-01 the Workspaces panel lists clients and offers provisioning", async ({ shell: page }) => {
    await page.goto("/app?panel=platform");
    await expect(page.getByRole("dialog", { name: /workspaces/i }).or(page.getByRole("heading", { name: /workspaces/i }).first())).toBeVisible();
    await expect(page.getByRole("region", { name: /add a client/i }).or(page.locator("section[aria-label='Add a client']"))).toBeVisible();
    const text = await panel(page).innerText();
    expect(text).not.toMatch(/application error|something went wrong/i);
    test.info().annotations.push({ type: "clients-visible", description: String((text.match(/Enter client workspace/g) ?? []).length) });
  });

  test("ADM-02 provision a disposable client through the four-step wizard", async ({ shell: page }) => {
    test.skip(!mutationsAllowed(), "E2E_ALLOW_MUTATIONS is not set");
    test.setTimeout(180_000);
    await page.goto("/app?panel=platform&view=add-client");
    const wizard = page.getByRole("region", { name: /add a client/i }).or(page.locator("section[aria-label='Add a client']"));
    await expect(wizard).toBeVisible();
    const name = disposableName("client");
    // Step 1 · Who
    await page.getByLabel(/client or programme name/i).fill(name);
    await page.getByRole("button", { name: /^continue$/i }).click();
    // Step 2 · The bot
    await page.getByLabel(/bot name/i).fill("E2E Bot");
    await page.getByRole("button", { name: /^continue$/i }).click();
    // Step 3 · Knowledge is cosmetic (nothing is created from it): skip it.
    const skip = page.getByRole("button", { name: /^skip$/i });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    else await page.getByRole("button", { name: /^continue$/i }).click();
    // Step 4 · Owner. The email is disposable and never claimed.
    await page.getByLabel(/owner name/i).fill("E2E Owner");
    await page.getByLabel(/owner email/i).fill(`${name}@example.com`);
    await expect(page.locator("text=/the workspace starts empty/i")).toBeVisible();
    await page.getByRole("button", { name: /create workspace/i }).click();
    const result = page.getByRole("status").filter({ hasText: /workspace created/i });
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result).toContainText(name);
    // A one-time owner sign-in link or claim code may be shown when mail is
    // not configured; it must never be logged by this test.
    test.info().annotations.push({ type: "client", description: name });
  });

  test("ADM-03/ADM-04 enter, exit, suspend and reactivate the disposable client", async ({ shell: page }) => {
    test.skip(!mutationsAllowed(), "E2E_ALLOW_MUTATIONS is not set");
    await page.goto("/app?panel=platform");
    const row = page.locator("article, li, section").filter({ hasText: /e2e-client-/ }).first();
    test.skip(!(await row.isVisible().catch(() => false)), "no disposable e2e-client- workspace exists to operate on");
    const clientName = (await row.innerText()).match(/e2e-client-[a-z0-9]+/)?.[0] ?? "";

    await row.getByRole("button", { name: /enter client workspace/i }).click();
    const confirmEnter = page.getByRole("button", { name: /^enter/i }).last();
    if (await confirmEnter.isVisible().catch(() => false)) await confirmEnter.click();
    await expect(page.locator("text=/client workspace/i").first()).toBeVisible();
    await expect(page.locator(`text=${clientName}`).first()).toBeVisible();
    await page.getByRole("button", { name: /exit (this )?client workspace|exit now/i }).first().click();
    await expect(page.getByRole("button", { name: /enter client workspace/i }).first()).toBeVisible();

    await row.getByRole("button", { name: /suspend client/i }).click();
    await page.getByLabel(/type the client name to confirm/i).fill(clientName);
    await page.getByRole("button", { name: new RegExp(`suspend ${clientName}`, "i") }).click();
    await expect(row.getByRole("button", { name: /activate client/i })).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: /activate client/i }).click();
    const confirmActivate = page.getByLabel(/type the client name to confirm/i);
    if (await confirmActivate.isVisible().catch(() => false)) {
      await confirmActivate.fill(clientName);
      await page.getByRole("button", { name: /activate|reactivat/i }).last().click();
    }
    await expect(row.getByRole("button", { name: /suspend client/i })).toBeVisible({ timeout: 30_000 });
  });
});
