import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cost metering and durable budget enforcement.
 *
 * `public.cost_ledger` existed from migration 0005 and had no writer anywhere
 * in the repository. Every OpenAI call — chat, classification, embedding,
 * transcription, speech and realtime — was therefore invisible until it
 * appeared on an invoice, and the widget is about to put that same key behind
 * anonymous public traffic.
 *
 * Two rules shape everything here:
 *
 *   1. **Metering never breaks answering.** Every write is best effort. A
 *      failed ledger write is a log line and nothing else: a broken assistant
 *      is far more expensive than a missing cost row.
 *   2. **Enforcement is durable.** The budget and rate checks are SQL, reading
 *      `public.cost_ledger` and `public.provider_rate_events`. They are not a
 *      process-local `Map`, because a serverless platform resets one of those
 *      on every cold start and the limit then means nothing.
 *
 * Money is carried in **micro units** — millionths of one major currency unit,
 * so 1 000 000 micro-USD is 1 USD. `cost_ledger.estimated_cost_minor` counts
 * whole cents, and a single completion routinely costs a fraction of one, so
 * accumulating in cents rounds every call to zero and no budget ever trips.
 * The SQL keeps both: micro units accumulate, minor units stay human-readable.
 */

export const MICRO_UNITS_PER_MAJOR_UNIT = 1_000_000;

/** Capability keys recorded on every ledger row and rate event. */
export const PROVIDER_CAPABILITIES = [
  "conversation.answer",
  "conversation.classify",
  "conversation.embed",
  "voice.transcribe",
  "voice.speak",
  "voice.realtime",
  "widget.answer",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

type TextPrice = {
  /** Micro units per one million input tokens. */
  readonly inputPerMillionTokens: number;
  /** Micro units per one million output tokens. */
  readonly outputPerMillionTokens: number;
};

type UnitPrice = {
  /** Micro units per single billed unit (a second, a character, a session). */
  readonly perUnit: number;
  readonly unit: string;
};

/**
 * Default price book, in micro units.
 *
 * These are *estimates*. An operator sets `LEARNINGBOT_MODEL_PRICES` to the
 * figures on their own provider invoice; anything not listed falls back to
 * UNKNOWN_MODEL_PRICE, which is priced high on purpose so an unrecognised
 * model overstates rather than hides spend. A budget built on an understated
 * price is worse than no budget.
 */
const UNKNOWN_MODEL_PRICE: TextPrice = {
  inputPerMillionTokens: 5_000_000,
  outputPerMillionTokens: 15_000_000,
};

const DEFAULT_TEXT_PRICES: Record<string, TextPrice> = {
  "gpt-5.6-luna": {
    inputPerMillionTokens: 1_250_000,
    outputPerMillionTokens: 10_000_000,
  },
  "gpt-5.6-luna-mini": {
    inputPerMillionTokens: 250_000,
    outputPerMillionTokens: 2_000_000,
  },
  "text-embedding-3-small": {
    inputPerMillionTokens: 20_000,
    outputPerMillionTokens: 0,
  },
};

const DEFAULT_UNIT_PRICES: Record<string, UnitPrice> = {
  // Transcription is billed by audio duration.
  "gpt-4o-mini-transcribe": { perUnit: 100, unit: "audio_seconds" },
  // Speech synthesis is billed by input characters.
  "gpt-4o-mini-tts": { perUnit: 15, unit: "characters" },
  // A realtime session is metered once, at connection, as an estimate. The
  // browser holds the socket, so the server cannot observe its true duration.
  "gpt-realtime-2.1": { perUnit: 300_000, unit: "realtime_sessions" },
};

function parseOverrides(): Record<string, unknown> {
  const raw = process.env.LEARNINGBOT_MODEL_PRICES?.trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A malformed price book must not break a request. The defaults, which
    // overstate rather than understate, remain in force.
    console.warn("cost.price_book.invalid_json");
    return {};
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function textPrice(model: string | null): TextPrice {
  const key = model?.trim() ?? "";
  const override = parseOverrides()[key];
  if (override && typeof override === "object" && !Array.isArray(override)) {
    const record = override as Record<string, unknown>;
    const input = positiveNumber(record.inputPerMillionTokens);
    const output = positiveNumber(record.outputPerMillionTokens);
    if (input !== null && output !== null) {
      return { inputPerMillionTokens: input, outputPerMillionTokens: output };
    }
  }
  return DEFAULT_TEXT_PRICES[key] ?? UNKNOWN_MODEL_PRICE;
}

/**
 * Whether a text model has a genuine price entry — the platform's default
 * price book or a well-formed `LEARNINGBOT_MODEL_PRICES` override — as
 * opposed to silently falling back to `UNKNOWN_MODEL_PRICE`.
 *
 * A model a creator can select must pass this check first (PLAN.md §6.1,
 * §10): an unpriced model is a model this platform cannot bill correctly, so
 * it must never be sent to the provider on the strength of a stored
 * configuration value alone. Callers that resolve agent configuration use
 * this to decide whether to honour a stored `agent_model` or fall back to
 * the platform default.
 */
export function isKnownTextModel(model: string | null | undefined): boolean {
  const key = model?.trim() ?? "";
  if (key === "") return false;
  if (Object.hasOwn(DEFAULT_TEXT_PRICES, key)) return true;
  const override = parseOverrides()[key];
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return false;
  }
  const record = override as Record<string, unknown>;
  return (
    positiveNumber(record.inputPerMillionTokens) !== null &&
    positiveNumber(record.outputPerMillionTokens) !== null
  );
}

function unitPrice(model: string | null, fallbackUnit: string): UnitPrice {
  const key = model?.trim() || "";
  const override = parseOverrides()[key];
  if (override && typeof override === "object" && !Array.isArray(override)) {
    const perUnit = positiveNumber(
      (override as Record<string, unknown>).perUnit,
    );
    if (perUnit !== null) return { perUnit, unit: fallbackUnit };
  }
  return DEFAULT_UNIT_PRICES[key] ?? { perUnit: 0, unit: fallbackUnit };
}

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

/** Reads `{quantity, unit}` usage as emitted by the OpenAI responses adapter. */
export function readTokenUsage(
  usage: readonly { readonly quantity: number; readonly unit: string }[],
): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const entry of usage) {
    const quantity = positiveNumber(entry.quantity) ?? 0;
    if (entry.unit === "input_tokens") inputTokens = quantity;
    else if (entry.unit === "output_tokens") outputTokens = quantity;
    else if (entry.unit === "total_tokens") totalTokens = quantity;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
  };
}

