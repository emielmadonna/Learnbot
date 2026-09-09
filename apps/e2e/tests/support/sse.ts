import type { APIRequestContext } from "@playwright/test";

/**
 * Reads the `/api/widget/ask` event stream the way the prelude and the hosted
 * page do — `sources`, then `delta`s, then a terminal `done` or `error` — and
 * keeps the timing of every frame, so a test can assert on the contract AND
 * report how the answer actually felt: time to sources, time to first token,
 * number of deltas, total.
 */
export type SseFrame = { at: number; event: string; data: unknown };

export type AskOutcome = {
  status: number;
  contentType: string;
  frames: SseFrame[];
  deltas: number;
  text: string;
  msToSources: number | null;
  msToFirstToken: number | null;
  msTotal: number;
  done: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  json: unknown;
};

export async function askViaSse(
  request: APIRequestContext,
  input: {
    url: string;
    origin: string;
    body: Record<string, unknown>;
    accept?: string;
  },
): Promise<AskOutcome> {
  const started = Date.now();
  const response = await request.post(input.url, {
    headers: {
      origin: input.origin,
      "content-type": "application/json",
      accept: input.accept ?? "text/event-stream, application/json",
    },
    data: input.body,
    timeout: 90_000,
  });
  const contentType = response.headers()["content-type"] ?? "";
  const outcome: AskOutcome = {
    status: response.status(),
    contentType,
    frames: [],
    deltas: 0,
    text: "",
    msToSources: null,
    msToFirstToken: null,
    msTotal: 0,
    done: null,
    error: null,
    json: null,
  };
  if (!contentType.includes("text/event-stream")) {
    outcome.json = await response.json().catch(() => null);
    outcome.msTotal = Date.now() - started;
    return outcome;
  }
  // Playwright's request API buffers the body, so per-frame timing here is
  // bounded below by the whole response. The browser-side probe in the
  // hosted-assistant spec measures the real inter-frame gaps.
  const raw = await response.text();
  const at = Date.now() - started;
  for (const frame of raw.split("\n\n")) {
    if (!frame.trim()) continue;
    let event = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
    outcome.frames.push({ at, event, data: parsed });
    if (event === "sources" && outcome.msToSources === null) outcome.msToSources = at;
    if (event === "delta") {
      outcome.deltas += 1;
      if (outcome.msToFirstToken === null) outcome.msToFirstToken = at;
      const text = (parsed as { text?: unknown })?.text;
      if (typeof text === "string") outcome.text += text;
    }
    if (event === "done") outcome.done = parsed as Record<string, unknown>;
    if (event === "error") outcome.error = parsed as Record<string, unknown>;
  }
  outcome.msTotal = Date.now() - started;
  return outcome;
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
