import { expect, test as base, type Page } from "@playwright/test";
import { env, type Persona } from "./env";

/**
 * A `test` that skips — with the reason — when the persona it needs was not
 * signed in by the setup project, and a few helpers every authenticated
 * journey uses.
 */
export function personaTest(persona: Persona) {
  const test = base.extend<{ shell: Page }>({
    shell: async ({ page }, use) => {
      base.skip(!env.personaReady(persona), `${persona} was not signed in (see the setup project's skip reason)`);
      await page.goto("/app");
      await expect(page).not.toHaveURL(/\/auth\/sign-in/);
      await use(page);
    },
  });
  return test;
}

/** Open a panel in the app shell by the label a person sees in the navigation. */
export async function openPanel(page: Page, label: RegExp): Promise<void> {
  const nav = page.getByRole("navigation").first();
  const link = nav.getByRole("link", { name: label }).or(nav.getByRole("button", { name: label }));
  await link.first().click();
}

/**
 * Mutation gate. Journeys that create or change tenant state run only when
 * the operator said so; otherwise they degrade to their read-only assertions
 * and say why, so a run against production never edits a real workspace by
 * accident.
 */
export function mutationsAllowed(): boolean {
  return env.allowMutations;
}

/** Wait for the panel's save to settle: either a status line or an alert. */
export async function expectSaved(page: Page): Promise<void> {
  const status = page.getByRole("status").or(page.getByRole("alert"));
  await expect(status.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
}
