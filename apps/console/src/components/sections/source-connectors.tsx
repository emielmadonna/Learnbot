"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, SelectField, TextField } from "../ui";
import { cx } from "../ui/cx";
import styles from "./source-connectors.module.css";

type CourseOption = { readonly courseId: string; readonly title: string };
type CircleCourse = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly url: string;
};
type CircleState = {
  readonly configured: boolean;
  readonly accountLabel?: string | null;
  readonly keyLast4?: string | null;
  readonly configurationRequired?: string | null;
  readonly courses: readonly CircleCourse[];
};

/**
 * A provider is only ever "circle" or "youtube" — the two connectors this
 * repo actually implements. The design mockup this wizard follows lists five
 * providers (Kajabi, Teachable, Thinkific/Podia/Skool, a public course URL);
 * those rows are deliberately not rendered. An enabled-looking row that goes
 * nowhere is worse than an honest, shorter list — see the RULES this file
 * was built against.
 */
type Provider = "circle" | "youtube";

/**
 * The real, verified shape returned by `learning_source_connector_sync` (see
 * infra/supabase/migrations/20260730143000_learning_source_connectors.sql).
 * Every field here is something the server actually measured — nothing in
 * the processing column below is allowed to show a number that isn't one of
 * these.
 */
type SyncResult = {
  readonly provider: Provider;
  readonly name: string;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly reusedEmbeddingCount: number;
  readonly pendingEmbeddingCount: number;
  readonly retrievable: boolean;
  readonly changed: boolean;
  readonly versionNumber: number | null;
  /**
   * Why the import is built but not answerable, named by the server. Today the
   * only value is `course_not_published`: the knowledge version is live and
   * active, but retrieval also requires `courses.status = 'published'`
   * (20260726093000_widget_delivery.sql:681), and a connector never publishes
   * a course on its own. `null` when nothing is blocking.
   */
  readonly activationBlockedReason: string | null;
};

const COPY: Record<string, string> = {
  invalid_youtube_url: "Enter a valid YouTube video URL.",
  youtube_video_unavailable: "That YouTube video could not be opened.",
  captions_unavailable:
    "This video does not expose usable captions, so nothing was imported.",
  transcript_too_large: "That caption transcript is too large to import safely.",
  youtube_provider_unavailable:
    "YouTube could not be reached. Nothing was imported.",
  circle_credential_invalid:
    "Circle rejected this token. Replace it with a valid Admin API token.",
  circle_plan_or_permission_required:
    "This Circle account does not have the Admin API plan or permission required.",
  circle_rate_limited:
    "Circle is rate limiting this account. Wait, then try again.",
  circle_course_has_no_published_text:
    "That Circle course has no published text lessons to import.",
  circle_course_not_found:
    "That Circle course is no longer available to this account.",
  tenant_credential_not_configured:
    "Connect a Circle Admin API token before importing.",
  server_secret_required:
    "The server-side Supabase secret is not configured for source connections.",
  connector_database_unavailable:
    "Source connections are not enabled in this database yet.",
  course_not_found:
    "That destination course is no longer in this workspace. Reload and choose again.",
  access_denied: "Your workspace role cannot make this source change.",
  invalid_request: "Check the source details and try again.",
  connector_request_failed: "The source could not be imported. Nothing changed.",
};

