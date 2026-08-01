import { createHash } from "node:crypto";

const CIRCLE_BASE_URL = "https://app.circle.so";
const MAX_PAGES = 40;
const MAX_RECORDS = 500;
const MAX_RESPONSE_BYTES = 4_000_000;

export class CircleSourceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CircleSourceError";
  }
}

export type CircleCourseChoice = {
  id: string;
  name: string;
  slug: string;
  url: string;
};

export type CircleLearningDocument = {
  externalId: string;
  title: string;
  body: string;
  language: "und";
  mediaType: "text/plain";
  metadata: {
    provider: "circle";
    spaceId: string;
    sectionId: string | null;
    sectionName: string | null;
    lessonUrl: string;
    updatedAt: string | null;
  };
};

type FetchLike = typeof fetch;

function providerCode(status: number) {
  if (status === 401) return "circle_credential_invalid";
  if (status === 403) return "circle_plan_or_permission_required";
  if (status === 429) return "circle_rate_limited";
  return status >= 500 ? "circle_provider_unavailable" : "circle_request_failed";
}

async function circleJson(
  token: string,
  path: string,
  query: Record<string, string | number>,
  fetcher: FetchLike,
) {
  const url = new URL(path, CIRCLE_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: `Token ${token}`,
      Accept: "application/json",
      "User-Agent": "LearningBot source importer/1.0",
    },
  });
  if (!response.ok) throw new CircleSourceError(providerCode(response.status));
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new CircleSourceError("circle_response_too_large");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new CircleSourceError("circle_response_too_large");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CircleSourceError("circle_invalid_response");
  }
}

function recordsFrom(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.records)) {
    return object.records as Array<Record<string, unknown>>;
  }
  if (object.data && typeof object.data === "object") {
    const data = object.data as Record<string, unknown>;
    if (Array.isArray(data.records)) {
      return data.records as Array<Record<string, unknown>>;
    }
  }
  return [];
}

async function paginated(
  token: string,
  path: string,
  query: Record<string, string | number>,
  fetcher: FetchLike,
) {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const next = recordsFrom(
      await circleJson(token, path, { ...query, page, per_page: 50 }, fetcher),
    );
    rows.push(...next);
    if (rows.length > MAX_RECORDS) {
      throw new CircleSourceError("circle_course_too_large");
    }
    if (next.length < 50) return rows;
  }
  throw new CircleSourceError("circle_course_too_large");
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/gu, (_, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    )
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'");
}

export function circleHtmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
      .replace(/<(br|hr)\s*\/?>/giu, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|section)>/giu, "\n")
      .replace(/<li\b[^>]*>/giu, "• ")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export async function listCircleCourses(
  token: string,
  fetcher: FetchLike = fetch,
): Promise<CircleCourseChoice[]> {
  const spaces = await paginated(token, "/api/admin/v2/spaces", {}, fetcher);
  return spaces
    .filter(
      (space) =>
        text(space.space_type).toLowerCase() === "course" ||
        (space.course_setting !== null &&
          typeof space.course_setting === "object"),
    )
    .map((space) => ({
      id: String(space.id ?? ""),
      name: text(space.name) || "Untitled Circle course",
      slug: text(space.slug),
      url: text(space.url),
    }))
    .filter((space) => space.id.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readCircleCourse(
  token: string,
  courseId: string,
  fetcher: FetchLike = fetch,
) {
  if (!/^[0-9A-Za-z_-]{1,100}$/u.test(courseId)) {
    throw new CircleSourceError("invalid_circle_course");
  }
  const courses = await listCircleCourses(token, fetcher);
  const course = courses.find((choice) => choice.id === courseId);
  if (!course) throw new CircleSourceError("circle_course_not_found");

  const [sections, lessons] = await Promise.all([
    paginated(
      token,
      "/api/admin/v2/course_sections",
      { space_id: courseId },
      fetcher,
    ),
    paginated(
      token,
      "/api/admin/v2/course_lessons",
      { space_id: courseId, status: "published" },
      fetcher,
    ),
  ]);
  const sectionNames = new Map(
    sections.map((section) => [
      String(section.id ?? ""),
      text(section.name) || null,
    ]),
  );
  const documents: CircleLearningDocument[] = [];
  for (const lesson of lessons) {
    if (text(lesson.status).toLowerCase() !== "published") continue;
    const body = circleHtmlToText(text(lesson.body_html));
    const externalId = String(lesson.id ?? "");
    if (!externalId || !body) continue;
    const sectionId = lesson.section_id ? String(lesson.section_id) : null;
    const sectionName = sectionId ? sectionNames.get(sectionId) ?? null : null;
    const title = text(lesson.name) || "Untitled lesson";
    documents.push({
      externalId,
      title,
      body: sectionName ? `${sectionName}\n\n${body}` : body,
      language: "und",
      mediaType: "text/plain",
      metadata: {
        provider: "circle",
        spaceId: courseId,
        sectionId,
        sectionName,
        lessonUrl: course.url,
        updatedAt: text(lesson.updated_at) || null,
      },
    });
  }
  if (documents.length === 0) {
    throw new CircleSourceError("circle_course_has_no_published_text");
  }
  const contentHash = createHash("sha256")
    .update(
      documents
        .map((document) => `${document.externalId}\n${document.body}`)
        .join("\n\n"),
    )
    .digest("hex");
  return { course, documents, contentHash };
}
