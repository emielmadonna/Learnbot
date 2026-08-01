import type {
  ChatCompletion,
  ChatCompletionInput,
  ProviderOutcome,
  ProviderRequestContext,
  UsageQuantity,
} from "@course-ai/contracts";
import { OpenAIResponsesAdapter } from "@course-ai/provider-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  estimateTextCostMicro,
  isKnownTextModel,
  readTokenUsage,
  recordProviderCost,
  reserveProviderCall,
  reservationMessage,
  type ProviderCapability,
} from "./cost-metering";

/**
 * The single seam every provider call goes through.
 *
 * Metering and budget enforcement belong here rather than at each call site,
 * because a call site added later would otherwise silently escape both. The
 * wrapper does three things around one completion:
 *
 *   1. asks the database whether the tenant may spend (durable, not in-process);
 *   2. runs the completion;
 *   3. writes what it cost into `public.cost_ledger`, best effort.
 *
 * Step 3 can never fail the request. Step 1 can, and that refusal is a named,
 * explainable one rather than a generic error.
 */

export type ProviderRuntimeErrorCode =
  | "provider_not_configured"
  | "provider_failed"
  | "operation_secret_unavailable"
  | "spend_refused";

export class ProviderRuntimeError extends Error {
  constructor(
    readonly code: ProviderRuntimeErrorCode,
    readonly retryable: boolean,
    /** Safe to show a learner. Never contains provider or secret detail. */
    readonly publicMessage: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(code);
    this.name = "ProviderRuntimeError";
  }
}

const providerRuntime = globalThis as typeof globalThis & {
  __learningBotProviderAdapters?: Map<string, OpenAIResponsesAdapter>;
};

export function providerCredential(): string | null {
  const credential = process.env.OPENAI_API_KEY?.trim();
  return credential && credential.length >= 20 ? credential : null;
}

/**
 * One memoized adapter per adapter id. The id is recorded on every ledger row
 * and every assistant message, so answer and classifier spend stay separable.
 */
export function sharedResponsesAdapter(adapterId: string) {
  const credential = providerCredential();
  if (!credential) return null;
  providerRuntime.__learningBotProviderAdapters ??= new Map();
  const existing = providerRuntime.__learningBotProviderAdapters.get(adapterId);
  if (existing) return existing;
  const adapter = new OpenAIResponsesAdapter({
    id: adapterId,
    credentialResolver: async () => credential,
  });
  providerRuntime.__learningBotProviderAdapters.set(adapterId, adapter);
  return adapter;
}

type ManagedCompletionPayload = {
  ok?: unknown;
  code?: unknown;
  retryable?: unknown;
  provider?: unknown;
  adapterId?: unknown;
  model?: unknown;
  text?: unknown;
  providerRequestRef?: unknown;
  credentialSource?: unknown;
  usage?: unknown;
};

function managedUsage(value: unknown): readonly UsageQuantity[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const entries: UsageQuantity[] = [];
  const add = (key: string, unit: string) => {
    const quantity = row[key];
    if (
      typeof quantity === "number" &&
      Number.isFinite(quantity) &&
      quantity >= 0
    ) {
      entries.push({ quantity, unit });
    }
  };
  add("input_tokens", "input_tokens");
  add("output_tokens", "output_tokens");
  add("total_tokens", "tokens");
  return entries;
}

function managedProviderError(
  adapterId: string,
  payload: ManagedCompletionPayload | null,
): ProviderOutcome<ChatCompletion> {
  const code =
    payload?.code === "provider_authentication_failed"
      ? "authentication_failed"
      : payload?.code === "access_denied"
        ? "permission_denied"
        : payload?.code === "provider_unavailable"
          ? "provider_unavailable"
          : payload?.code === "provider_not_configured" ||
              payload?.code === "tenant_credential_not_configured"
            ? "capability_unavailable"
            : payload?.code === "invalid_request"
              ? "invalid_request"
              : "provider_error";
  return {
    ok: false,
    error: {
      code,
      message: "The managed learning provider could not complete the request.",
      retryable: payload?.retryable === true || code === "provider_unavailable",
      adapterId,
    },
    attempts: [],
  };
}