export function estimateTextCostMicro(
  model: string | null,
  usage: TokenUsage,
): number {
  const price = textPrice(model);
  const micro =
    (usage.inputTokens * price.inputPerMillionTokens) / 1_000_000 +
    (usage.outputTokens * price.outputPerMillionTokens) / 1_000_000;
  return Math.max(0, Math.round(micro));
}

export function estimateUnitCostMicro(
  model: string | null,
  quantity: number,
  fallbackUnit: string,
): { readonly costMicro: number; readonly unit: string } {
  const price = unitPrice(model, fallbackUnit);
  const safeQuantity = Math.max(0, positiveNumber(quantity) ?? 0);
  return {
    costMicro: Math.max(0, Math.round(safeQuantity * price.perUnit)),
    unit: price.unit,
  };
}

// ---------------------------------------------------------------------------
// Durable budget and rate enforcement
// ---------------------------------------------------------------------------

export type ReservationDecision = {
  readonly allowed: boolean;
  /** `allowed`, a named refusal, or `metering_unavailable`. */
  readonly code: string;
  readonly retryAfterSeconds: number;
  readonly scope: string;
  readonly enforcement: string | null;
  /** True when the SQL check could not run and the call proceeded uncapped. */
  readonly degraded: boolean;
};

const REFUSAL_MESSAGES: Record<string, string> = {
  daily_budget_exceeded:
    "This workspace has reached its daily assistant budget. It resets at midnight UTC, or an administrator can raise it.",
  monthly_budget_exceeded:
    "This workspace has reached its monthly assistant budget. An administrator can raise it.",
  tenant_daily_call_limit:
    "This workspace has reached its daily assistant request limit.",
  tenant_rate_limited:
    "This workspace is sending requests faster than its limit allows. Wait a moment and try again.",
  subject_rate_limited:
    "Too many requests in a row. Wait a moment and try again.",
  tenant_suspended: "This workspace is suspended.",
};

