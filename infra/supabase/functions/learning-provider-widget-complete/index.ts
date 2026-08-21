import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

const widgetKeyPattern = /^wk_[0-9a-f]{40}$/u;
const allowedModels = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const requestIdPattern = /^[A-Za-z0-9:_-]{8,200}$/u;
const actorRefPattern = /^[A-Za-z0-9_-]{32,128}$/u;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
    },
  });
}

/*
 * The streaming half of this function.
 *
 * A visitor asking a grounded question over a large course waits several
 * seconds for a complete answer, and the widget and the hosted page had no way
 * to show anything until all of it arrived. Streaming fixes that, but it could
 * NOT be done by letting the console call OpenAI directly: this function is the
 * only place the widget surface's tenant id exists, so it is the only place the
 * reservation and the ledger write can happen. Bypassing it to stream would
 * have made every streamed widget answer unmetered.
 *
 * So the stream is proxied. The reservation below still runs before a single
 * token is bought, and the ledger write still runs -- from the usage carried on
 * the terminal `response.completed` event, which is exactly the same `usage`
 * object the non-streaming branch reads off the JSON body.
 *
 * The wire format is this function's own, not OpenAI's, for the same reason the
 * JSON branch does not forward the provider payload: the console must not have
 * to track provider event names.
 *
 *   event: delta  data: {"text":"..."}
 *   event: done   data: {provider, adapterId, model, credentialSource,
 *                        providerRequestRef, usage}
 *   event: error  data: {"code":"...","retryable":true|false}
 *
 * A stream that ends without `done` is a failed turn. The console does not
 * record it and the visitor is told, exactly as on the authenticated path.
 */
function sseBytes(event: string, data: unknown) {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function streamHeaders() {
  return {
    "cache-control": "private, no-store",
    "content-type": "text/event-stream; charset=utf-8",
    // Some intermediary proxies buffer text/event-stream unless told not to,
    // which would reassemble the whole answer and defeat the point.
    "x-accel-buffering": "no",
  };
}

/*
 * One OpenAI Responses streaming event, reduced to what this function needs.
 *
 * Dispatch is on the payload's own `type` field rather than the SSE `event:`
 * name. Both are sent and they agree today, but the JSON body is the documented
 * discriminator and it survives a transport that drops event names.
 */
type ProviderStreamEvent = {
  text: string | null;
  completed: Record<string, unknown> | null;
  failed: boolean;
};

function providerStreamEvent(data: string): ProviderStreamEvent {
  const none: ProviderStreamEvent = {
    text: null,
    completed: null,
    failed: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return none;
  }
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "response.output_text.delta") {
    return {
      ...none,
      text: typeof record.delta === "string" ? record.delta : null,
    };
  }
  if (type === "response.completed") {
    const response = record.response;
    return {
      ...none,
      completed: response && typeof response === "object" &&
          !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : {},
    };
  }
  // `response.failed`, `response.incomplete` and a bare `error` frame all mean
  // the same thing here: no terminal `done` may be sent.
  if (
    type === "error" || type === "response.failed" ||
    type === "response.incomplete"
  ) {
    return { ...none, failed: true };
  }
  return none;
}


/*
 * Metering for the anonymous widget surface.
 *
 * Widget provider calls have never reached `public.cost_ledger`. The reason was
 * structural rather than deliberate: `/api/widget/ask` never learns the tenant
 * id — that is an intentional boundary, so the anonymous route does not become
 * the one place it leaks — and `learning_reserve_provider_call` needs a tenant.
 *
 * This function is where that stops being a problem. It resolves `tenantId`
 * from the widget key itself (via `learning_widget_provider_runtime_credential`
 * below), holds the operation token, and is the single seam BOTH widget
 * provider calls pass through — the answer and the question classifier. So
 * metering here covers both, adds no provider calls, and never moves the
 * tenant id outward.
 *
 * Both RPCs already accept `target_tenant_id` + `operation_token` for exactly
 * this path; they are granted to `anon` and this function calls them with the
 * service role.
 */
