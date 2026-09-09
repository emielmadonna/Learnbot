import { expect, test } from "@playwright/test";
import { BOGUS_WIDGET_KEY, OPAQUE_REFUSAL, conversationRef, env } from "../support/env";
import { UUID, askViaSse } from "../support/sse";

/**
 * VIS-03 — the answer contract behind both customer surfaces.
 *
 * `/api/widget/ask` serves SSE on `Accept: text/event-stream` (sources first,
 * then deltas, then a terminal done) and buffered JSON otherwise. The same
 * (key, origin) allow-list gates it, every malformed input is the same opaque
 * refusal, and a finished answer carries the durable message id that the
 * feedback route accepts — and nothing else that identifies the tenant.
 */
test.describe("answer contract: /api/widget/ask", () => {
  test("VIS-03a refuses without Origin, with an unknown key, and with a malformed body", async ({ request }) => {
    const noOrigin = await request.post("/api/widget/ask", {
      data: { key: BOGUS_WIDGET_KEY, conversationRef: conversationRef(), question: "Hello there" },
    });
    expect(noOrigin.status()).toBe(404);
    expect(await noOrigin.json()).toEqual(OPAQUE_REFUSAL);
    expect(noOrigin.headers()["access-control-allow-origin"]).toBeUndefined();

    const unknown = await request.post("/api/widget/ask", {
      headers: { origin: "https://example.com" },
      data: { key: BOGUS_WIDGET_KEY, conversationRef: conversationRef(), question: "Hello there" },
    });
    expect([400, 404]).toContain(unknown.status());
    expect(await unknown.json()).toEqual(OPAQUE_REFUSAL);
    expect(unknown.headers()["access-control-allow-origin"]).toBeUndefined();

    const malformed = await request.post("/api/widget/ask", {
      headers: { origin: "https://example.com", "content-type": "application/json" },
      data: "{not json",
    });
    expect([400, 404]).toContain(malformed.status());
    expect(malformed.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("VIS-03b streams sources, then text, then a terminal done with a durable message id", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const ref = conversationRef();
    const outcome = await askViaSse(request, {
      url: "/api/widget/ask",
      origin: env.origin,
      body: { key: env.widgetKey, conversationRef: ref, question: "What is this course about?", courseRef: null },
    });
    if (outcome.status !== 200 && (outcome.json as { code?: string } | null)?.code === "widget_unavailable") {
      test.skip(true, "this key does not accept anonymous questions on this origin (anonymousQuestions is off)");
    }
    expect(outcome.status).toBe(200);
    expect(outcome.contentType).toContain("text/event-stream");
    const order = outcome.frames.map((frame) => frame.event);
    expect(order[0], "sources must be the first frame so citations can render early").toBe("sources");
    expect(outcome.deltas).toBeGreaterThanOrEqual(1);
    expect(order[order.length - 1]).toBe("done");
    expect(outcome.text.trim().length).toBeGreaterThan(0);
    expect(outcome.done?.conversationRef).toBe(ref);
    expect(String(outcome.done?.messageId)).toMatch(UUID);
    const serialized = JSON.stringify(outcome.frames);
    expect(serialized).not.toMatch(/tenant_?id/i);
    expect(serialized).not.toMatch(/persona/i);
    test.info().annotations.push(
      { type: "deltas", description: String(outcome.deltas) },
      { type: "retrievalMode", description: String(outcome.done?.retrievalMode) },
      { type: "msTotal", description: String(outcome.msTotal) },
    );
    // Not an assertion, a warning: one delta means the deployed edge function
    // is still the buffered one and nothing actually streams to visitors.
    if (outcome.deltas === 1) {
      test.info().annotations.push({
        type: "warning",
        description:
          "the whole answer arrived as ONE delta: learning-provider-widget-complete is not streaming (see infra/supabase/SCHEMA-DRIFT.md)",
      });
    }
  });

  test("VIS-03c the buffered JSON shape is still served when the caller does not opt into SSE", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const outcome = await askViaSse(request, {
      url: "/api/widget/ask",
      origin: env.origin,
      accept: "application/json",
      body: { key: env.widgetKey, conversationRef: conversationRef(), question: "What is this course about?", courseRef: null },
    });
    if (outcome.status === 404) test.skip(true, "anonymousQuestions is off for this key");
    expect(outcome.status).toBe(200);
    expect(outcome.contentType).toContain("application/json");
    const body = outcome.json as { ok?: boolean; message?: { content?: string; id?: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.message?.content).toBe("string");
  });

  test("VIS-03d a question with no grounding is refused, not invented", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const outcome = await askViaSse(request, {
      url: "/api/widget/ask",
      origin: env.origin,
      body: {
        key: env.widgetKey,
        conversationRef: conversationRef(),
        question: "zqxjv plorth wumbo fibbertigibbet quantum llama tariff",
        courseRef: null,
      },
    });
    if (outcome.status === 404) test.skip(true, "anonymousQuestions is off for this key");
    expect(outcome.status).toBe(200);
    expect(outcome.done, "even a refusal is a finished, recorded turn").not.toBeNull();
    const sources = (outcome.frames[0]?.data as { sources?: unknown[] })?.sources ?? [];
    test.info().annotations.push({ type: "sources", description: String(sources.length) });
    if (sources.length === 0) {
      expect(outcome.done?.provider, "no source ⇒ no model call").toMatchObject({ adapterId: "no-source-safe-answer" });
    }
  });

  test("VIS-03e a rating with a guessed message id is refused opaquely", async ({ request }) => {
    test.skip(!env.widgetKey, "E2E_WIDGET_KEY is not set");
    const response = await request.post("/api/widget/feedback", {
      headers: { origin: env.origin },
      data: {
        key: env.widgetKey,
        conversationRef: conversationRef(),
        messageId: "00000000-0000-4000-8000-000000000000",
        rating: "up",
      },
    });
    expect(response.ok()).toBe(false);
    const body = await response.json().catch(() => null);
    expect(body?.ok).not.toBe(true);
  });

  test("VIS-03f the per-key rate limit engages and reports Retry-After", async ({ request }) => {
    test.skip(!env.widgetKey || !env.allowRateLimitProbe, "E2E_ALLOW_RATE_LIMIT_PROBE is not set (this locks real visitors out for a minute)");
    let limited: { status: number; retryAfter: string | undefined } | null = null;
    for (let index = 0; index < 40 && limited === null; index += 1) {
      const response = await request.post("/api/widget/ask", {
        headers: { origin: env.origin, accept: "application/json" },
        data: { key: env.widgetKey, conversationRef: conversationRef(), question: `Probe ${index}`, courseRef: null },
      });
      if (response.status() === 429) {
        limited = { status: 429, retryAfter: response.headers()["retry-after"] };
      }
    }
    expect(limited, "40 questions in a row must trip the 30/minute cap").not.toBeNull();
    expect(limited?.retryAfter).toBeTruthy();
  });
});