export function reservationMessage(code: string) {
  return (
    REFUSAL_MESSAGES[code] ??
    "This request was refused by the workspace's spend policy."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberField(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Asks the database whether this tenant may spend right now.
 *
 * Fail-open is deliberate and narrow: if the RPC itself is unreachable — most
 * commonly because migration `20260726096000` has not been applied yet — the
 * call proceeds and the result is marked `degraded` so the condition is
 * visible in logs. A *decision* to refuse is always honoured. Failing closed on
 * an unapplied migration would take chat down for every tenant at once, which
 * is the larger of the two harms.
 */
export async function reserveProviderCall(
  supabase: SupabaseClient,
  input: {
    readonly capability: ProviderCapability;
    readonly subjectKey: string;
    /** Only for the trusted server path serving anonymous widget traffic. */
    readonly tenantId?: string | null;
    readonly operationToken?: string | null;
  },
): Promise<ReservationDecision> {
  const degraded: ReservationDecision = {
    allowed: true,
    code: "metering_unavailable",
    retryAfterSeconds: 0,
    scope: "unenforced",
    enforcement: null,
    degraded: true,
  };
  try {
    const { data, error } = await supabase.rpc(
      "learning_reserve_provider_call",
      {
        requested_capability: input.capability,
        subject_key: input.subjectKey,
        target_tenant_id: input.tenantId ?? null,
        operation_token: input.operationToken ?? null,
      },
    );
    if (error || !isRecord(data)) {
      console.warn(
        "cost.reservation.unavailable",
        JSON.stringify({
          capability: input.capability,
          code: error?.code ?? "malformed_response",
        }),
      );
      return degraded;
    }
    if (data.ok !== true) {
      // A structural refusal (no tenant selected, no operation token) is a real
      // decision, not an outage.
      return {
        allowed: false,
        code: typeof data.code === "string" ? data.code : "request_denied",
        retryAfterSeconds: 0,
        scope: "durable-tenant",
        enforcement: null,
        degraded: false,
      };
    }
    return {
      allowed: data.allowed === true,
      code: typeof data.code === "string" ? data.code : "allowed",
      retryAfterSeconds: Math.max(
        0,
        Math.trunc(numberField(data.retryAfterSeconds, 0)),
      ),
      scope: typeof data.scope === "string" ? data.scope : "durable-tenant",
      enforcement:
        typeof data.enforcement === "string" ? data.enforcement : null,
      degraded: false,
    };
  } catch (error) {
    console.warn(
      "cost.reservation.threw",
      JSON.stringify({
        capability: input.capability,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return degraded;
  }
}

export type ProviderCostRecord = {
  readonly capability: ProviderCapability;
  readonly providerKey: string;
  readonly modelKey: string | null;
  readonly quantity: number;
  readonly unit: string;
  readonly costMicro: number;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly conversationId?: string | null;
  /** Bounded, non-content metadata only: token counts, latency, status. */
  readonly metadata?: Record<string, number | string | boolean> | null;
  /** Only for the trusted server path serving anonymous widget traffic. */
  readonly tenantId?: string | null;
  readonly operationToken?: string | null;
};

/**
 * Writes one ledger row. Never throws and never rejects: the caller has already
 * produced an answer, and a metering failure must not take that answer away.
 */
export async function recordProviderCost(
  supabase: SupabaseClient,
  record: ProviderCostRecord,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc(
      "learning_record_provider_cost",
      {
        requested_capability: record.capability,
        provider_key: record.providerKey.slice(0, 100),
        model_key: record.modelKey?.slice(0, 100) ?? null,
        quantity: Math.max(0, record.quantity),
        unit: record.unit,
        estimated_cost_micro: Math.max(0, Math.round(record.costMicro)),
        trace_id: record.traceId,
        idempotency_key: record.idempotencyKey.slice(0, 200),
        request_id: record.requestId ?? null,
        target_conversation_id: record.conversationId ?? null,
        provider_metadata_safe: record.metadata ?? {},
        target_tenant_id: record.tenantId ?? null,
        operation_token: record.operationToken ?? null,
      },
    );
    if (error || !isRecord(data) || data.ok !== true) {
      console.warn(
        "cost.ledger.write_failed",
        JSON.stringify({
          capability: record.capability,
          code:
            error?.code ??
            (isRecord(data) && typeof data.code === "string"
              ? data.code
              : "malformed_response"),
        }),
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      "cost.ledger.threw",
      JSON.stringify({
        capability: record.capability,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return false;
  }
}
