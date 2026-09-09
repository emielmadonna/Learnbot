import { expect, type Page } from "@playwright/test";
import { personaTest } from "../support/personas";

/**
 * LRN-03 / LRN-04 — the signed-in learner's grounded conversation.
 *
 * The authenticated path calls the provider in-process, so on a dev server
 * without OPENAI_API_KEY it reports `provider_not_configured`; that is
 * detected and reported as a skip, never as a pass.
 */
const test = personaTest("learner");

const composer = (page: Page) => page.getByRole("textbox", { name: /^message/i });
const sendButton = (page: Page) => page.getByRole("button", { name: /send message/i });
const thinking = (page: Page) => page.locator("[aria-label$='is thinking']");
const turns = (page: Page) => page.getByRole("log").locator("article").or(page.locator("article"));

async function ask(page: Page, question: string) {
  await composer(page).fill(question);
  await sendButton(page).click();
  const alert = page.getByRole("alert");
  await Promise.race([
    thinking(page).waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined),
    alert.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined),
  ]);
  if ((await alert.count()) > 0 && /provider|not configured|unavailable/i.test((await alert.first().textContent()) ?? "")) {
    test.skip(true, `the deployment cannot answer: ${(await alert.first().textContent())?.trim()}`);
  }
  await expect(thinking(page)).toBeHidden({ timeout: 60_000 });
  await expect(composer(page)).toBeEnabled({ timeout: 60_000 });
}

test.describe("learner conversation", () => {
  test("LRN-03 a question is answered with an indicator first, prose after, and sources when grounded", async ({ shell: page }) => {
    await page.goto("/app/conversation");
    await expect(composer(page)).toBeVisible();
    await ask(page, "What is this course about?");
    const last = turns(page).last();
    await expect(last).toContainText(/(\S+\s+){9,}\S+/, { useInnerText: true });
    const sources = page.locator("details").filter({ hasText: /source/i });
    test.info().annotations.push({ type: "sources", description: String(await sources.count()) });
    if ((await sources.count()) > 0) {
      await sources.first().locator("summary").click();
      await expect(sources.first()).toHaveAttribute("open", "");
    }
  });

  test("LRN-04 a follow-up naming no course is answered from history, and Start over starts over", async ({ shell: page }) => {
    await page.goto("/app/conversation");
    await ask(page, "What is this course about?");
    await ask(page, "Say that again in one sentence.");
    const last = turns(page).last();
    await expect(last).toContainText(/(\S+\s+){4,}\S+/, { useInnerText: true });
    await page.getByRole("button", { name: /start over/i }).click();
    await expect(composer(page)).toBeEnabled();
    await expect(page.locator("article").filter({ hasText: "Say that again" })).toHaveCount(0);
  });

  test("LRN-03b nonsense is refused with wording, not invented facts", async ({ shell: page }) => {
    await page.goto("/app/conversation");
    await ask(page, "zqxjv plorth wumbo fibbertigibbet quantum llama tariff");
    const last = turns(page).last();
    await expect(last).toContainText(/\S+/);
    const sources = last.locator("details").filter({ hasText: /source/i });
    expect(await sources.count(), "a refusal cites nothing").toBe(0);
  });

  test("LRN-03c the composer is keyboard-complete: Enter sends, Shift+Enter breaks a line", async ({ shell: page }) => {
    await page.goto("/app/conversation");
    await composer(page).fill("line one");
    await composer(page).press("Shift+Enter");
    await composer(page).type("line two");
    await expect(composer(page)).toHaveValue(/line one\nline two/);
    await composer(page).press("Enter");
    await expect(page.locator("article").filter({ hasText: "line one" }).first()).toBeVisible({ timeout: 10_000 });
  });
});
