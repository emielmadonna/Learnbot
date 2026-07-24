export const MAX_VOICE_TURN_MS = 45_000;
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 256 * 1024;

const audioTypes = new Map([
  ["audio/webm", { extension: "webm", providerType: "audio/webm" }],
  ["video/webm", { extension: "webm", providerType: "audio/webm" }],
  ["audio/mp4", { extension: "m4a", providerType: "audio/mp4" }],
  ["video/mp4", { extension: "mp4", providerType: "video/mp4" }],
  ["audio/m4a", { extension: "m4a", providerType: "audio/mp4" }],
  ["audio/x-m4a", { extension: "m4a", providerType: "audio/mp4" }],
  ["audio/aac", { extension: "aac", providerType: "audio/aac" }],
]);

export function normalizedAudioType(value: string) {
  return value.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function acceptedAudioType(value: string) {
  return audioTypes.get(normalizedAudioType(value)) ?? null;
}

export function acceptedBrowserAudioTypes() {
  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/aac",
  ] as const;
}

export function validDeclaredDuration(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !/^\d{2,5}$/u.test(value)) return null;
  const durationMs = Number(value);
  return durationMs >= 100 && durationMs <= MAX_VOICE_TURN_MS
    ? durationMs
    : null;
}

export function multipartHeaderError(headers: Headers) {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType.startsWith("multipart/form-data;") ||
    !contentType.includes("boundary=")
  ) {
    return "invalid_content_type" as const;
  }
  const rawLength = headers.get("content-length");
  if (!rawLength || !/^\d+$/u.test(rawLength)) {
    return "length_required" as const;
  }
  const contentLength = Number(rawLength);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_MULTIPART_BYTES
  ) {
    return "audio_too_large" as const;
  }
  return null;
}