type PriceBook = Record<
  string,
  { inputPerMillionTokens: number; outputPerMillionTokens: number }
>;

function priceBook(): PriceBook {
  const raw = Deno.env.get("LEARNINGBOT_MODEL_PRICES")?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PriceBook)
      : {};
  } catch {
    return {};
  }
}

function tokenCounts(usage: unknown) {
  const record = usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : {};
  const input = Number(record.input_tokens ?? record.prompt_tokens ?? 0);
  const output = Number(record.output_tokens ?? record.completion_tokens ?? 0);
  return {
    input: Number.isFinite(input) && input > 0 ? Math.trunc(input) : 0,
    output: Number.isFinite(output) && output > 0 ? Math.trunc(output) : 0,
  };
}

/*
 * Returns null when the model has no price. A ledger row is still written with
 * the real token counts and `priced: false` — recording usage we cannot price
 * is honest; inventing a number to make the row look complete is not, and this
 * is a cost-plus product where a wrong figure is worse than an absent one.
 */
function estimateCostMicro(
  model: string,
  input: number,
  output: number,
): number | null {
  const price = priceBook()[model];
  if (!price) return null;
  const micro = (input / 1_000_000) * price.inputPerMillionTokens +
    (output / 1_000_000) * price.outputPerMillionTokens;
  return Math.max(0, Math.round(micro));
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function normalizeMessages(value: unknown): Message[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    return null;
  }
  const messages = value.flatMap((item): Message[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = typeof record.content === "string"
      ? record.content.trim()
      : "";
    if (
      (role !== "system" && role !== "user" && role !== "assistant") ||
      !content ||
      content.length > 32_000
    ) {
      return [];
    }
    return [{ role, content }];
  });
  return messages.length === value.length &&
      messages.reduce((total, message) => total + message.content.length, 0) <=
        96_000
    ? messages
    : null;
}

function responseText(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  if (!Array.isArray(record.output)) return null;
  const text = record.output.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? [value] : [];
    });
  });
  return text.join("\n").trim() || null;
}

/*
 * Writes one widget provider call into `public.cost_ledger`.
 *
 * Never throws. The visitor already has (or is receiving) an answer, and a
 * metering failure must not take it away. Mirrors `recordProviderCost` in the
 * console. Both branches of this function -- buffered and streamed -- go
 * through here, so neither can drift into being unmetered.
 */
