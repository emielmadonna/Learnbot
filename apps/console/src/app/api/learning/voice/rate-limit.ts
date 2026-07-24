export type VoiceQuotaKind = "transcribe" | "speak" | "realtime";

type QuotaEntry = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = 60_000;
const MAX_ENTRIES = 5_000;
const limits: Record<VoiceQuotaKind, number> = {
  transcribe: 8,
  speak: 12,
  realtime: 4,
};

const rateLimitRuntime = globalThis as typeof globalThis & {
  __learningBotVoiceProcessQuota?: Map<string, QuotaEntry>;
};

function quotaStore() {
  rateLimitRuntime.__learningBotVoiceProcessQuota ??= new Map();
  return rateLimitRuntime.__learningBotVoiceProcessQuota;
}

function prune(store: Map<string, QuotaEntry>, now: number) {
  for (const [key, value] of store) {
    if (value.resetAt <= now) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (!oldest) break;
    store.delete(oldest);
  }
}

/**
 * This is a bounded process-instance safety net, not a durable distributed
 * quota. Multi-instance production still needs the platform's durable meter.
 */
export function consumeVoiceQuota(
  kind: VoiceQuotaKind,
  subject: string,
  now = Date.now(),
) {
  const store = quotaStore();
  prune(store, now);
  const key = `${kind}:${subject}`;
  const limit = limits[kind];
  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return {
      allowed: true,
      limit,
      remaining: limit - 1,
      retryAfterSeconds: 0,
      scope: "process-instance" as const,
    };
  }
  if (current.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.resetAt - now) / 1_000),
      ),
      scope: "process-instance" as const,
    };
  }
  current.count += 1;
  return {
    allowed: true,
    limit,
    remaining: limit - current.count,
    retryAfterSeconds: 0,
    scope: "process-instance" as const,
  };
}

export function resetVoiceQuotaForTests() {
  rateLimitRuntime.__learningBotVoiceProcessQuota?.clear();
}
