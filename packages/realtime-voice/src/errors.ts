import type { JsonObject, JsonValue } from "@course-ai/contracts";
import type {
  NormalizedVoiceError,
  VoiceAdapterError,
  VoiceAdapterErrorCode,
} from "./types.js";

const SAFE_MESSAGES: Readonly<Record<VoiceAdapterErrorCode, string>> = {
  aborted: "The realtime voice operation was cancelled.",
  deadline_exceeded: "The realtime voice session deadline was exceeded.",
  invalid_request: "The realtime voice request was invalid.",
  authentication_failed: "The realtime voice provider could not authenticate.",
  permission_denied: "The realtime voice operation was not permitted.",
  capability_unavailable: "Realtime voice is unavailable.",
  feature_unsupported: "The requested realtime voice feature is unsupported.",
  rate_limited: "Realtime voice is temporarily rate limited.",
  budget_exceeded: "The realtime voice budget was exceeded.",
  provider_unavailable: "The realtime voice provider is unavailable.",
  provider_error: "The realtime voice provider operation failed.",
  response_invalid: "The realtime voice provider returned an invalid response.",
  connection_lost: "The realtime voice connection was lost.",
  session_expired: "The realtime voice session expired.",
  session_mismatch: "The realtime voice session scope did not match.",
  protocol_error: "The realtime voice protocol returned an invalid event.",
};

const SENSITIVE_KEY = /authorization|credential|secret|token|api.?key|password|cookie/iu;

function sanitizeValue(
  value: JsonValue,
  sensitiveValues: readonly string[],
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (
      sensitiveValues.some(
        (sensitive) => sensitive.length > 0 && value.includes(sensitive),
      )
    ) {
      return undefined;
    }
    return value.length <= 256 ? value : value.slice(0, 256);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeValue(item, sensitiveValues))
      .filter((item): item is JsonValue => item !== undefined);
  }
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (SENSITIVE_KEY.test(key)) continue;
    const safe = sanitizeValue(item, sensitiveValues);
    if (safe !== undefined) sanitized[key] = safe;
  }
  return sanitized;
}

export function sanitizeDetails(
  details: JsonObject | undefined,
  sensitiveValues: readonly string[] = [],
): JsonObject | undefined {
  if (details === undefined) return undefined;
  return sanitizeValue(details, sensitiveValues) as JsonObject;
}

export function normalizeVoiceError(
  error: unknown,
  adapterId?: string,
  sensitiveValues: readonly string[] = [],
): NormalizedVoiceError {
  const adapterError = isVoiceAdapterError(error)
    ? error
    : {
        code: "provider_error" as const,
        retryable: false,
      };
  const fallback =
    adapterError.code === "deadline_exceeded" ||
    adapterError.code === "session_expired" ||
    adapterError.code === "capability_unavailable"
      ? "text"
      : adapterError.retryable
        ? "retry"
        : "none";
  const safeDetails = sanitizeDetails(adapterError.safeDetails, sensitiveValues);
  return {
    code: adapterError.code,
    message: SAFE_MESSAGES[adapterError.code],
    retryable: adapterError.retryable,
    fallback,
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(adapterError.providerStatus === undefined
      ? {}
      : { providerStatus: adapterError.providerStatus }),
    ...(safeDetails === undefined ? {} : { safeDetails }),
  };
}

export function mismatchError(): NormalizedVoiceError {
  return normalizeVoiceError({
    code: "session_mismatch",
    retryable: false,
  });
}

function isVoiceAdapterError(value: unknown): value is VoiceAdapterError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VoiceAdapterError>;
  return (
    typeof candidate.code === "string" &&
    candidate.code in SAFE_MESSAGES &&
    typeof candidate.retryable === "boolean"
  );
}