async function recordWidgetCost(
  service: NonNullable<ReturnType<typeof serviceClient>>,
  input: {
    capability: string;
    model: string;
    usage: unknown;
    requestId: string;
    credentialSource: string;
    tenantId: string;
    operationToken: string;
  },
) {
  try {
    const counts = tokenCounts(input.usage);
    const costMicro = estimateCostMicro(input.model, counts.input, counts.output);
    await service.rpc("learning_record_provider_cost", {
      requested_capability: input.capability,
      provider_key: "openai:openai-managed-widget-responses-v1",
      model_key: input.model,
      quantity: counts.input + counts.output,
      unit: "tokens",
      estimated_cost_micro: costMicro ?? 0,
      trace_id: input.requestId,
      idempotency_key: `widget-cost:${input.requestId}`.slice(0, 200),
      request_id: input.requestId,
      target_conversation_id: null,
      provider_metadata_safe: {
        credentialSource: input.credentialSource,
        inputTokens: counts.input,
        outputTokens: counts.output,
        // `false` means the model was not in LEARNINGBOT_MODEL_PRICES, so the
        // row carries real usage with an unpriced cost of 0 rather than a
        // guess. Bill from usage, not from this column, when it is false.
        priced: costMicro !== null,
      },
      target_tenant_id: input.tenantId,
      operation_token: input.operationToken,
    });
  } catch (error) {
    console.warn(
      "widget.cost.ledger_write_failed",
      JSON.stringify({
        capability: input.capability,
        reason: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

async function safetyIdentifier(tenantId: string, actorRef: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${tenantId}:${actorRef}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const service = serviceClient();
  if (!service) {
    return json({ ok: false, code: "provider_unavailable", retryable: true });
  }

  let input: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, code: "invalid_request" }, 400);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const widgetKey = typeof input.widgetKey === "string"
    ? input.widgetKey.trim()
    : "";
  const origin = typeof input.origin === "string" ? input.origin.trim() : "";
  const operationToken = typeof input.operationToken === "string"
    ? input.operationToken.trim()
    : "";
  const actorRef = typeof input.actorRef === "string"
    ? input.actorRef.trim()
    : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const requestId = typeof input.requestId === "string"
    ? input.requestId.trim()
    : "";
  const maxOutputTokens = typeof input.maxOutputTokens === "number" &&
      Number.isInteger(input.maxOutputTokens) &&
      input.maxOutputTokens >= 64 &&
      input.maxOutputTokens <= 4_096
    ? input.maxOutputTokens
    : 800;
  /*
   * Opt-in, and only ever opt-in. A caller that does not ask for a stream --
   * including every build of the console deployed before this change -- gets
   * byte-for-byte the JSON response this function has always returned.
   */
  const wantsStream = input.stream === true;
  const messages = normalizeMessages(input.messages);
  if (
    !widgetKeyPattern.test(widgetKey) ||
    !origin ||
    origin.length > 255 ||
    operationToken.length < 32 ||
    operationToken.length > 512 ||
    !actorRefPattern.test(actorRef) ||
    !allowedModels.has(model) ||
    !requestIdPattern.test(requestId) ||
    !messages
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const runtime = await service.rpc(
    "learning_widget_provider_runtime_credential",
    {
      widget_key: widgetKey,
      origin,
      operation_token: operationToken,
      requested_provider: "openai",
    },
  );
  const context =
    runtime.data && typeof runtime.data === "object" &&
      !Array.isArray(runtime.data)
      ? (runtime.data as Record<string, unknown>)
      : null;
  if (
    runtime.error ||
    context?.ok !== true ||
    typeof context.tenantId !== "string"
  ) {
    return json({ ok: false, code: "provider_unavailable" });
  }
  // Bound once, so both the buffered and the streamed ledger write name the
  // same tenant and neither depends on narrowing an index-signature read.
  const tenantId: string = context.tenantId;

  /*
   * Reserve before spending. A tenant over budget must stop costing money on
   * the surface strangers can reach, which is the whole point of enforcement.
   *
   * `metering_unavailable` is treated as allow-and-continue, matching
   * `reserveProviderCall` in the console: an outage in the meter must not take
   * the assistant down. A structural refusal (`ok:false`) is a real decision
   * and is honoured.
   */
  const capability = model === "gpt-5.6-luna"
    ? "question.classification"
    : "conversation.answer";
  const reservation = await service.rpc("learning_reserve_provider_call", {
    requested_capability: capability,
    subject_key: actorRef,
    target_tenant_id: tenantId,
    operation_token: operationToken,
  });
  const decision =
    reservation.data && typeof reservation.data === "object" &&
      !Array.isArray(reservation.data)
      ? (reservation.data as Record<string, unknown>)
      : null;
  if (!reservation.error && decision?.ok === true && decision.allowed !== true) {
    return json({
      ok: false,
      code: "provider_budget_exhausted",
      retryable: true,
    });
  }

  let credential =
    typeof context.credential === "string" ? context.credential.trim() : "";
  let credentialSource = "tenant_vault";
  if (!credential) {
    credential = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
    credentialSource = "platform_managed";
  }
  if (!credential) {
    return json({ ok: false, code: "provider_not_configured" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const providerResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        accept: wantsStream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "x-client-request-id": requestId,
      },
      body: JSON.stringify({
        model,
        input: messages,
        max_output_tokens: maxOutputTokens,
        safety_identifier: await safetyIdentifier(tenantId, actorRef),
        store: false,
        ...(wantsStream ? { stream: true } : {}),
      }),
      signal: controller.signal,
    });
    if (!providerResponse.ok) {
      /*
       * Still JSON, even when a stream was requested. Nothing has been
       * committed to the wire yet, so a refusal here can keep the named,
       * explainable shape the console already knows how to report. The console
       * only switches to reading a stream once it sees `text/event-stream`
       * come back, which is why this is safe rather than a second contract.
       */
      return json({
        ok: false,
        code: providerResponse.status === 401 || providerResponse.status === 403
          ? "provider_authentication_failed"
          : providerResponse.status === 429 || providerResponse.status >= 500
            ? "provider_unavailable"
            : "provider_failed",
        retryable:
          providerResponse.status === 429 || providerResponse.status >= 500,
      });
    }

    if (wantsStream) {
      const body = providerResponse.body;
      if (!body) return json({ ok: false, code: "provider_response_invalid" });
      // The 30s guard above covers time-to-first-byte. A stream that has begun
      // gets its own, longer budget, because it is bounded by
      // `max_output_tokens` and is already delivering value to the visitor.
      clearTimeout(timeout);
      const streamGuard = setTimeout(() => controller.abort(), 90_000);

      const stream = new ReadableStream<Uint8Array>({
        async start(outbound) {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let text = "";
          let completed: Record<string, unknown> | null = null;
          let failed = false;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              // SSE frames are separated by a blank line; a partial frame stays
              // in the buffer until the rest of it arrives.
              let boundary = buffer.indexOf("\n\n");
              while (boundary !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                for (const line of frame.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  const event = providerStreamEvent(line.slice(5).trim());
                  if (event.failed) failed = true;
                  if (event.completed) completed = event.completed;
                  if (event.text) {
                    text += event.text;
                    outbound.enqueue(sseBytes("delta", { text: event.text }));
                  }
                }
                boundary = buffer.indexOf("\n\n");
              }
            }
          } catch {
            failed = true;
          } finally {
            clearTimeout(streamGuard);
          }

          if (failed || completed === null || text.trim().length === 0) {
            // No terminal `done`. The console will not record this turn.
            outbound.enqueue(
              sseBytes("error", {
                code: "provider_response_invalid",
                retryable: true,
              }),
            );
            outbound.close();
            return;
          }

          // Same ledger write the buffered branch makes, from the same `usage`
          // object -- it rides on the terminal `response.completed` event.
          await recordWidgetCost(service, {
            capability,
            model,
            usage: completed.usage ?? null,
            requestId,
            credentialSource,
            tenantId,
            operationToken,
          });

          outbound.enqueue(
            sseBytes("done", {
              provider: "openai",
              adapterId: "openai-managed-widget-responses-v1",
              model,
              credentialSource,
              providerRequestRef: typeof completed.id === "string"
                ? completed.id
                : requestId,
              usage: completed.usage && typeof completed.usage === "object" &&
                  !Array.isArray(completed.usage)
                ? completed.usage
                : {},
            }),
          );
          outbound.close();
        },
        cancel() {
          // The console disconnected. Stop buying tokens for a turn nobody
          // will receive: this is live spend, not just a UI concern.
          clearTimeout(streamGuard);
          controller.abort();
        },
      });

      return new Response(stream, { headers: streamHeaders() });
    }

    const payload = await providerResponse.json();
    const text = responseText(payload);
    if (!text) return json({ ok: false, code: "provider_response_invalid" });
    const usage = payload && typeof payload === "object" &&
        !Array.isArray(payload)
      ? (payload as Record<string, unknown>).usage
      : null;

    await recordWidgetCost(service, {
      capability,
      model,
      usage,
      requestId,
      credentialSource,
      tenantId,
      operationToken,
    });

    return json({
      ok: true,
      provider: "openai",
      adapterId: "openai-managed-widget-responses-v1",
      model,
      text,
      credentialSource,
      providerRequestRef:
        payload && typeof payload === "object" && !Array.isArray(payload) &&
          typeof (payload as Record<string, unknown>).id === "string"
          ? (payload as Record<string, unknown>).id
          : requestId,
      usage: usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage
        : {},
    });
  } catch {
    return json({
      ok: false,
      code: "provider_unavailable",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
});
