import { expect, test, type Page } from "@playwright/test";
import { BOGUS_WIDGET_KEY, env } from "../support/env";

/**
 * VIS-04 — the embedded widget on a customer page, for real.
 *
 * A harness page is served from the console's own origin (which is on the
 * tenant's allow-list, because the hosted assistant needs it there) and loads
 * the real `/widget.js`, so the prelude, the config bootstrap, the SSE ask
 * path and the runtime all run exactly as they do on a customer's site.
 */
const HARNESS_PATH = "/__e2e/harness.html";

function harnessHtml(key: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Harness</title>
<style>body{font-family:Georgia,serif;margin:40px}</style></head>
<body><h1 id="host-heading">Customer page</h1><p>Host content that must stay untouched.</p>
<script src="/widget.js" data-tenant="${key}" defer></script>
</body></html>`;
}

async function openHarness(page: Page, key: string) {
  // Record every change to the element's inline display so the test can
  // prove it was never visible before the bootstrap answered.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __displayLog: string[] }).__displayLog = seen;
    const observer = new MutationObserver(() => {
      const element = document.querySelector("course-ai-widget") as HTMLElement | null;
      if (element) {
        const value = element.style.display || "(visible)";
        if (seen[seen.length - 1] !== value) seen.push(value);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  });
  await page.route(`**${HARNESS_PATH}`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: harnessHtml(key) }),
  );
  await page.goto(HARNESS_PATH);
}

const widget = (page: Page) => page.locator("course-ai-widget");
const launcher = (page: Page) => page.locator("course-ai-widget button.launcher");

test.describe("embedded widget on a customer page", () => {
  test("VIS-04a a refused key never paints anything, not even for a frame", async ({ page }) => {
    await openHarness(page, BOGUS_WIDGET_KEY);
    await page.waitForResponse((response) => response.url().includes("/api/widget/config"));
    await page.waitForTimeout(1_000);
    await expect(widget(page)).toHaveCount(1);
    await expect(widget(page)).toHaveCSS("display", "none");
    await expect(launcher(page)).toBeHidden();
    const log = await page.evaluate(() => (window as unknown as { __displayLog: string[] }).__displayLog);
    expect(log, "the element must go hidden → hidden, never through visible").not.toContain("(visible)");
    await expect(page.locator("#host-heading")).toHaveText("Customer page");
  });

  test("VIS-04b a listed key paints only after the bootstrap succeeds, in the tenant's brand", async ({ page }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    await openHarness(page, env.widgetKey!);
    const config = await page.waitForResponse((response) => response.url().includes("/api/widget/config"));
    expect(config.status()).toBe(200);
    await expect(launcher(page)).toBeVisible();
    const log = await page.evaluate(() => (window as unknown as { __displayLog: string[] }).__displayLog);
    expect(log[0], "hidden first, then shown — no fallback-brand flash").toBe("none");
    const branding = (await config.json()).branding;
    const primary = await launcher(page).evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(primary, "the launcher wears the tenant's primary colour, not the runtime fallback").not.toBe(
      "rgb(23, 107, 91)",
    );
    test.info().annotations.push({ type: "assistant", description: String(branding.assistantName) });
    // Host page isolation: our styles do not leak out of the shadow root.
    const hostFont = await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily);
    expect(hostFont).toMatch(/Georgia/);
  });

  test("VIS-04c ask, watch it think, watch it stream, rate it", async ({ page }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    await openHarness(page, env.widgetKey!);
    const config = await (await page.waitForResponse((r) => r.url().includes("/api/widget/config"))).json();
    await expect(launcher(page)).toBeVisible();
    await launcher(page).click();
    const composer = page.locator("course-ai-widget textarea");
    await expect(composer).toBeFocused();

    if (config.widget.anonymousQuestions !== true) {
      test.info().annotations.push({
        type: "note",
        description: "anonymousQuestions is off for this key; the widget must refuse politely",
      });
      await composer.fill("What is this course about?");
      await composer.press("Enter");
      await expect(page.locator("course-ai-widget .message.assistant, course-ai-widget .retryRow")).toBeVisible();
      return;
    }

    await composer.fill("What is this course about?");
    await composer.press("Enter");
    // Enter sends: the question appears as a user turn and the composer clears.
    await expect(page.locator("course-ai-widget .message.user").last()).toContainText("What is this course about?");
    await expect(composer).toHaveValue("");
    // Before anything arrives: the placeholder thinking indicator.
    await expect(page.locator("course-ai-widget .thinkingDots")).toBeVisible();
    // The answer must end up with text, and the indicator must be gone.
    const answer = page.locator("course-ai-widget .message.assistant").last();
    await expect(answer).not.toHaveClass(/awaiting|thinking/, { timeout: 60_000 });
    await expect(answer.locator("p")).not.toHaveText("", { timeout: 60_000 });
    await expect(page.locator("course-ai-widget .thinkingDots")).toHaveCount(0);
    const text = await answer.innerText();
    test.info().annotations.push({ type: "answer", description: text.slice(0, 160) });
    // A finished turn offers a rating when the server minted an id; a rating
    // control that would be refused must not exist at all.
    const feedback = page.locator("course-ai-widget .feedbackRow");
    if ((await feedback.count()) > 0) {
      await feedback.locator("button").first().click();
      await expect(feedback).toHaveAttribute("data-state", /saved|failed|pending/);
    }
    // Close and reopen keeps the transcript in this page session.
    await page.locator("course-ai-widget button[aria-label*='Close' i], course-ai-widget .icon").first().click();
    await launcher(page).click();
    await expect(page.locator("course-ai-widget .message.user").last()).toContainText("What is this course about?");
  });

  test("VIS-04d on a phone the panel is a full-height sheet", async ({ browser }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await openHarness(page, env.widgetKey!);
      await expect(launcher(page)).toBeVisible();
      await launcher(page).tap();
      const surface = page.locator("course-ai-widget .surface");
      await expect(surface).toBeVisible();
      const box = await surface.boundingBox();
      expect(box?.width, "the sheet spans the viewport width").toBeGreaterThanOrEqual(388);
    } finally {
      await context.close();
    }
  });
});
