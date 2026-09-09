import { expect, test as setup, type Page } from "@playwright/test";
import { env, type Persona } from "./support/env";

/**
 * Signs each persona in through the real sign-in page and saves the browser
 * state for its project. Nothing is faked: no token is minted, no cookie is
 * forged. A persona whose credentials are not in the environment is marked
 * absent so its project skips with a reason instead of failing or, worse,
 * passing on an empty session.
 *
 * Forced password change is honoured, not bypassed: an account that lands on
 * /auth/change-password is reported and skipped, because a test must never
 * rotate a real person's password.
 */
async function signIn(page: Page, persona: Persona): Promise<{ ok: true } | { ok: false; reason: string }> {
  const credentials = env.credentials(persona);
  if (!credentials) return { ok: false, reason: `no E2E_${persona.toUpperCase()}_EMAIL/_PASSWORD in the environment` };

  await page.goto("/auth/sign-in");
  await page.getByLabel(/email/i).fill(credentials.email);
  await page.getByLabel(/^password/i).fill(credentials.password);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/sign-in"), { timeout: 30_000 }).catch(() => undefined);

  if (page.url().includes("/auth/sign-in")) {
    const alert = await page.getByRole("alert").textContent().catch(() => null);
    return { ok: false, reason: `sign-in was refused: ${alert?.trim() ?? "no message"}` };
  }
  if (page.url().includes("/auth/change-password")) {
    return { ok: false, reason: "the account is forced through a password change; rotate it by hand, then rerun" };
  }
  if (page.url().includes("/onboarding")) {
    // /onboarding is where a person with memberships picks one: each
    // membership is an <article> with either a "Continue" link (already
    // selected) or a "Select tenant" form button. Prefer the named tenant,
    // otherwise the first membership offered. A workspace that is mid-setup
    // stays on /onboarding after selection, which is still a signed-in state.
    const wanted = persona === "teacher" ? env.teacherTenant : undefined;
    const rows = page.locator("article");
    const row = wanted ? rows.filter({ hasText: new RegExp(wanted, "i") }).first() : rows.first();
    if (await row.isVisible().catch(() => false)) {
      const select = row.getByRole("button", { name: /select tenant/i });
      const cont = row.getByRole("link", { name: /continue/i });
      if (await select.isVisible().catch(() => false)) await select.click();
      else if (await cont.isVisible().catch(() => false)) await cont.click();
      await page.waitForLoadState("networkidle").catch(() => undefined);
    }
  }
  await expect(page).not.toHaveURL(/\/auth\/sign-in/);
  return { ok: true };
}

for (const persona of ["learner", "teacher", "admin"] as const) {
  setup(`sign in as ${persona}`, async ({ page }) => {
    const result = await signIn(page, persona);
    if (!result.ok) {
      env.markPersona(persona, false);
      setup.skip(true, result.reason);
      return;
    }
    await page.context().storageState({ path: env.storageStatePath(persona) });
    env.markPersona(persona, true);
    setup.info().annotations.push({ type: "landed-on", description: new URL(page.url()).pathname });
  });
}