/**
 * Use the linked Supabase project's server-held provider credential when the
 * console process does not have a local OpenAI key. The Edge Function verifies
 * the signed-in user and their selected tenant before reading either a
 * tenant-owned Vault key or the platform-managed fallback.
 */
export async function completeWithManagedProvider(input: {
  supabase: SupabaseClient;
  context: ProviderRequestContext;
  request: ChatCompletionInput;
  adapterId: string;
}): Promise<ProviderOutcome<ChatCompletion>> {
  const startedAt = Date.now();
  const invoked = await input.supabase.functions.invoke(
    "learning-provider-complete",
    {
      body: {
        tenantId: input.context.tenantId,
        provider: "openai",
        model: input.request.model,
        requestId: input.context.requestId,
        messages: input.request.messages,
        maxOutputTokens: input.request.maxOutputTokens,
      },
    },
  );
  const payload =
    invoked.data && typeof invoked.data === "object" && !Array.isArray(invoked.data)
      ? (invoked.data as ManagedCompletionPayload)
      : null;
  if (invoked.error || payload?.ok !== true || typeof payload.text !== "string") {
    return managedProviderError(input.adapterId, payload);
  }
  const adapterId =
    typeof payload.adapterId === "string" && payload.adapterId.trim()
      ? payload.adapterId
      : input.adapterId;
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model
      : input.request.model;
  const responseId =
    typeof payload.providerRequestRef === "string"
      ? payload.providerRequestRef
      : input.context.requestId;
  return {
    ok: true,
    result: {
      value: {
        message: { role: "assistant", content: payload.text.trim() },
        finishReason: "stop",
      },
      provider: typeof payload.provider === "string" ? payload.provider : "openai",
      adapterId,
      ...(model ? { modelOrSku: model } : {}),
      latencyMs: Math.max(0, Date.now() - startedAt),
      usage: managedUsage(payload.usage),
      estimatedCost: { amount: 0, currency: "USD" },
      providerMetadata: {
        providerRequestId: responseId,
        credentialSource:
          payload.credentialSource === "tenant_vault"
            ? "tenant_vault"
            : "platform_managed",
        costEstimated: false,
      },
    },
  };
}

/**
 * Complete an anonymous widget turn through the server-only provider boundary.
 * The Edge Function revalidates the widget key, exact Origin and rotating
 * operation token before it resolves any tenant or credential.
 */
