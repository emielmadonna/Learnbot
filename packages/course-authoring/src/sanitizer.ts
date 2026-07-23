import type { ContentBlock, RichTextSpan } from "@course-ai/contracts";
import { AuthoringError, requireAuthoring } from "./errors.js";

export interface UrlPolicy {
  readonly allowedLinkProtocols: readonly string[];
  readonly allowedEmbedHosts?: readonly string[];
  readonly allowSubdomains?: boolean;
}

export const DEFAULT_URL_POLICY: UrlPolicy = {
  allowedLinkProtocols: ["https:", "mailto:"],
  allowSubdomains: true,
};

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const DANGEROUS_HTML =
  /<(?:script|style|iframe|object|embed|link|meta|svg|math)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed|link|meta|svg|math)>|<(?:script|style|iframe|object|embed|link|meta|svg|math)\b[^>]*\/?>/giu;
const HTML_TAG = /<\/?[a-z][^>]*>/giu;
const SAFE_BLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((item) =>
        isJsonValue(item, seen),
      );
  seen.delete(value);
  return valid;
}

export function sanitizeText(input: string, field = "text"): string {
  requireAuthoring(
    typeof input === "string",
    "authoring.invalid_input",
    `${field} must be text.`,
  );
  return input
    .replace(DANGEROUS_HTML, "")
    .replace(HTML_TAG, "")
    .replace(CONTROL_CHARACTERS, "")
    .normalize("NFC");
}

export function sanitizeHtmlToPlainText(input: string): string {
  return input
    .replace(DANGEROUS_HTML, "")
    .replace(/<(?:br|hr)\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|pre)>/giu, "\n")
    .replace(HTML_TAG, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(CONTROL_CHARACTERS, "")
    .normalize("NFC")
    .trim();
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/u.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function matchesHostPolicy(hostname: string, policy: UrlPolicy): boolean {
  if (!policy.allowedEmbedHosts) return true;
  return policy.allowedEmbedHosts.some((allowed) => {
    const normalized = allowed.toLowerCase();
    return (
      hostname === normalized ||
      (policy.allowSubdomains === true && hostname.endsWith(`.${normalized}`))
    );
  });
}

export function sanitizeLinkUrl(input: string, policy: UrlPolicy = DEFAULT_URL_POLICY): string {
  const candidate = input.trim();
  if (candidate.startsWith("#")) {
    requireAuthoring(
      /^#[A-Za-z][A-Za-z0-9_:.-]*$/u.test(candidate),
      "authoring.invalid_input",
      "The fragment link is malformed.",
    );
    return candidate;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AuthoringError("authoring.invalid_input", "The link URL is malformed.");
  }
  requireAuthoring(
    policy.allowedLinkProtocols.includes(parsed.protocol),
    "authoring.invalid_input",
    `Link protocol ${parsed.protocol} is not allowed.`,
  );
  requireAuthoring(
    parsed.username.length === 0 && parsed.password.length === 0,
    "authoring.invalid_input",
    "URLs containing credentials are not allowed.",
  );
  if (parsed.protocol === "https:") {
    requireAuthoring(
      !isPrivateHost(parsed.hostname),
      "authoring.invalid_input",
      "Links to private network hosts are not allowed.",
    );
  }
  return parsed.toString();
}

export function sanitizeEmbedUrl(input: string, policy: UrlPolicy = DEFAULT_URL_POLICY): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new AuthoringError("authoring.invalid_input", "The embed URL is malformed.");
  }
  requireAuthoring(
    parsed.protocol === "https:",
    "authoring.invalid_input",
    "Embeds must use HTTPS.",
  );
  requireAuthoring(
    parsed.username.length === 0 && parsed.password.length === 0,
    "authoring.invalid_input",
    "Embed URLs containing credentials are not allowed.",
  );
  requireAuthoring(
    !isPrivateHost(parsed.hostname),
    "authoring.invalid_input",
    "Embeds from private network hosts are not allowed.",
  );
  requireAuthoring(
    matchesHostPolicy(parsed.hostname.toLowerCase(), policy),
    "authoring.invalid_input",
    "The embed host is not approved.",
  );
  return parsed.toString();
}

