import { NextResponse } from "next/server";
import { POST as runEmbeddingWorker } from "../../learning/embeddings/route";
import { POST as drainTelemetryOutbox } from "../telemetry-outbox/drain/route";

/**
 * The scheduler entry point.
 *
 * Two workers in this codebase are written to be driven by a scheduler and
 * were never given one. Nothing in the repository invoked either: no
 * `vercel.json` existed at all, `.github/workflows/ci.yml` has no `schedule:`,
 * and no migration calls `cron.schedule` or `pg_net`. The consequence was not
 * cosmetic -- `/api/learning/embeddings` is what turns published
 * `learning_chunks` into vectors, so without it retrieval matches nothing and
 * the assistant correctly refuses every question it is asked. The product
 * looked broken when the queue was simply never drained.
 *
 * Vercel Cron can only issue `GET`, and both workers are deliberately
 * `POST`-only behind an operation secret. Rather than widen either worker's
 * authentication -- the operation-secret model is the strongest thing here and
 * must not grow a second door -- this route holds both credentials and
 * presents them on the caller's behalf:
 *
 *   1. `CRON_SECRET` proves the request came from the platform scheduler.
 *      Vercel sends it as `Authorization: Bearer $CRON_SECRET` automatically
 *      when the variable is set on the project.
 *   2. The per-worker operation token proves capability, exactly as it does
 *      for a hand-issued call.
 *
 * That is the same two-layer arrangement `.env.example` already describes for
 * the Stripe webhook. The workers are invoked as functions rather than over
 * the network: there is no second cold start, no self-signed request to
 * authenticate, and no origin to derive.
 *
 * Each worker bounds its own run at 45s (`RUN_BUDGET_MS`) and claims a bounded
 * batch under a lease, so a run that is cut short loses nothing and the next
 * tick resumes. `maxDuration` below covers both sequentially plus overhead.
 *
 * This route reports per-task status rather than a single boolean, because a
 * missing token and a provider outage are different problems and this codebase
 * does not let one read as the other. A partial run answers `207`, which keeps
 * the failure legible in the body without the scheduler treating it as an
 * outage and retrying into a storm.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type JsonRecord = Record<string, unknown>;

function json(body: JsonRecord, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Constant-time for equal-length inputs; length is not itself a secret. */
function tokensMatch(presented: string, expected: string) {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function presentedSecret(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return "";
}

type TaskOutcome = {
  ok: boolean;
  status: number;
  body: unknown;
};

/**
 * Invoke one worker with its own credential.
 *
 * A missing token is reported as `operation_token_not_configured` rather than
 * being passed through as an empty string, which the worker would answer with
 * its own `worker_not_configured`. Both are true, but only this one says which
 * side is unconfigured.
 */
async function invoke(
  handler: (request: Request) => Promise<Response>,
  token: string,
  url: string,
): Promise<TaskOutcome> {
  if (token.length < 32) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, code: "operation_token_not_configured" },
    };
  }
  try {
    const response = await handler(
      new Request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const body: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: {
        ok: false,
        code: "worker_threw",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim() ?? "";
  // Fail closed: an unconfigured scheduler endpoint is not an open one.
  if (expected.length < 16) {
    return json({ ok: false, code: "scheduler_not_configured" }, 503);
  }
  const presented = presentedSecret(request);
  if (!presented || !tokensMatch(presented, expected)) {
    return json({ ok: false, code: "access_denied" }, 401);
  }

  const origin = new URL(request.url).origin;

  const embeddings = await invoke(
    runEmbeddingWorker,
    process.env.LEARNINGBOT_EMBEDDING_OPERATION_TOKEN?.trim() ?? "",
    `${origin}/api/learning/embeddings?limit=64`,
  );
  const telemetryOutbox = await invoke(
    drainTelemetryOutbox,
    process.env.LEARNINGBOT_TELEMETRY_OUTBOX_OPERATION_TOKEN?.trim() ?? "",
    `${origin}/api/ops/telemetry-outbox/drain`,
  );

  const tasks = { embeddings, telemetryOutbox };
  const ran = Object.values(tasks);
  const ok = ran.every((task) => task.ok);
  return json({ ok, tasks }, ok ? 200 : 207);
}