function messageFor(code: unknown) {
  return typeof code === "string"
    ? COPY[code] ?? "The source could not be imported. Nothing changed."
    : "The source could not be imported. Nothing changed.";
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function successMessage(payload: Record<string, unknown>, name: string) {
  const destination =
    typeof payload.destination === "object" && payload.destination !== null
      ? (payload.destination as Record<string, unknown>)
      : null;
  const prefix =
    destination?.created === true
      ? `A new blank course was created from ${name}, then synced`
      : `${name} is synced`;
  if (payload.changed === false) {
    return `${name} is already up to date. No duplicate version was created.`;
  }
  if (payload.activated === false) {
    return `${prefix}, but the current course knowledge was preserved. Turn on replacement and sync again to make this source active.`;
  }
  const count =
    typeof payload.documentCount === "number" ? payload.documentCount : 0;
  const documents =
    count > 0 ? ` with ${count} source document${count === 1 ? "" : "s"}` : "";
  if (payload.activationBlockedReason === "course_not_published") {
    // Saying "active" and stopping there was the old copy, and it was read as
    // "the assistant can answer from this now". It cannot: retrieval requires
    // a published course, and a connector never publishes one.
    return `${prefix}${documents}. Publish the course to let the assistant answer from it.`;
  }
  return `${prefix} and is active${documents}.`;
}

function numberField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads the four measured counts the sync RPC returns — documentCount,
 * chunkCount, reusedEmbeddingCount, pendingEmbeddingCount — or null if any
 * of them is missing/malformed. The processing column only renders once
 * every one of these is present; there is no partial or fabricated state.
 */
function readSyncResult(
  provider: Provider,
  name: string,
  payload: Record<string, unknown>,
): SyncResult | null {
  const documentCount = numberField(payload, "documentCount");
  const chunkCount = numberField(payload, "chunkCount");
  const reusedEmbeddingCount = numberField(payload, "reusedEmbeddingCount");
  const pendingEmbeddingCount = numberField(payload, "pendingEmbeddingCount");
  if (
    documentCount === null ||
    chunkCount === null ||
    reusedEmbeddingCount === null ||
    pendingEmbeddingCount === null
  ) {
    return null;
  }
  return {
    provider,
    name,
    documentCount,
    chunkCount,
    reusedEmbeddingCount,
    pendingEmbeddingCount,
    retrievable: payload.retrievable === true,
    changed: payload.changed !== false,
    versionNumber: numberField(payload, "versionNumber"),
    activationBlockedReason:
      typeof payload.activationBlockedReason === "string"
        ? payload.activationBlockedReason
        : null,
  };
}

/**
 * The last step's sub-label. "Answerable now" is only ever shown when the
 * server said so; a built-but-blocked import says what is blocking it and what
 * clears it, because "Saved, but not yet answerable" on its own reads as a
 * failure the creator cannot act on.
 */
function answerabilityLabel(result: SyncResult) {
  if (result.retrievable) return "Answerable now";
  if (result.activationBlockedReason === "course_not_published") {
    return "Imported — publish this course to make it answerable";
  }
  return "Saved, but not yet answerable";
}

/**
 * `| undefined` is explicit because this repo runs `exactOptionalPropertyTypes`
 * and a CSS-module lookup is typed `string | undefined`. Without it, every
 * `className={styles.x}` call site is an error rather than the omission the
 * optional marker implies.
 */
function CheckGlyph({
  className,
}: {
  readonly className?: string | undefined;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={3}
      viewBox="0 0 24 24"
    >
      <path d="M4.5 12.5 9.5 17.5 19.5 7" />
    </svg>
  );
}

export function SourceConnectors({
  canConfigureCircle,
  courses,
}: {
  readonly canConfigureCircle: boolean;
  readonly courses: readonly CourseOption[];
}) {
  const router = useRouter();
  const [courseId, setCourseId] = useState(courses[0]?.courseId ?? "new");
  const [provider, setProvider] = useState<Provider>("circle");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [circle, setCircle] = useState<CircleState | null>(null);
  const [circleCourseId, setCircleCourseId] = useState("");
  const [circleToken, setCircleToken] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [replaceActive, setReplaceActive] = useState(false);
  const [busy, setBusy] = useState<"youtube" | "circle" | "configure" | null>(
    null,
  );
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const loadCircle = useCallback(async () => {
    const response = await fetch("/api/learning/connectors/circle", {
      cache: "no-store",
    });
    const payload = await readJson(response);
    if (!response.ok || payload.ok !== true) {
      throw new Error(
        typeof payload.code === "string" ? payload.code : "connector_request_failed",
      );
    }
    const next = payload as unknown as CircleState;
    setCircle(next);
    setCircleCourseId((current) =>
      next.courses.some((course) => course.id === current)
        ? current
        : next.courses[0]?.id ?? "",
    );
    setAccountLabel(next.accountLabel ?? "");
  }, []);

  useEffect(() => {
    void loadCircle().catch((error: Error) => {
      setNotice({ tone: "error", message: messageFor(error.message) });
    });
  }, [loadCircle]);

  useEffect(() => {
    setCourseId((current) =>
      current === "new" || courses.some((course) => course.courseId === current)
        ? current
        : courses[0]?.courseId ?? "new",
    );
  }, [courses]);

  const courseOptions = [
    {
      value: "new",
      label: "Create a new course from this source",
    },
    ...courses.map((course) => ({
      value: course.courseId,
      label: course.title,
    })),
  ];

  async function syncYouTube() {
    setBusy("youtube");
    setNotice(null);
    setLastResult(null);
    try {
      const response = await fetch("/api/learning/connectors/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          url: youtubeUrl,
          replaceActiveKnowledge: replaceActive,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok || payload.ok !== true) {
        throw new Error(String(payload.code ?? "connector_request_failed"));
      }
      setLastResult(readSyncResult("youtube", "YouTube captions", payload));
      setNotice({
        tone: "success",
        message: successMessage(payload, "YouTube captions"),
      });
      const destination =
        typeof payload.destination === "object" && payload.destination !== null
          ? (payload.destination as Record<string, unknown>)
          : null;
      if (destination?.created === true) router.refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        message: messageFor(error instanceof Error ? error.message : null),
      });
    } finally {
      setBusy(null);
    }
  }

  async function configureCircle() {
    setBusy("configure");
    setNotice(null);
    try {
      const response = await fetch("/api/learning/connectors/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "configure",
          token: circleToken,
          accountLabel,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok || payload.ok !== true) {
        throw new Error(String(payload.code ?? "connector_request_failed"));
      }
      setCircleToken("");
      await loadCircle();
      setNotice({
        tone: "success",
        message: "Circle is connected. The token is encrypted server-side.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: messageFor(error instanceof Error ? error.message : null),
      });
    } finally {
      setBusy(null);
    }
  }

  async function syncCircle() {
    setBusy("circle");
    setNotice(null);
    setLastResult(null);
    try {
      const response = await fetch("/api/learning/connectors/circle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import",
          courseId,
          circleCourseId,
          replaceActiveKnowledge: replaceActive,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok || payload.ok !== true) {
        throw new Error(String(payload.code ?? "connector_request_failed"));
      }
      const name =
        circle?.courses.find((course) => course.id === circleCourseId)?.name ??
        "Circle course";
      setLastResult(readSyncResult("circle", name, payload));
      setNotice({ tone: "success", message: successMessage(payload, name) });
      const destination =
        typeof payload.destination === "object" && payload.destination !== null
          ? (payload.destination as Record<string, unknown>)
          : null;
      if (destination?.created === true) router.refresh();
    } catch (error) {
      setNotice({
        tone: "error",
        message: messageFor(error instanceof Error ? error.message : null),
      });
    } finally {
      setBusy(null);
    }
  }

  const circleConnected = circle?.configured === true;
  const working = busy === "circle" || busy === "youtube";

  // ------------------------------------------------------------- column 2
  // "Pick what to bring." The Circle Admin API (see
  // lib/source-connectors/circle.ts `listCircleCourses`) only ever returns a
  // flat list of course spaces — id, name, slug, url. It does not expose
  // module or lesson listings to the browser (those are only read
  // server-side, inside a sync, via course_sections/course_lessons). So this
  // tree stops at one level: courses. A real module/lesson tree would need
  // two things that don't exist today: (1) a new read-only connector action
  // (e.g. `action: "describe"`) that calls course_sections/course_lessons
  // for a chosen space and returns section/lesson titles + counts without
  // importing anything, and (2) the sync RPC accepting an optional
  // lesson-id allowlist instead of always importing every published lesson
  // in the space. Neither exists, so this column does not pretend to have
  // module/lesson checkboxes.
  let pickColumn: ReactNode;
  if (provider === "youtube") {
    pickColumn = (
      <>
        <h3>Add a YouTube video</h3>
        <p className={styles.panelIntro}>
          Paste a public video URL. Only its captions and metadata are read —
          nothing is downloaded or re-hosted.
        </p>
        <TextField
          label="YouTube video URL"
          onChange={(event) => setYoutubeUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          type="url"
          value={youtubeUrl}
        />
        <Button
          disabled={!youtubeUrl.trim()}
          loading={busy === "youtube"}
          loadingLabel="Reading captions…"
          onClick={() => void syncYouTube()}
          variant="primary"
        >
          Sync captions
        </Button>
        <small className={styles.constraint}>
          Videos without accessible captions are refused; no placeholder
          content is created.
        </small>
      </>
    );
  } else if (circle === null) {
    pickColumn = (
      <p className={styles.configuration}>Checking your Circle connection…</p>
    );
  } else if (!circleConnected) {
    pickColumn = canConfigureCircle ? (
      <>
        <h3>Connect Circle</h3>
        <p className={styles.panelIntro}>
          Reads published course lessons through Circle&apos;s Admin API.
        </p>
        <TextField
          label="Account label"
          maxLength={160}
          onChange={(event) => setAccountLabel(event.target.value)}
          placeholder="Team learning community"
          value={accountLabel}
        />
        <TextField
          autoComplete="off"
          help="Available from Circle → Developers → Tokens on eligible plans."
          label="Circle Admin API token"
          onChange={(event) => setCircleToken(event.target.value)}
          type="password"
          value={circleToken}
        />
        <Button
          disabled={circleToken.trim().length < 20}
          loading={busy === "configure"}
          loadingLabel="Connecting…"
          onClick={() => void configureCircle()}
          variant="primary"
        >
          Connect Circle
        </Button>
      </>
    ) : (
      <p className={styles.configuration}>
        A workspace owner or admin must connect the Circle account. Once
        connected, creators can import its courses here.
      </p>
    );
  } else if (circle.configurationRequired === "server_secret") {
    pickColumn = (
      <p className={styles.configuration}>
        A server-side Supabase secret must be configured before this account
        can be read.
      </p>
    );
  } else if (circle.courses.length === 0) {
    pickColumn = (
      <p className={styles.configuration}>
        This Circle account returned no course spaces.
      </p>
    );
  } else {
    pickColumn = (
      <>
        <div className={styles.pickHead}>
          <h3>
            Found {circle.courses.length} course
            {circle.courses.length === 1 ? "" : "s"}
          </h3>
        </div>
        <p className={styles.panelIntro}>
          Choose the course space to read. Only published lessons with text
          are imported — Circle does not expose modules or lessons here yet,
          so this is one course space at a time.
        </p>
        <small className={styles.constraint}>
          Token ending in {circle.keyLast4 || "••••"} · stored in Supabase
          Vault.
        </small>
        <div className={styles.pickList}>
          {circle.courses.map((course) => (
            <button
              aria-pressed={circleCourseId === course.id}
              className={styles.pickRow}
              key={course.id}
              onClick={() => setCircleCourseId(course.id)}
              type="button"
            >
              <span
                className={cx(
                  styles.pickCheck,
                  circleCourseId === course.id && styles.pickCheckOn,
                )}
              >
                {circleCourseId === course.id ? (
                  <CheckGlyph className={styles.pickCheckGlyph} />
                ) : null}
              </span>
              <span className={styles.pickCopy}>
                <strong>{course.name}</strong>
                <small>{course.url || course.slug || "Circle course"}</small>
              </span>
            </button>
          ))}
        </div>
        <Button
          disabled={!circleCourseId}
          loading={busy === "circle"}
          loadingLabel="Reading lessons…"
          onClick={() => void syncCircle()}
          variant="primary"
        >
          Sync published lessons
        </Button>
        <small className={styles.constraint}>
          Picking a different course space here does not remove one already
          imported — turn on &quot;Replace the active knowledge version&quot;
          above to make only this source active.
        </small>
      </>
    );
  }

  // ------------------------------------------------------------- column 3
  // "Processing." learning_source_connector_sync (the RPC both syncCircle
  // and syncYouTube call) does its work as ONE synchronous request — fetch,
  // split into chunks, and merge into a new knowledge version all happen
  // before the response comes back. There is no queue, job id, or
  // percentage the client can observe mid-request, so the "reading" step
  // below is a plain spinner with no invented percentage or ETA. The three
  // counts after it (documents, chunks, embeddings) are real fields the RPC
  // returns; nothing here is fabricated. There is likewise no background
  // job to hand this off to, so the mockup's "Run in the background"
  // control is intentionally not present — see the report for what a real
  // one would require.
  const stepState: "idle" | "working" | "done" = working
    ? "working"
    : lastResult !== null
      ? "done"
      : "idle";
  const embeddedCount =
    lastResult !== null
      ? lastResult.chunkCount - lastResult.pendingEmbeddingCount
      : 0;

  return (
    <section className={styles.connectors}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Connected sources</p>
          <h3>Sync from the source</h3>
          <p>
            Choose an existing destination or create a new course from the
            verified source. A sync only succeeds after real source text has
            been retrieved.
          </p>
        </div>
        <span className={styles.secure}>Tenant isolated</span>
      </div>

      <SelectField
        label="Destination course"
        onChange={(event) => setCourseId(event.target.value)}
        options={courseOptions}
        value={courseId}
      />

      <label className={styles.replace}>
        <input
          checked={replaceActive}
          onChange={(event) => setReplaceActive(event.target.checked)}
          type="checkbox"
        />
        <span>
          <b>Replace the active knowledge version</b>
          <small>
            Leave this off to import safely without replacing authored or
            uploaded knowledge.
          </small>
        </span>
      </label>

      <div className={styles.wizard}>
        <div className={styles.column}>
          <p className={styles.columnLabel}>1 · Where does it live</p>
          <div className={styles.panel}>
            <h3>Bring a course in</h3>
            <p className={styles.panelIntro}>
              We read the lessons you already wrote. Nothing is published to
              students until you approve it.
            </p>
            <div className={styles.rows}>
              <button
                aria-pressed={provider === "circle"}
                className={cx(
                  styles.row,
                  provider === "circle" && styles.rowSelected,
                )}
                onClick={() => setProvider("circle")}
                type="button"
              >
                <span className={styles.rowAvatar} aria-hidden="true">
                  C
                </span>
                <span className={styles.rowCopy}>
                  <strong>Circle</strong>
                  <small>
                    {circle === null
                      ? "Checking connection…"
                      : circleConnected
                        ? `Connected · ${circle.accountLabel || "Circle account"}`
                        : "Connect with an Admin API token"}
                  </small>
                </span>
                {circleConnected ? (
                  <CheckGlyph className={styles.rowCheck} />
                ) : null}
              </button>
              <button
                aria-pressed={provider === "youtube"}
                className={cx(
                  styles.row,
                  provider === "youtube" && styles.rowSelected,
                )}
                onClick={() => setProvider("youtube")}
                type="button"
              >
                <span className={styles.rowAvatar} aria-hidden="true">
                  ▶
                </span>
                <span className={styles.rowCopy}>
                  <strong>YouTube</strong>
                  <small>Public captions · no account needed</small>
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className={styles.column}>
          <p className={styles.columnLabel}>2 · Pick what to bring</p>
          <div className={styles.panel}>{pickColumn}</div>
        </div>

        <div className={styles.column}>
          <p className={styles.columnLabel}>3 · Processing</p>
          <div className={styles.panel}>
            <h3>Bringing it in</h3>
            <div className={styles.steps}>
              <div
                className={cx(
                  styles.step,
                  stepState === "idle" && styles.stepPending,
                )}
              >
                <span
                  className={cx(
                    styles.stepMark,
                    stepState === "done" && styles.stepMarkDone,
                    stepState === "working" && styles.stepMarkWorking,
                  )}
                  aria-hidden="true"
                >
                  {stepState === "done" ? (
                    <CheckGlyph className={styles.stepCheckGlyph} />
                  ) : null}
                </span>
                <span className={styles.stepCopy}>
                  <strong>
                    {stepState === "done"
                      ? `Fetched ${lastResult!.documentCount} lesson${lastResult!.documentCount === 1 ? "" : "s"}`
                      : "Reading the source"}
                  </strong>
                  <small>
                    {stepState === "working"
                      ? "In progress — this reads and imports in one step, so there is no percentage to show yet."
                      : stepState === "done"
                        ? lastResult!.name
                        : "Waiting to start"}
                  </small>
                </span>
              </div>

              <div
                className={cx(
                  styles.step,
                  stepState !== "done" && styles.stepPending,
                )}
              >
                <span
                  className={cx(
                    styles.stepMark,
                    stepState === "done" && styles.stepMarkDone,
                  )}
                  aria-hidden="true"
                >
                  {stepState === "done" ? (
                    <CheckGlyph className={styles.stepCheckGlyph} />
                  ) : null}
                </span>
                <span className={styles.stepCopy}>
                  <strong>
                    {stepState === "done"
                      ? `Split into ${lastResult!.chunkCount} answerable piece${lastResult!.chunkCount === 1 ? "" : "s"}`
                      : "Split into answerable pieces"}
                  </strong>
                  <small>
                    {stepState === "done" ? "Ready to embed" : "Next"}
                  </small>
                </span>
              </div>

              <div
                className={cx(
                  styles.step,
                  stepState !== "done" && styles.stepPending,
                )}
              >
                <span
                  className={cx(
                    styles.stepMark,
                    stepState === "done" &&
                      lastResult!.pendingEmbeddingCount === 0 &&
                      styles.stepMarkDone,
                    stepState === "done" &&
                      lastResult!.pendingEmbeddingCount > 0 &&
                      styles.stepMarkWorking,
                  )}
                  aria-hidden="true"
                >
                  {stepState === "done" &&
                  lastResult!.pendingEmbeddingCount === 0 ? (
                    <CheckGlyph className={styles.stepCheckGlyph} />
                  ) : null}
                </span>
                <span className={styles.stepCopy}>
                  <strong>Preparing search embeddings</strong>
                  <small>
                    {stepState === "done"
                      ? lastResult!.pendingEmbeddingCount === 0
                        ? `All ${lastResult!.chunkCount} pieces embedded`
                        : `${embeddedCount} of ${lastResult!.chunkCount} embedded so far — the rest finish in the background`
                      : "Next"}
                  </small>
                </span>
              </div>

              <div
                className={cx(
                  styles.step,
                  stepState !== "done" && styles.stepPending,
                )}
              >
                <span
                  className={cx(
                    styles.stepMark,
                    stepState === "done" && styles.stepMarkDone,
                  )}
                  aria-hidden="true"
                >
                  {stepState === "done" ? (
                    <CheckGlyph className={styles.stepCheckGlyph} />
                  ) : null}
                </span>
                <span className={styles.stepCopy}>
                  <strong>
                    {stepState === "done"
                      ? lastResult!.changed
                        ? `Active as version ${lastResult!.versionNumber ?? "?"}`
                        : "Already up to date"
                      : "Made active in this course"}
                  </strong>
                  <small>
                    {stepState === "done"
                      ? answerabilityLabel(lastResult!)
                      : "Next"}
                  </small>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {notice ? (
        <p
          aria-live="polite"
          className={
            notice.tone === "success" ? styles.success : styles.error
          }
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      ) : null}
    </section>
  );
}
