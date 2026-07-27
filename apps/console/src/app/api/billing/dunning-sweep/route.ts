import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "../../../../lib/supabase/config";

/**
 * Advances the dunning sequence from `grace` to `dark` once a tenant's grace
 * window has elapsed. This is the *only* place "sections go dark" happens —
 * the webhook that opens the grace window never disables anything itself
 * (PLAN.md S10.3: "card fails, grace period, creator is told clearly, then
 * sections go dark" is a sequence, not a switch).
 *
 * Same worker-token pattern as the other scheduled routes in this
 * directory: authority is the `billing.operations` operation secret, not a
 * Supabase session. Run this on a schedule (Vercel Cron, a GitHub Action) at
 * whatever cadence is finer than the shortest configured grace window —
 * hourly is more than enough for the default 7-day window.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function tokensMatch(presented: string, expected: string) {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function presentedToken(request: Request) {
  const header = request.headers.get("x-learningbot-operation-token");
  if (header) return header.trim();
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return "";
}

export async function POST(request: Request) {
  const expectedToken =
    process.env.LEARNINGBOT_BILLING_OPERATIONS_TOKEN?.trim() ?? "";
  if (expectedToken.length < 32) {
    return json({ ok: false, code: "worker_not_configured" }, 503);
  }
  const presented = presentedToken(request);
  if (!presented || !tokensMatch(presented, expectedToken)) {
    return json({ ok: false, code: "access_denied" }, 401);
  }

  let supabaseUrl: string;
  let publishableKey: string;
  try {
    const config = readSupabasePublicConfig();
    supabaseUrl = config.url;
    publishableKey = config.publishableKey;
  } catch {
    return json({ ok: false, code: "provider_not_configured" }, 503);
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  const advance = await supabase.rpc("billing_advance_dunning", {
    operation_token: expectedToken,
  });
  if (advance.error || !isRecord(advance.data) || advance.data.ok !== true) {
    return json({ ok: false, code: "sweep_failed" }, 502);
  }

  return json(advance.data);
}
