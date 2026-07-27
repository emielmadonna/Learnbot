import type {
  ChatCompletion,
  ChatCompletionInput,
  ProviderOutcome,
  ProviderRequestContext,
} from "@course-ai/contracts";
import { OpenAIResponsesAdapter } from "@course-ai/provider-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  estimateTextCostMicro,
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
  if (!adapter) {
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
  const outcome = await adapter.complete(input.context, input.request);
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
