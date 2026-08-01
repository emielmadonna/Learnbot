export type CourseMediaBlockType = "image" | "video" | "link";

export type NormalizedVideoSource = {
  readonly provider: "youtube" | "vimeo" | "file";
  readonly url: string;
};

const MAX_URL_LENGTH = 2_048;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const VIMEO_ID = /^[0-9]{6,12}$/u;
const DISALLOWED_HOST_SUFFIXES = [
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".test",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= minimum && text.length <= maximum ? text : null;
}

function publicIpv4(hostname: string) {
  if (!/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(hostname)) return null;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a = 0, b = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/**
 * URLs stored in authored blocks are loaded by learner browsers. Restricting
 * them to public HTTPS origins prevents a malicious author from turning a
 * lesson into a request to localhost, a private network, or a credentialed
 * origin when another tenant member opens it.
 */
export function normalizePublicHttpsUrl(value: unknown): URL | null {
  const raw = boundedText(value, 8, MAX_URL_LENGTH);
  if (
    raw === null ||
    /[\u0000-\u0020\u007f]/u.test(raw) ||
    /%(?:00|0a|0d)/iu.test(raw)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.port.length > 0 && parsed.port !== "443")
  ) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const ipv4 = publicIpv4(hostname);
  if (
    hostname.length === 0 ||
    hostname.includes(":") ||
    hostname === "localhost" ||
    hostname.startsWith("localhost.") ||
    DISALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (ipv4 === false) ||
    (ipv4 === null && !hostname.includes("."))
  ) {
    return null;
  }

  parsed.hostname = hostname;
  if (parsed.port === "443") parsed.port = "";
  return parsed;
}

export function normalizeImageUrl(value: unknown): string | null {
  const parsed = normalizePublicHttpsUrl(value);
  if (parsed === null) return null;
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeLinkUrl(value: unknown): string | null {
  return normalizePublicHttpsUrl(value)?.toString() ?? null;
}

export function normalizeVideoSource(
  value: unknown,
): NormalizedVideoSource | null {
  const parsed = normalizePublicHttpsUrl(value);
  if (parsed === null) return null;
  const hostname = parsed.hostname;
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "youtu.be" ||
    hostname === "www.youtube-nocookie.com"
  ) {
    const candidate =
      hostname === "youtu.be"
        ? parts[0]
        : parts[0] === "embed"
          ? parts[1]
          : parsed.searchParams.get("v");
    if (candidate === undefined || candidate === null || !VIDEO_ID.test(candidate)) {
      return null;
    }
    return {
      provider: "youtube",
      url: `https://www.youtube-nocookie.com/embed/${candidate}`,
    };
  }

  if (
    hostname === "vimeo.com" ||
    hostname === "www.vimeo.com" ||
    hostname === "player.vimeo.com"
  ) {
    const candidate =
      parts[0] === "video" ? parts[1] : parts.find((part) => VIMEO_ID.test(part));
    if (candidate === undefined || !VIMEO_ID.test(candidate)) return null;
    return {
      provider: "vimeo",
      url: `https://player.vimeo.com/video/${candidate}`,
    };
  }

  const pathname = parsed.pathname.toLowerCase();
  if (!/\.(?:mp4|ogg|webm)$/u.test(pathname)) return null;
  parsed.hash = "";
  return { provider: "file", url: parsed.toString() };
}

/**
 * Converts untrusted block JSON into the only three media shapes the database
 * accepts. Unknown keys are intentionally discarded before persistence.
 */
export function normalizeCourseMediaContent(
  type: CourseMediaBlockType,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;

  if (type === "image") {
    const url = normalizeImageUrl(value.url);
    const altText = boundedText(value.altText, 3, 500);
    const caption = boundedText(value.caption, 0, 1_000);
    return url === null || altText === null || caption === null
      ? null
      : { url, altText, caption };
  }

  if (type === "video") {
    const source = normalizeVideoSource(value.url);
    const title = boundedText(value.title, 1, 160);
    const caption = boundedText(value.caption, 0, 1_000);
    return source === null || title === null || caption === null
      ? null
      : {
          url: source.url,
          provider: source.provider,
          title,
          caption,
        };
  }

  const url = normalizeLinkUrl(value.url);
  const label = boundedText(value.label, 1, 160);
  const description = boundedText(value.description, 0, 1_000);
  return url === null || label === null || description === null
    ? null
    : { url, label, description };
}