export async function completeWithManagedWidgetProvider(input: {
  supabase: SupabaseClient;
  context: ProviderRequestContext;
  request: ChatCompletionInput;
  adapterId: string;
  widgetKey: string;
  origin: string;
  operationToken: string;
  actorRef: string;
}): Promise<ProviderOutcome<ChatCompletion>> {
  const startedAt = Date.now();
  const invoked = await input.supabase.functions.invoke(
    "learning-provider-widget-complete",
    {
      body: {
        widgetKey: input.widgetKey,
        origin: input.origin,
        operationToken: input.operationToken,
        actorRef: input.actorRef,
        provider: "openai",
        model: input.request.model,
        requestId: input.context.requestId,
        messages: input.request.messages,
        maxOutputTokens: input.request.maxOutputTokens,
      },
    },
  );
  const payload =
    invoked.data && typeof invoked.data === "object" && !Array.isArray(invoked.data)
      ? (invoked.data as ManagedCompletionPayload)
      : null;
  if (invoked.error || payload?.ok !== true || typeof payload.text !== "string") {
    return managedProviderError(input.adapterId, payload);
  }
  const adapterId =
    typeof payload.adapterId === "string" && payload.adapterId.trim()
      ? payload.adapterId
      : input.adapterId;
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model
      : input.request.model;
  const responseId =
    typeof payload.providerRequestRef === "string"
      ? payload.providerRequestRef
      : input.context.requestId;
  return {
    ok: true,
    result: {
      value: {
        message: { role: "assistant", content: payload.text.trim() },
        finishReason: "stop",
      },
      provider: typeof payload.provider === "string" ? payload.provider : "openai",
      adapterId,
      ...(model ? { modelOrSku: model } : {}),
      latencyMs: Math.max(0, Date.now() - startedAt),
      usage: managedUsage(payload.usage),
      estimatedCost: { amount: 0, currency: "USD" },
      providerMetadata: {
        providerRequestId: responseId,
        credentialSource:
          payload.credentialSource === "tenant_vault"
            ? "tenant_vault"
            : "platform_managed",
        costEstimated: false,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Managed widget streaming
// ---------------------------------------------------------------------------

/**
 * One event from the managed widget provider stream.
 *
 * Deliberately the same shape the provider-router's `streamChatText` yields on
 * the authenticated path, so `api/widget/ask` and `api/learning/respond` drive
 * their SSE loops identically and neither invents a second vocabulary.
 */
export type ManagedWidgetStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "done";
      readonly provider: string;
      readonly adapterId: string;
      readonly model: string | null;
      readonly providerRequestRef: string;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly retryable: boolean;
    };

function managedStreamErrorCode(payload: Record<string, unknown> | null) {
  const code = typeof payload?.code === "string" ? payload.code : "";
  return code === "provider_budget_exhausted" ||
    code === "provider_unavailable" ||
    code === "provider_authentication_failed" ||
    code === "provider_not_configured" ||
    code === "provider_response_invalid" ||
    code === "invalid_request"
    ? code
    : "provider_failed";
}

/**
 * Stream one anonymous widget turn through the server-only provider boundary.
 *
 * This is `completeWithManagedWidgetProvider` with `stream: true`, and it goes
 * through the SAME Edge Function for a reason that is not stylistic: that
 * function is the only place the widget surface's tenant id exists, so it is
 * the only place `learning_reserve_provider_call` can run before the spend and
 * `learning_record_provider_cost` after it. Streaming from the console directly
 * would have made every streamed widget answer unmetered.
 *
 * TWO DEPLOYMENTS ARE HANDLED, and the difference is invisible to the caller:
 *
 *   - An Edge Function that understands `stream: true` answers with
 *     `text/event-stream`. `functions.invoke` hands back the raw `Response` for
 *     that content type, and its frames are re-yielded here as deltas.
 *   - An Edge Function deployed BEFORE this change ignores the unknown field
 *     and answers with the JSON it always has. Rather than fail, that whole
 *     answer is yielded as a single delta followed by `done`. The visitor still
 *     gets sources immediately and an answer that renders through the same
 *     path; only the token-by-token reveal is missing.
 *
 * Edge functions on this project are deployed by hand, so the second case is
 * the live one until `learning-provider-widget-complete` is pushed.
 */
export async function* streamWithManagedWidgetProvider(input: {
  supabase: SupabaseClient;
  context: ProviderRequestContext;
  request: ChatCompletionInput;
  adapterId: string;
  widgetKey: string;
  origin: string;
  operationToken: string;
  actorRef: string;
  signal?: AbortSignal;
}): AsyncGenerator<ManagedWidgetStreamEvent> {
  const invoked = await input.supabase.functions.invoke(
    "learning-provider-widget-complete",
    {
      body: {
        widgetKey: input.widgetKey,
        origin: input.origin,
        operationToken: input.operationToken,
        actorRef: input.actorRef,
        provider: "openai",
        model: input.request.model,
        requestId: input.context.requestId,
        messages: input.request.messages,
        maxOutputTokens: input.request.maxOutputTokens,
        stream: true,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );

  const streamed =
    invoked.data instanceof Response &&
    (invoked.data.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("text/event-stream")
      ? invoked.data
      : null;

  if (streamed === null) {
    // The buffered contract, unchanged. `invoked.error` covers a transport
    // failure and a non-2xx from the function; `ok !== true` covers a named
    // refusal the function returned with a 200, which is how it reports
    // budget exhaustion and provider faults.
    const payload =
      invoked.data &&
      typeof invoked.data === "object" &&
      !Array.isArray(invoked.data)
        ? (invoked.data as ManagedCompletionPayload)
        : null;
    if (
      invoked.error ||
      payload?.ok !== true ||
      typeof payload.text !== "string" ||
      payload.text.trim() === ""
    ) {
      yield {
        type: "error",
        code: managedStreamErrorCode(payload),
        retryable: payload?.retryable === true,
      };
      return;
    }
    yield { type: "delta", text: payload.text.trim() };
    yield {
      type: "done",
      provider:
        typeof payload.provider === "string" ? payload.provider : "openai",
      adapterId:
        typeof payload.adapterId === "string" && payload.adapterId.trim()
          ? payload.adapterId
          : input.adapterId,
      model:
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model
          : (input.request.model ?? null),
      providerRequestRef:
        typeof payload.providerRequestRef === "string"
          ? payload.providerRequestRef
          : input.context.requestId,
    };
    return;
  }

  const body = streamed.body;
  if (body === null) {
    yield { type: "error", code: "provider_response_invalid", retryable: true };
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Frames are separated by a blank line; a partial frame waits for the
      // rest of itself rather than being parsed as truncated JSON.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let name = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const record =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        if (name === "delta") {
          const text = typeof record.text === "string" ? record.text : "";
          if (text.length > 0) yield { type: "delta", text };
          continue;
        }
        if (name === "error") {
          yield {
            type: "error",
            code:
              typeof record.code === "string"
                ? record.code
                : "provider_failed",
            retryable: record.retryable === true,
          };
          return;
        }
        if (name === "done") {
          yield {
            type: "done",
            provider:
              typeof record.provider === "string" ? record.provider : "openai",
            adapterId:
              typeof record.adapterId === "string" && record.adapterId.trim()
                ? record.adapterId
                : input.adapterId,
            model:
              typeof record.model === "string" && record.model.trim()
                ? record.model
                : (input.request.model ?? null),
            providerRequestRef:
              typeof record.providerRequestRef === "string"
                ? record.providerRequestRef
                : input.context.requestId,
          };
          return;
        }
      }
    }
  } finally {
    // A caller that stops iterating (the visitor closed the tab) releases the
    // reader here, which cancels the Edge Function's own stream and stops the
    // provider spend behind it.
    try {
      await reader.cancel();
    } catch {
      // Already closed by the peer.
    }
  }
  // Fell off the end with no terminal frame. The caller must treat this as a
  // failed turn and record nothing.
}

// ---------------------------------------------------------------------------
// Operation secret health
// ---------------------------------------------------------------------------

/**
 * The server-held token that gates every write on the answer path. It is read
 * from the environment; whether it still matches a valid row in
 * `app_private.learning_operation_secrets` is a database question, answered by
 * `readOperationSecretHealth`.
 */
export function conversationOperationToken(): string | null {
  const token = process.env.LEARNINGBOT_CONVERSATION_OPERATION_TOKEN?.trim();
  return token && token.length >= 32 && token.length <= 512 ? token : null;
}

export type OperationSecretHealth = {
  readonly configured: boolean;
  readonly code:
    | "operation_secret_available"
    | "operation_secret_unavailable"
    | "operation_secret_unknown";
};

/**
 * Turns a silent denial into an operational fact.
 *
 * Without this, an expired secret makes `learning_get_agent_directive` and
 * `learning_record_assistant_message` deny, and the answer route reports a
 * generic `request_denied` — indistinguishable from a permissions bug and
 * impossible to act on. `unknown` is returned when the health RPC itself is
 * unavailable, so a pre-migration deployment is never mislabelled as expired.
 */
export async function readOperationSecretHealth(
  supabase: SupabaseClient,
  capability = "conversation.answer.record",
): Promise<OperationSecretHealth> {
  try {
    const { data, error } = await supabase.rpc(
      "learning_operation_capability_health",
      { requested_capability: capability },
    );
    if (
      error ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (data as Record<string, unknown>).ok !== true
    ) {
      return { configured: false, code: "operation_secret_unknown" };
    }
    const configured =
      (data as Record<string, unknown>).configured === true;
    return {
      configured,
      code: configured
        ? "operation_secret_available"
        : "operation_secret_unavailable",
    };
  } catch {
    return { configured: false, code: "operation_secret_unknown" };
  }
}

/**
 * The error an answer path should raise when the conversation operation secret
 * is missing or expired. It names the operational cause instead of returning a
 * generic denial — and, critically, instead of returning a plausible answer
 * that was never recorded.
 */
export function operationSecretError(
  health: OperationSecretHealth = {
    configured: false,
    code: "operation_secret_unavailable",
  },
) {
  return new ProviderRuntimeError(
    "operation_secret_unavailable",
    false,
    health.code === "operation_secret_unknown"
      ? "The assistant is not available: its server credential could not be verified."
      : "The assistant is not available: its server credential is missing or has expired. An administrator must rotate the conversation operation secret.",
  );
}

// ---------------------------------------------------------------------------
// Metered completion
// ---------------------------------------------------------------------------

export type MeteredCompletionInput = {
  readonly supabase: SupabaseClient;
  readonly capability: ProviderCapability;
  readonly adapterId: string;
  readonly context: ProviderRequestContext;
  readonly request: ChatCompletionInput;
  /** Rate-limit subject; hashed before it reaches the database. */
  readonly subjectKey: string;
  readonly conversationId?: string | null;
  /** Only for the trusted server path serving anonymous widget traffic. */
  readonly tenantId?: string | null;
  readonly operationToken?: string | null;
  /** When false the reservation is skipped (already taken by the caller). */
  readonly reserve?: boolean;
};

export type MeteredCompletion = {
  readonly outcome: ProviderOutcome<ChatCompletion>;
  readonly model: string | null;
  readonly costMicro: number;
};

/**
 * Runs one completion with a reservation before it and a ledger write after it.
 * Throws `ProviderRuntimeError` for a refused reservation or a missing
 * credential; provider faults are returned in `outcome` so the caller keeps its
 * own failure policy (the classifier fails soft, the answer path does not).
 */
export async function runMeteredCompletion(
  input: MeteredCompletionInput,
): Promise<MeteredCompletion> {
  const adapter = sharedResponsesAdapter(input.adapterId);
  if (!adapter && !input.supabase) {
    throw new ProviderRuntimeError(
      "provider_not_configured",
      false,
      "The learning provider is not configured.",
    );
  }

  if (input.reserve !== false) {
    const decision = await reserveProviderCall(input.supabase, {
      capability: input.capability,
      subjectKey: input.subjectKey,
      tenantId: input.tenantId ?? null,
      operationToken: input.operationToken ?? null,
    });
    if (!decision.allowed) {
      throw new ProviderRuntimeError(
        decision.code === "operation_secret_unavailable"
          ? "operation_secret_unavailable"
          : "spend_refused",
        decision.retryAfterSeconds > 0,
        reservationMessage(decision.code),
        decision.retryAfterSeconds,
      );
    }
  }

  const model = input.request.model ?? null;
  const outcome = adapter
    ? await adapter.complete(input.context, input.request)
    : await completeWithManagedProvider({
        supabase: input.supabase,
        context: input.context,
        request: input.request,
        adapterId: input.adapterId,
      });
  let costMicro = 0;
  if (outcome.ok) {
    const usage = readTokenUsage(outcome.result.usage);
    const resolvedModel = outcome.result.modelOrSku ?? model;
    costMicro = estimateTextCostMicro(resolvedModel, usage);
    // Deliberately not awaited into the critical path's failure surface: the
    // answer is already produced, and a ledger fault must not undo it.
    await recordProviderCost(input.supabase, {
      capability: input.capability,
      providerKey: `${outcome.result.provider}:${outcome.result.adapterId}`,
      modelKey: resolvedModel,
      quantity: usage.totalTokens,
      unit: "tokens",
      costMicro,
      traceId: input.context.traceId,
      idempotencyKey: `cost:${input.capability}:${
        input.context.idempotencyKey ?? input.context.requestId
      }`,
      requestId: input.context.requestId ?? null,
      conversationId: input.conversationId ?? null,
      metadata: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: outcome.result.latencyMs,
      },
      tenantId: input.tenantId ?? null,
      operationToken: input.operationToken ?? null,
    });
  }
  return { outcome, model, costMicro };
}

// ---------------------------------------------------------------------------
// Agent configuration — validated on read (Phase 14, PLAN.md §6)
// ---------------------------------------------------------------------------

/**
 * The adapter id shared by every text completion on the answer path (the
 * main JSON response and its SSE-streamed twin). One id, so every ledger row
 * and every recorded assistant message on the answer path is attributable to
 * the same provider integration.
 */
export const ANSWER_ADAPTER_ID = "openai-responses-production-v1";

const DEFAULT_AGENT_MODEL =
  process.env.LEARNINGBOT_LLM_MODEL?.trim() || "gpt-5.6-terra";
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_TOP_P = 1.0;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_RETRIEVAL_COUNT = 6;
const DEFAULT_RETRIEVAL_SIMILARITY_FLOOR = 0.2;
// Identical wording to the fallback the answer path already used before this
// column existed, so a tenant that has never touched this setting sees no
// change in the refusal they already know.
const DEFAULT_NO_RESULTS_MESSAGE =
  "I couldn’t find this in the published learning yet. Try naming the course, lesson, or idea you want to understand.";
const DEFAULT_ESCALATION_TRIGGER = "manual";
const DEFAULT_ESCALATION_MESSAGE =
  "A member of this workspace's team can help with this — ask, and it will be flagged for follow-up.";

const ESCALATION_TRIGGERS = new Set([
  "manual",
  "always_available",
  "after_no_results",
  "after_repeated_question",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  const resolved = boundedNumber(value, min, max);
  return resolved === null ? null : Math.round(resolved);
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

export type ResolvedAgentDirective = {
  readonly model: string;
  /**
   * True when the stored model was rejected — unpriced, invalid, or absent —
   * and the platform default was substituted instead.
   */
  readonly modelFellBack: boolean;
  readonly temperature: number;
  readonly topP: number;
  readonly maxOutputTokens: number;
  readonly retrievalCount: number;
  readonly retrievalSimilarityFloor: number;
  readonly noResultsMessage: string;
  readonly escalationEnabled: boolean;
  readonly escalationTrigger: string;
  readonly escalationMessage: string | null;
  readonly personaInstructions: string | null;
  readonly tone: string | null;
};

/**
 * Turns the raw `learning_get_agent_directive` payload — or nothing at all —
 * into a directive every field of which is safe to hand to a provider call.
 *
 * This is the validate-on-read boundary PLAN.md §6.1/§10 requires: a stored
 * temperature outside 0–2, a model with no price entry in
 * `cost-metering.ts`, a null where a number is expected, or a directive from
 * a tenant whose `tenant_branding` row predates this migration (every new
 * field simply absent) all fall back to the same safe default rather than
 * reaching the provider or crashing the turn.
 *
 * What this function deliberately does *not* decide: whether to refuse when
 * retrieval is empty. That decision is not the creator's, stays in the
 * callers of this function as an unconditional code path, and is never read
 * from the directive. Only `noResultsMessage` — the wording of that refusal
 * — is read here.
 */
export function resolveAgentDirective(raw: unknown): ResolvedAgentDirective {
  const directive = isPlainRecord(raw) ? raw : {};

  const requestedModel =
    typeof directive.model === "string" ? directive.model.trim() : "";
  let model = requestedModel;
  let modelFellBack = false;
  if (!model || !isKnownTextModel(model)) {
    if (model) {
      // A stored model with no price entry cannot be billed correctly
      // (PLAN.md §6.1, §10). Fall back rather than silently call an unpriced
      // model, and log it so the gap in the price book is visible.
      console.warn(
        "agent.directive.model_unpriced_fallback",
        JSON.stringify({
          requestedModel: model,
          fallbackModel: DEFAULT_AGENT_MODEL,
        }),
      );
    }
    model = DEFAULT_AGENT_MODEL;
    modelFellBack = true;
  }

  const temperature =
    boundedNumber(directive.temperature, 0, 2) ?? DEFAULT_TEMPERATURE;
  const topP = boundedNumber(directive.topP, 0.01, 1) ?? DEFAULT_TOP_P;
  const maxOutputTokens =
    boundedInteger(directive.maxOutputTokens, 64, 4000) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  const retrievalCount =
    boundedInteger(directive.retrievalCount, 1, 20) ?? DEFAULT_RETRIEVAL_COUNT;
  const retrievalSimilarityFloor =
    boundedNumber(directive.retrievalSimilarityFloor, 0, 1) ??
    DEFAULT_RETRIEVAL_SIMILARITY_FLOOR;
  const noResultsMessage =
    boundedText(directive.noResultsMessage, 500) ?? DEFAULT_NO_RESULTS_MESSAGE;

  const escalationEnabled = directive.escalationEnabled === true;
  const escalationTrigger =
    typeof directive.escalationTrigger === "string" &&
    ESCALATION_TRIGGERS.has(directive.escalationTrigger)
      ? directive.escalationTrigger
      : DEFAULT_ESCALATION_TRIGGER;
  const escalationMessage = escalationEnabled
    ? boundedText(directive.escalationMessage, 500) ?? DEFAULT_ESCALATION_MESSAGE
    : null;

  const personaInstructions =
    typeof directive.personaInstructions === "string"
      ? directive.personaInstructions
      : null;
  const tone = typeof directive.tone === "string" ? directive.tone : null;

  return {
    model,
    modelFellBack,
    temperature,
    topP,
    maxOutputTokens,
    retrievalCount,
    retrievalSimilarityFloor,
    noResultsMessage,
    escalationEnabled,
    escalationTrigger,
    escalationMessage,
    personaInstructions,
    tone,
  };
}

export type EscalationOffer = {
  readonly offered: boolean;
  readonly trigger: string;
  readonly message: string | null;
};

/**
 * Whether to offer a hand-off to a human on this turn, and what to say.
 *
 * The trigger vocabulary matches the creator-facing options in
 * `agent-panel.tsx`: `always_available` offers on every answer,
 * `after_no_results` offers alongside the refusal, `after_repeated_question`
 * offers once a learner visibly repeats themselves, and `manual` never
 * offers proactively — a student has to ask, which this function has no way
 * to observe from here and therefore never triggers on its own.
 */
export function resolveEscalationOffer(
  directive: ResolvedAgentDirective,
  context: { readonly refused: boolean; readonly repeated: boolean },
): EscalationOffer {
  if (!directive.escalationEnabled) {
    return {
      offered: false,
      trigger: directive.escalationTrigger,
      message: null,
    };
  }
  const offered =
    directive.escalationTrigger === "always_available" ||
    (directive.escalationTrigger === "after_no_results" && context.refused) ||
    (directive.escalationTrigger === "after_repeated_question" &&
      context.repeated);
  return {
    offered,
    trigger: directive.escalationTrigger,
    message: offered ? directive.escalationMessage : null,
  };
}
