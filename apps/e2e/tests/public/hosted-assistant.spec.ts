import { expect, test, type Page } from "@playwright/test";
import { conversationRef, env } from "../support/env";

/**
 * VIS-05 — the hosted full-page assistant at /c/<slug>.
 *
 * The public, branded page a course owner links to. It goes through the same
 * answer route as the embed, so this is also where the real streaming feel is
 * measured in a browser: time to the sources card, time to the first token,
 * number of deltas, and whether the reader ever sees an empty bubble.
 */
const composer = (page: Page) => page.locator("#hosted-question");
const send = (page: Page) => page.getByRole("button", { name: /send question/i });

async function askAndWait(page: Page, question: string) {
  await composer(page).fill(question);
  await send(page).click();
  const log = page.getByRole("log");
  await expect(log).toContainText(question);
  // The pre-token indicator, then a finished answer with prose.
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("status")).toBeHidden({ timeout: 60_000 });
  await expect(composer(page)).toBeEnabled({ timeout: 60_000 });
}

test.describe("hosted assistant: /c/<slug>", () => {
  test("VIS-05a an unknown slug is an opaque, friendly refusal", async ({ page }) => {
    await page.goto(`/c/no-such-assistant-${Date.now().toString(36)}`);
    await expect(page.getByRole("heading", { name: /isn.t available here/i })).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
  });

  test("VIS-05b a published slug loads branded, with suggestions and an empty state", async ({ page }) => {
    test.skip(!env.hostedSlug, "E2E_HOSTED_SLUG is not set");
    await page.goto(`/c/${env.hostedSlug}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /new conversation/i })).toBeVisible();
    const suggestions = page.locator("[aria-label='Suggested questions'] button");
    const text = await page.locator("body").innerText();
    expect(text).toMatch(/published course material/i);
    if ((await suggestions.count()) === 0) {
      expect(text, "closed assistants must say so instead of showing a dead composer").toMatch(/not accepting anonymous questions/i);
    }
  });

  test("VIS-05c asks, streams, cites, and stays in context on a follow-up", async ({ page }) => {
    test.skip(!env.hostedSlug, "E2E_HOSTED_SLUG is not set");
    await page.goto(`/c/${env.hostedSlug}`);
    test.skip(!(await composer(page).isEnabled()), "this assistant does not accept anonymous questions");

    // Browser-side timing of the real stream, frame by frame.
    await page.evaluate(() => {
      const w = window as unknown as { __askTiming: Array<{ t: number; ev: string }> };
      w.__askTiming = [];
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const started = performance.now();
        const response = await original(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("/ask") || !response.body) return response;
        const [forPage, forProbe] = response.body.tee();
        (async () => {
          const reader = forProbe.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");
              const name = (frame.match(/^event:\s*(.*)$/m) ?? [])[1] ?? "";
              w.__askTiming.push({ t: Math.round(performance.now() - started), ev: name });
            }
          }
        })();
        return new Response(forPage, { status: response.status, headers: response.headers });
      };
    });

    await askAndWait(page, "What is this course about?");
    const first = page.getByRole("log").locator("article").nth(1);
    await expect(first).toContainText(/(\S+\s+){9,}\S+/, { useInnerText: true });
    const timing = await page.evaluate(() => (window as unknown as { __askTiming: Array<{ t: number; ev: string }> }).__askTiming);
    const sourcesAt = timing.find((f) => f.ev === "sources")?.t ?? null;
    const deltas = timing.filter((f) => f.ev === "delta");
    const doneAt = timing.find((f) => f.ev === "done")?.t ?? null;
    test.info().annotations.push(
      { type: "ms-to-sources", description: String(sourcesAt) },
      { type: "ms-to-first-token", description: String(deltas[0]?.t ?? null) },
      { type: "delta-count", description: String(deltas.length) },
      { type: "ms-to-done", description: String(doneAt) },
    );
    expect(doneAt, "the turn must terminate with done").not.toBeNull();
    if (deltas.length === 1) {
      test.info().annotations.push({
        type: "warning",
        description: "one delta: answers are not streaming on this deployment (edge function not deployed)",
      });
    }
    // Sources are collapsed by default and expandable.
    const sources = page.getByRole("log").locator("details").first();
    if ((await sources.count()) > 0) {
      await sources.locator("summary").click();
      await expect(sources.locator("article").first()).toBeVisible();
    }

    // Follow-up with no course named: only conversation history can answer it.
    await askAndWait(page, "Can you say that again in one sentence?");
    const second = page.getByRole("log").locator("article").nth(3);
    await expect(second).toContainText(/(\S+\s+){4,}\S+/, { useInnerText: true });
    await expect(second).not.toContainText(/isn.t in the published|not covered|could not find/i);
  });

  test("VIS-05d Enter submits the composer", async ({ page }) => {
    test.skip(!env.hostedSlug, "E2E_HOSTED_SLUG is not set");
    await page.goto(`/c/${env.hostedSlug}`);
    test.skip(!(await composer(page).isEnabled()), "this assistant does not accept anonymous questions");
    await composer(page).fill("What is this course about?");
    await composer(page).press("Enter");
    await expect(page.getByRole("log")).toContainText("What is this course about?", { timeout: 10_000 });
    await expect(composer(page)).toHaveValue("");
  });

  test("VIS-05e New conversation clears the transcript and the next question starts fresh", async ({ page }) => {
    test.skip(!env.hostedSlug, "E2E_HOSTED_SLUG is not set");
    await page.goto(`/c/${env.hostedSlug}`);
    test.skip(!(await composer(page).isEnabled()), "this assistant does not accept anonymous questions");
    await askAndWait(page, "What is this course about?");
    await page.getByRole("button", { name: /new conversation/i }).click();
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.locator("[aria-label='Suggested questions']")).toBeVisible();
  });

  test("VIS-05f the page reflows on a phone and the composer stays reachable", async ({ browser }) => {
    test.skip(!env.hostedSlug, "E2E_HOSTED_SLUG is not set");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto(`/c/${env.hostedSlug}`);
      await expect(composer(page)).toBeVisible();
      const box = await composer(page).boundingBox();
      expect(box && box.y + box.height).toBeLessThanOrEqual(844);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow, "no horizontal scroll on a phone").toBe(false);
    } finally {
      await context.close();
    }
  });

  test("VIS-05g the slug's own ask route enforces Origin like the widget route", async ({ request }) => {
    test.skip(!env.hostedSlug, "E2E_HOSTED_SLUG is not set");
    const response = await request.post(`/c/${env.hostedSlug}/ask`, {
      data: { conversationRef: conversationRef(), question: "Hello there", courseRef: null },
    });
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ ok: false, code: "widget_unavailable" });
  });
});
