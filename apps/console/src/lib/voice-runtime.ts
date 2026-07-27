import type { SupabaseClient } from "@supabase/supabase-js";
import {
  estimateUnitCostMicro,
  recordProviderCost,
  reservationMessage,
  reserveProviderCall,
  type ProviderCapability,
} from "./cost-metering";
import { consumeVoiceQuota, type VoiceQuotaKind } from "../app/api/learning/voice/rate-limit";

/**
 * Voice runtime: the tenant's configured voice, a durable quota, and metering.
 *
 * Two defects lived here.
 *
 *   * **The configured voice was ignored.** `tenant_branding.agent_voice` has
 *     been editable and displayed since migration 20260725120000 and was read
 *     by nothing; all three voice routes hardcoded `"marin"`. A white-label
 *     client chose a voice and heard a different one.
 *
 *   * **The rate limit was a process-local `Map`.** On a serverless platform
 *     that map is empty on every cold start and shared by nobody, so the limit
 *     bounded nothing. The authoritative quota is now a SQL reservation reading
 *     durable counters; the in-process map is retained only as a same-instance
 *     burst guard and as the fallback when the durable check cannot run.
 */

export const DEFAULT_VOICE = "marin";

/**
 * Voices the provider accepts. A tenant may store any slug that satisfies the
 * branding CHECK constraint, so an unrecognised value falls back rather than
 * failing the turn with a provider 400 the learner cannot act on.
 */
export const SUPPORTED_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export type VoiceResolution = {
  readonly voice: string;
  readonly source: "tenant" | "default" | "unsupported";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads the tenant's published voice. Any failure — an unapplied migration, an
 * unpublished branding row, an unknown slug — falls back to the default voice,
 * because losing voice entirely is worse than using the default one.
 */
export async function resolveTenantVoice(
  supabase: SupabaseClient,
): Promise<VoiceResolution> {
  try {
    const { data, error } = await supabase.rpc("tenant_get_voice_profile");
    if (error || !isRecord(data) || data.ok !== true) {
      return { voice: DEFAULT_VOICE, source: "default" };
    }
    const configured =
      typeof data.voice === "string" ? data.voice.trim().toLowerCase() : "";
    if (!configured) return { voice: DEFAULT_VOICE, source: "default" };
    if (!(SUPPORTED_VOICES as readonly string[]).includes(configured)) {
      console.warn(
        "voice.configured_voice_unsupported",
        JSON.stringify({ voice: configured.slice(0, 40) }),
      );
      return { voice: DEFAULT_VOICE, source: "unsupported" };
    }
    return { voice: configured, source: "tenant" };
  } catch {
    return { voice: DEFAULT_VOICE, source: "default" };
  }
}

// ---------------------------------------------------------------------------
// Durable quota
// ---------------------------------------------------------------------------

const VOICE_CAPABILITIES: Record<VoiceQuotaKind, ProviderCapability> = {
  transcribe: "voice.transcribe",
  speak: "voice.speak",
  realtime: "voice.realtime",
};

export type VoiceQuotaDecision = {
  readonly allowed: boolean;
  readonly code: string;
  readonly message: string;
  readonly retryAfterSeconds: number;
  /** `durable-tenant` when SQL decided; `process-instance` when it could not. */
  readonly scope: string;
};

/**
 * Authoritative voice quota. The SQL reservation decides; the process-local map
 * is consulted first purely to shed an obvious same-instance burst without a
 * round trip, and is the only remaining limit if the reservation is unavailable.
 */
export async function enforceVoiceQuota(
  supabase: SupabaseClient,
  input: {
    readonly kind: VoiceQuotaKind;
    readonly tenantId: string;
    readonly principalId: string;
  },
): Promise<VoiceQuotaDecision> {
  const subjectKey = `${input.tenantId}:${input.principalId}`;
  const local = consumeVoiceQuota(input.kind, subjectKey);
  if (!local.allowed) {
    return {
      allowed: false,
      code: "voice_rate_limited",
      message: reservationMessage("subject_rate_limited"),
      retryAfterSeconds: local.retryAfterSeconds,
      scope: local.scope,
    };
  }

  const decision = await reserveProviderCall(supabase, {
    capability: VOICE_CAPABILITIES[input.kind],
    subjectKey,
  });
  if (decision.allowed) {
    return {
      allowed: true,
      code: decision.code,
      message: "",
      retryAfterSeconds: 0,
      scope: decision.degraded ? local.scope : decision.scope,
    };
  }
  return {
    allowed: false,
    code:
      decision.code === "daily_budget_exceeded" ||
      decision.code === "monthly_budget_exceeded"
        ? "voice_budget_exceeded"
        : "voice_rate_limited",
    message: reservationMessage(decision.code),
    retryAfterSeconds: decision.retryAfterSeconds,
    scope: decision.scope,
  };
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/**
 * Records what one voice interaction cost. Best effort by contract: the learner
 * already has their transcript or audio, and a ledger fault must not take it
 * away.
 */
export async function meterVoiceUsage(
  supabase: SupabaseClient,
  input: {
    readonly kind: VoiceQuotaKind;
    readonly model: string;
    /** Seconds of audio, characters of speech, or 1 realtime session. */
    readonly quantity: number;
    readonly fallbackUnit: string;
    readonly traceId: string;
    readonly idempotencyKey: string;
    readonly conversationId?: string | null;
  },
) {
  const { costMicro, unit } = estimateUnitCostMicro(
    input.model,
    input.quantity,
    input.fallbackUnit,
  );
  await recordProviderCost(supabase, {
    capability: VOICE_CAPABILITIES[input.kind],
    providerKey: "openai:voice",
    modelKey: input.model,
    quantity: input.quantity,
    unit,
    costMicro,
    traceId: input.traceId,
    idempotencyKey: input.idempotencyKey,
    conversationId: input.conversationId ?? null,
    metadata: { kind: input.kind },
  });
}

export function voiceTraceId(kind: VoiceQuotaKind) {
  return `voice-${kind}:${crypto.randomUUID()}`;
}