function sanitizeSpans(
  spans: readonly RichTextSpan[],
  policy: UrlPolicy,
): readonly RichTextSpan[] {
  requireAuthoring(
    Array.isArray(spans),
    "authoring.invalid_input",
    "Rich-text content must be an array.",
  );
  const allowedMarks = new Set(["bold", "italic", "underline", "strike", "code"]);
  return spans.map((span) => {
    requireAuthoring(
      typeof span === "object" && span !== null && typeof span.text === "string",
      "authoring.invalid_input",
      "Rich-text spans must contain text.",
    );
    requireAuthoring(
      span.href === undefined || typeof span.href === "string",
      "authoring.invalid_input",
      "Rich-text link must be a URL string.",
    );
    requireAuthoring(
      span.marks === undefined ||
        (Array.isArray(span.marks) &&
          span.marks.every(
            (mark: unknown) => typeof mark === "string" && allowedMarks.has(mark),
          )),
      "authoring.invalid_input",
      "Rich-text span contains an unsupported mark.",
    );
    const href = span.href === undefined ? undefined : sanitizeLinkUrl(span.href, policy);
    return {
      text: sanitizeText(span.text),
      ...(span.marks === undefined ? {} : { marks: [...span.marks] }),
      ...(href === undefined ? {} : { href }),
    };
  });
}

export function sanitizeBlock(block: ContentBlock, policy: UrlPolicy): ContentBlock {
  requireAuthoring(
    typeof block === "object" &&
      block !== null &&
      typeof block.id === "string" &&
      SAFE_BLOCK_ID.test(block.id) &&
      typeof block.type === "string",
    "authoring.invalid_input",
    "Every content block requires an id and recognized type.",
  );
  requireAuthoring(
    block.metadata === undefined ||
      (typeof block.metadata === "object" &&
        block.metadata !== null &&
        !Array.isArray(block.metadata) &&
        isJsonValue(block.metadata)),
    "authoring.invalid_input",
    "Block metadata must be a JSON object.",
  );

  switch (block.type) {
    case "paragraph":
      return { ...block, content: sanitizeSpans(block.content, policy) };
    case "heading":
      requireAuthoring(
        Number.isInteger(block.level) && block.level >= 1 && block.level <= 4,
        "authoring.invalid_input",
        "Heading level must be between 1 and 4.",
      );
      return { ...block, content: sanitizeSpans(block.content, policy) };
    case "list":
      requireAuthoring(
        ["bullet", "numbered", "checklist"].includes(block.style) &&
          Array.isArray(block.items),
        "authoring.invalid_input",
        "List requires a valid style and items array.",
      );
      requireAuthoring(
        block.items.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            typeof item.id === "string" &&
            item.id.trim().length > 0 &&
            Array.isArray(item.content) &&
            (item.checked === undefined || typeof item.checked === "boolean"),
        ),
        "authoring.invalid_input",
        "List items have an invalid schema.",
      );
      requireAuthoring(
        new Set(block.items.map((item) => item.id)).size === block.items.length,
        "authoring.invalid_input",
        "List item ids must be unique.",
      );
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          id: sanitizeText(item.id, "list item id"),
          content: sanitizeSpans(item.content, policy),
        })),
      };
    case "quote":
      requireAuthoring(
        block.attribution === undefined || typeof block.attribution === "string",
        "authoring.invalid_input",
        "Quote attribution must be text.",
      );
      return {
        ...block,
        content: sanitizeSpans(block.content, policy),
        ...(block.attribution === undefined
          ? {}
          : { attribution: sanitizeText(block.attribution) }),
      };
    case "callout":
      requireAuthoring(
        ["info", "tip", "warning", "example"].includes(block.tone) &&
          (block.title === undefined || typeof block.title === "string"),
        "authoring.invalid_input",
        "Callout tone or title is invalid.",
      );
      return {
        ...block,
        content: sanitizeSpans(block.content, policy),
        ...(block.title === undefined ? {} : { title: sanitizeText(block.title) }),
      };
    case "code":
      requireAuthoring(
        typeof block.code === "string" &&
          (block.language === undefined || typeof block.language === "string") &&
          (block.caption === undefined || typeof block.caption === "string"),
        "authoring.invalid_input",
        "Code block schema is invalid.",
      );
      return {
        ...block,
        code: block.code.replace(CONTROL_CHARACTERS, "").normalize("NFC"),
        ...(block.language === undefined ? {} : { language: sanitizeText(block.language) }),
        ...(block.caption === undefined ? {} : { caption: sanitizeText(block.caption) }),
      };
    case "table":
      requireAuthoring(
        Array.isArray(block.columns) &&
          block.columns.every((value) => typeof value === "string") &&
          Array.isArray(block.rows) &&
          block.rows.every(
            (row) =>
              Array.isArray(row) && row.every((value) => typeof value === "string"),
          ) &&
          (block.caption === undefined || typeof block.caption === "string"),
        "authoring.invalid_input",
        "Table schema is invalid.",
      );
      return {
        ...block,
        columns: block.columns.map((value) => sanitizeText(value)),
        rows: block.rows.map((row) => row.map((value) => sanitizeText(value))),
        ...(block.caption === undefined ? {} : { caption: sanitizeText(block.caption) }),
      };
    case "image":
      requireAuthoring(
        typeof block.assetId === "string" &&
          block.assetId.trim().length > 0 &&
          typeof block.altText === "string" &&
          (block.caption === undefined || typeof block.caption === "string"),
        "authoring.invalid_input",
        "Image schema is invalid.",
      );
      return {
        ...block,
        altText: sanitizeText(block.altText),
        ...(block.caption === undefined ? {} : { caption: sanitizeText(block.caption) }),
      };
    case "diagram":
      requireAuthoring(
        typeof block.assetId === "string" &&
          block.assetId.trim().length > 0 &&
          typeof block.altText === "string" &&
          typeof block.caption === "string" &&
          (block.layout === undefined ||
            ["full", "wide", "inline"].includes(block.layout)),
        "authoring.invalid_input",
        "Diagram schema is invalid.",
      );
      return {
        ...block,
        altText: sanitizeText(block.altText),
        caption: sanitizeText(block.caption),
      };
    case "media":
      requireAuthoring(
        typeof block.assetId === "string" &&
          block.assetId.trim().length > 0 &&
          (block.mediaKind === "audio" || block.mediaKind === "video") &&
          (block.title === undefined || typeof block.title === "string") &&
          (block.transcriptDocumentId === undefined ||
            typeof block.transcriptDocumentId === "string"),
        "authoring.invalid_input",
        "Media schema is invalid.",
      );
      return {
        ...block,
        ...(block.title === undefined ? {} : { title: sanitizeText(block.title) }),
      };
    case "embed":
      requireAuthoring(
        typeof block.provider === "string" &&
          typeof block.url === "string" &&
          (block.title === undefined || typeof block.title === "string"),
        "authoring.invalid_input",
        "Embed schema is invalid.",
      );
      return {
        ...block,
        provider: sanitizeText(block.provider),
        url: sanitizeEmbedUrl(block.url, policy),
        ...(block.title === undefined ? {} : { title: sanitizeText(block.title) }),
      };
    case "divider":
      return { ...block };
    default: {
      const exhaustive: never = block;
      throw new AuthoringError(
        "authoring.invalid_input",
        `Unsupported content block: ${String(exhaustive)}`,
      );
    }
  }
}
