"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createBrowserSupabaseClient } from "../../lib/supabase/client";
import {
  buildAccessibleBarChart,
  ChartDataError,
  type ChartAsset,
} from "../../lib/visuals/chart";
import {
  Button,
  EmptyState,
  FileDrop,
  SelectField,
  StateBadge,
  TextAreaField,
  TextField,
  Toggle,
} from "../ui";
import styles from "./visual-knowledge-manager.module.css";

const ENDPOINT = "/api/learning/visuals";
const ACCEPTED_MEDIA = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
] as const;
const MAX_BYTES = 20_971_520;
const CHART_EXAMPLE = `Month,Completed lessons,Questions asked
January,24,18
February,37,26
March,51,34`;

type CourseOption = {
  readonly courseId: string;
  readonly title: string;
};

type VisualItem = {
  visualAssetId: string;
  courseId: string;
  courseTitle: string;
  title: string;
  description: string;
  altText: string;
  showInAnswers: boolean;
  fileName: string;
  mediaType: string;
  visualKind: "image" | "svg" | "video" | "chart";
  sizeBytes: number;
  status: "pending_upload" | "pending_revalidation" | "active" | "archived";
  usageCount: number;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  previewUrl: string | null;
};

type Draft = {
  courseId: string;
  title: string;
  description: string;
  altText: string;
  showInAnswers: boolean;
};

const EMPTY_DRAFT: Draft = {
  courseId: "",
  title: "",
  description: "",
  altText: "",
  showInAnswers: true,
};

const ERROR_COPY: Readonly<Record<string, string>> = {
  access_denied:
    "Only a workspace owner, admin, or creator can manage visual knowledge.",
  invalid_request:
    "Check the course, description, alt text, media type, and file size.",
  media_signature_invalid:
    "The file contents do not match its declared media type. It was not published.",
  media_size_invalid:
    "The file is empty or larger than the 20 MB private-media limit.",
  media_type_unsupported:
    "Use a PNG, JPG, WebP, safe SVG, or MP4 file.",
  request_failed:
    "Visual knowledge is temporarily unavailable. Existing visuals remain private.",
  storage_signing_failed:
    "Private storage could not prepare that file. Nothing was published.",
  unsafe_svg:
    "That SVG contains active, linked, styled, or unsupported content. Export a flat SVG or PNG and try again.",
  tenant_selection_required:
    "Choose a workspace before managing visual knowledge.",
  upload_evidence_invalid:
    "The uploaded image could not be verified. It was not made answerable.",
  upload_evidence_mismatch:
    "The uploaded bytes did not match the prepared image. It was not published.",
  upload_incomplete:
    "The upload did not finish. Try choosing the image again.",
  upload_intent_unavailable:
    "That private upload expired. Start a fresh upload.",
  version_conflict:
    "This visual changed elsewhere. Reload the latest copy before editing.",
  visual_validation_unavailable:
    "Secure media validation is not configured. Nothing was published.",
  visual_not_found:
    "That visual no longer exists in this workspace.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function errorCode(value: unknown) {
  return isRecord(value) && typeof value.code === "string"
    ? value.code
    : "request_failed";
}

function errorSentence(value: unknown) {
  const code = errorCode(value);
  return ERROR_COPY[code] ?? ERROR_COPY.request_failed!;
}

function readItem(value: unknown): VisualItem | null {
  if (
    !isRecord(value) ||
    typeof value.visualAssetId !== "string" ||
    typeof value.courseId !== "string" ||
    typeof value.courseTitle !== "string" ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.altText !== "string" ||
    typeof value.showInAnswers !== "boolean" ||
    typeof value.fileName !== "string" ||
    typeof value.mediaType !== "string" ||
    (value.visualKind !== "image" &&
      value.visualKind !== "svg" &&
      value.visualKind !== "video" &&
      value.visualKind !== "chart") ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.status !== "pending_upload" &&
      value.status !== "pending_revalidation" &&
      value.status !== "active" &&
      value.status !== "archived") ||
    typeof value.usageCount !== "number" ||
    !Number.isSafeInteger(value.usageCount) ||
    typeof value.recordVersion !== "number" ||
    !Number.isSafeInteger(value.recordVersion) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.archivedAt !== null && typeof value.archivedAt !== "string") ||
    (value.previewUrl !== null && typeof value.previewUrl !== "string")
  ) {
    return null;
  }
  return value as unknown as VisualItem;
}

/** A generic play-triangle glyph for the video-card thumbnail overlay. */
function PlayGlyph() {
  return (
    <svg aria-hidden="true" fill="currentColor" stroke="none" viewBox="0 0 24 24">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

/** A generic scan/knowledge glyph for the topbar's accent icon mark. */
function KnowledgeGlyph() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={2.6}
      viewBox="0 0 24 24"
    >
      <path d="M19.4 6.4A9 9 0 1 0 21 12" />
      <circle cx="12" cy="12" fill="currentColor" r="3.2" stroke="none" />
    </svg>
  );
}

/**
 * Renders the real media for a visual — never a placeholder. Used both by
 * the "how it looks to a student" preview and anywhere else that needs the
 * actual file rather than a stand-in.
 */
function previewMediaNode(mediaType: string, url: string, alt: string) {
  if (mediaType === "video/mp4") {
    return (
      <video
        aria-label={alt}
        className={styles.previewMedia}
        controls
        muted
        playsInline
        preload="metadata"
        src={url}
      />
    );
  }
  return <img alt={alt} className={styles.previewMedia} src={url} />;
}

function draftFor(item: VisualItem): Draft {
  return {
    courseId: item.courseId,
    title: item.title,
    description: item.description,
    altText: item.altText,
    showInAnswers: item.showInAnswers,
  };
}

function validateDraft(draft: Draft) {
  if (draft.courseId.length === 0) return "Choose the course this belongs to.";
  if (draft.title.trim().length < 1 || draft.title.trim().length > 160) {
    return "Give the visual a title of 1–160 characters.";
  }
  if (
    draft.description.trim().length < 3 ||
    draft.description.trim().length > 2_000
  ) {
    return "Describe when this visual helps in 3–2,000 characters.";
  }
  if (
    draft.altText.trim().length < 3 ||
    draft.altText.trim().length > 500
  ) {
    return "Write 3–500 characters of alt text for screen readers.";
  }
  return null;
}

function formFingerprint(draft: Draft) {
  return JSON.stringify({
    ...draft,
    title: draft.title.trim(),
    description: draft.description.trim(),
    altText: draft.altText.trim(),
  });
}

export function VisualKnowledgeManager({
  courses,
}: {
  readonly courses: readonly CourseOption[];
}) {
  const [items, setItems] = useState<VisualItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [chartMode, setChartMode] = useState(false);
  const [chartData, setChartData] = useState(CHART_EXAMPLE);
  const [chartAsset, setChartAsset] = useState<ChartAsset | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [courseFilter, setCourseFilter] = useState("");
  const [draft, setDraft] = useState<Draft>({
    ...EMPTY_DRAFT,
    courseId: courses[0]?.courseId ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${ENDPOINT}?includeArchived=true`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const body = await readJson(response);
      if (
        !response.ok ||
        !isRecord(body) ||
        body.ok !== true ||
        body.dataMode !== "durable" ||
        !Array.isArray(body.items)
      ) {
        throw new Error(errorSentence(body));
      }
      const next = body.items.map(readItem).filter((item) => item !== null);
      if (next.length !== body.items.length) {
        throw new Error(
          "The service returned visual records this screen could not verify.",
        );
      }
      setItems(next);
      setSelectedId((current) => {
        if (current !== null && next.some((item) => item.visualAssetId === current)) {
          return current;
        }
        return next.find((item) => item.status === "active")?.visualAssetId ?? null;
      });
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : ERROR_COPY.request_failed!,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected =
    selectedId === null
      ? null
      : items.find((item) => item.visualAssetId === selectedId) ?? null;

  useEffect(() => {
    if (selected !== null && !adding) setDraft(draftFor(selected));
  }, [adding, selected]);

  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (showArchived || item.status !== "archived") &&
          (courseFilter === "" || item.courseId === courseFilter),
      ),
    [courseFilter, items, showArchived],
  );
  const draftError = validateDraft(draft);
  const dirty =
    selected !== null &&
    formFingerprint(draft) !== formFingerprint(draftFor(selected));

  function beginAdd() {
    setAdding(true);
    setChartMode(false);
    setChartAsset(null);
    setChartError(null);
    setSelectedId(null);
    setDraft({ ...EMPTY_DRAFT, courseId: courses[0]?.courseId ?? "" });
    setMessage(null);
    setActionError(null);
    setConfirmArchive(false);
  }

  function beginChart() {
    beginAdd();
    setChartMode(true);
  }

  function generateChart() {
    try {
      const asset = buildAccessibleBarChart(chartData, draft.title);
      setChartAsset(asset);
      setChartError(null);
      setDraft((current) => ({
        ...current,
        title: asset.title,
        description: asset.description,
        altText: asset.altText,
      }));
    } catch (error) {
      setChartAsset(null);
      setChartError(
        error instanceof ChartDataError
          ? error.message
          : "The chart could not be generated from that table.",
      );
    }
  }

  async function publishChart() {
    if (chartAsset === null) return;
    const file = new File([chartAsset.svg], chartAsset.fileName, {
      type: chartAsset.mediaType,
    });
    try {
      await upload(file, () => undefined, "chart");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : ERROR_COPY.request_failed!,
      );
    }
  }

  async function upload(
    file: File,
    onProgress: (ratio: number) => void,
    visualKind?: "chart",
  ) {
    const invalid = validateDraft(draft);
    if (invalid !== null) throw new Error(invalid);
    setSaving(true);
    setMessage(null);
    setActionError(null);
    onProgress(0.08);
    try {
      const preparedResponse = await fetch(ENDPOINT, {
        body: JSON.stringify({
          action: "prepare",
          courseId: draft.courseId,
          title: draft.title.trim(),
          description: draft.description.trim(),
          altText: draft.altText.trim(),
          showInAnswers: draft.showInAnswers,
          fileName: file.name,
          mediaType: file.type,
          sizeBytes: file.size,
          visualKind,
        }),
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const prepared = await readJson(preparedResponse);
      if (
        !preparedResponse.ok ||
        !isRecord(prepared) ||
        typeof prepared.visualAssetId !== "string" ||
        typeof prepared.bucket !== "string" ||
        typeof prepared.path !== "string" ||
        typeof prepared.token !== "string" ||
        typeof prepared.contentType !== "string"
      ) {
        throw new Error(errorSentence(prepared));
      }

      onProgress(0.28);
      const supabase = createBrowserSupabaseClient();
      const uploaded = await supabase.storage
        .from(prepared.bucket)
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: prepared.contentType,
          upsert: false,
        });
      if (uploaded.error) {
        throw new Error("The file could not be written to private storage.");
      }

      onProgress(0.82);
      const finalResponse = await fetch(ENDPOINT, {
        body: JSON.stringify({
          action: "finalize",
          visualAssetId: prepared.visualAssetId,
        }),
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const finalized = await readJson(finalResponse);
      if (!finalResponse.ok) throw new Error(errorSentence(finalized));
      onProgress(1);
      setAdding(false);
      setChartMode(false);
      setChartAsset(null);
      setSelectedId(prepared.visualAssetId);
      setMessage(
        draft.showInAnswers
          ? "Visual added. Its description is now available to course retrieval."
          : "Visual added privately. It will stay out of answers until enabled.",
      );
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function saveSelected() {
    if (selected === null || draftError !== null) return;
    setSaving(true);
    setMessage(null);
    setActionError(null);
    try {
      const response = await fetch(ENDPOINT, {
        body: JSON.stringify({
          action: "update",
          visualAssetId: selected.visualAssetId,
          expectedVersion: selected.recordVersion,
          courseId: draft.courseId,
          title: draft.title.trim(),
          description: draft.description.trim(),
          altText: draft.altText.trim(),
          showInAnswers: draft.showInAnswers,
        }),
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(errorSentence(body));
      setMessage(
        draft.showInAnswers
          ? "Saved. The updated description is searchable in course answers."
          : "Saved. This visual is no longer eligible for answers.",
      );
      await refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : ERROR_COPY.request_failed!,
      );
    } finally {
      setSaving(false);
    }
  }

  async function revalidateSelected() {
    if (selected === null || selected.status !== "pending_revalidation") return;
    setSaving(true);
    setMessage(null);
    setActionError(null);
    try {
      const response = await fetch(ENDPOINT, {
        body: JSON.stringify({
          action: "finalize",
          visualAssetId: selected.visualAssetId,
        }),
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(errorSentence(body));
      setMessage("Validated. The preserved visual is safe and available again.");
      await refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : ERROR_COPY.request_failed!,
      );
    } finally {
      setSaving(false);
    }
  }

  async function archiveSelected() {
    if (selected === null) return;
    setSaving(true);
    setMessage(null);
    setActionError(null);
    try {
      const response = await fetch(ENDPOINT, {
        body: JSON.stringify({
          action: "archive",
          visualAssetId: selected.visualAssetId,
          expectedVersion: selected.recordVersion,
        }),
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(errorSentence(body));
      setConfirmArchive(false);
      setMessage(
        "Archived. The image remains private for audit history and is no longer retrievable.",
      );
      setSelectedId(null);
      await refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : ERROR_COPY.request_failed!,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.root}>
      <header className={styles.heading}>
        <div>
          <p className={styles.kicker}>Visual knowledge</p>
          <div className={styles.titleRow}>
            <span aria-hidden="true" className={styles.brandMark}>
              <KnowledgeGlyph />
            </span>
            <h2>Visuals the bot can show</h2>
          </div>
          <p>
            Upload charts, diagrams, and screenshots, then describe when they
            genuinely help an answer.
          </p>
        </div>
        <Button disabled={courses.length === 0} onClick={beginAdd} variant="primary">
          Add a visual
        </Button>
      </header>

      <div className={styles.workspace}>
        <div className={styles.library}>
          <div className={styles.dropPrompt}>
            <span className={styles.uploadGlyph} aria-hidden="true">
              ↑
            </span>
            <strong>Add charts, diagrams, screenshots, or clips</strong>
            <small>
              PNG, JPG, WebP, safe SVG, or MP4 · up to 20 MB.
            </small>
            <span className={styles.promptActions}>
              <button
                className={styles.chooseCue}
                disabled={courses.length === 0}
                onClick={beginAdd}
                type="button"
              >
                Choose a file
              </button>
              <button
                className={styles.chartCue}
                disabled={courses.length === 0}
                onClick={beginChart}
                type="button"
              >
                Build a chart from data
              </button>
            </span>
          </div>

          <div className={styles.filters}>
            <label>
              <span>Course</span>
              <select
                onChange={(event) => setCourseFilter(event.target.value)}
                value={courseFilter}
              >
                <option value="">All courses</option>
                {courses.map((course) => (
                  <option key={course.courseId} value={course.courseId}>
                    {course.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.archiveFilter}>
              <input
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
                type="checkbox"
              />
              Show archived
            </label>
          </div>

          {loading ? <p className={styles.meta}>Reading visual knowledge…</p> : null}
          {loadError !== null ? (
            <EmptyState
              action={<Button onClick={() => void refresh()}>Try again</Button>}
              compact
              description={loadError}
              headline="Visual knowledge could not be verified"
              tone="error"
            />
          ) : null}

          {!loading && loadError === null && visibleItems.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={beginAdd} variant="primary">
                  Add the first visual
                </Button>
              }
              compact
              description="A description makes an image searchable; alt text makes it accessible. Nothing is exposed until the upload is verified."
              headline="No visual knowledge yet"
            />
          ) : null}

          <div className={styles.cards}>
            {visibleItems.map((item) => (
              <button
                aria-pressed={selectedId === item.visualAssetId}
                className={styles.visualCard}
                key={item.visualAssetId}
                onClick={() => {
                  setAdding(false);
                  setSelectedId(item.visualAssetId);
                  setMessage(null);
                  setActionError(null);
                }}
                type="button"
              >
                <span className={styles.thumb}>
                  {item.previewUrl === null ? (
                    item.status === "pending_upload" ? (
                      // A real, observable state — the file is uploaded and
                      // waiting on server-side signature/size verification
                      // before it gets a signed read URL. There is no
                      // measured percentage for that check, so the bar is
                      // deliberately indeterminate rather than showing an
                      // invented number.
                      <span className={styles.thumbProcessing}>
                        <span aria-hidden="true" className={styles.thumbSpinner} />
                        <span aria-hidden="true" className={styles.thumbTrack}>
                          <i />
                        </span>
                        <small>Verifying the upload…</small>
                      </span>
                    ) : (
                      <span aria-hidden="true">
                        {item.status === "pending_revalidation"
                          ? "Needs validation"
                          : "Archived"}
                      </span>
                    )
                  ) : (
                    <>
                      {item.mediaType === "video/mp4" ? (
                        <video
                          aria-label={`${item.title} video preview`}
                          muted
                          playsInline
                          preload="metadata"
                          src={item.previewUrl}
                        />
                      ) : (
                        <img alt="" src={item.previewUrl} />
                      )}
                      {item.mediaType === "video/mp4" ? (
                        <span aria-hidden="true" className={styles.playBadge}>
                          <PlayGlyph />
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
                <span className={styles.cardCopy}>
                  <strong>{item.title}</strong>
                  <small>
                    {item.courseTitle} · used {item.usageCount}{" "}
                    {item.usageCount === 1 ? "time" : "times"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <aside className={styles.inspector}>
          {adding ? (
            <>
              <div className={styles.inspectorHead}>
                <div>
                  <p className={styles.inspectorKicker}>
                    {chartMode ? "Build a chart" : "Add visual knowledge"}
                  </p>
                  <h3>
                    {chartMode ? "Turn a small table into a visual" : "When should it show this?"}
                  </h3>
                </div>
                <Button
                  disabled={saving}
                  onClick={() => setAdding(false)}
                  size="sm"
                >
                  Cancel
                </Button>
              </div>
              <SelectField
                label="Attach to course"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    courseId: event.target.value,
                  }))
                }
                options={[
                  { value: "", label: "Choose a course" },
                  ...courses.map((course) => ({
                    value: course.courseId,
                    label: course.title,
                  })),
                ]}
                required
                value={draft.courseId}
              />
              <TextField
                label="Title"
                maxLength={160}
                onChange={(event) =>
                  {
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }));
                    if (chartMode) setChartAsset(null);
                  }
                }
                placeholder="Quarterly learning progress"
                required
                value={draft.title}
              />
              <TextAreaField
                help="This is what the assistant matches against."
                label="Describe it in a sentence"
                maxLength={2_000}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="What the chart or visual explains, and when it helps…"
                required
                rows={4}
                value={draft.description}
              />
              <TextAreaField
                help="Describe the meaning, not every decorative detail."
                label="Alt text for screen readers"
                maxLength={500}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    altText: event.target.value,
                  }))
                }
                required
                rows={3}
                value={draft.altText}
              />
              <Toggle
                bordered
                checked={draft.showInAnswers}
                description="Only when its searchable description genuinely matches."
                label="Show it in answers"
                onChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    showInAnswers: checked,
                  }))
                }
              />
              {draftError !== null ? (
                <p className={styles.validation}>{draftError}</p>
              ) : null}
              {chartMode ? (
                <>
                  <TextAreaField
                    help="CSV or tab-separated data: one label column, up to four numeric series, and no more than 24 rows."
                    label="Chart data"
                    maxLength={20_000}
                    onChange={(event) => {
                      setChartData(event.target.value);
                      setChartAsset(null);
                      setChartError(null);
                    }}
                    rows={8}
                    value={chartData}
                  />
                  <div className={styles.actions}>
                    <Button disabled={saving} onClick={generateChart}>
                      Generate preview
                    </Button>
                    <Button
                      disabled={
                        saving || draftError !== null || chartAsset === null
                      }
                      loading={saving}
                      loadingLabel="Validating…"
                      onClick={() => void publishChart()}
                      variant="primary"
                    >
                      Add chart
                    </Button>
                  </div>
                  {chartError !== null ? (
                    <p className={styles.validation} role="alert">
                      {chartError}
                    </p>
                  ) : null}
                  {actionError !== null ? (
                    <p className={styles.validation} role="alert">
                      {actionError}
                    </p>
                  ) : null}
                  {chartAsset !== null ? (
                    <img
                      alt={chartAsset.altText}
                      className={styles.largePreview}
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chartAsset.svg)}`}
                    />
                  ) : null}
                  {chartAsset !== null ? (
                    <div className={styles.studentPreview}>
                      <p className={styles.previewLabel}>
                        How it looks to a student
                      </p>
                      <div className={styles.previewBubble}>
                        <p>{draft.description}</p>
                        {previewMediaNode(
                          chartAsset.mediaType,
                          `data:image/svg+xml;charset=utf-8,${encodeURIComponent(chartAsset.svg)}`,
                          chartAsset.altText,
                        )}
                        <small>
                          From{" "}
                          {courses.find(
                            (course) => course.courseId === draft.courseId,
                          )?.title ?? "this course"}
                        </small>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <FileDrop
                  accept={ACCEPTED_MEDIA}
                  disabled={saving || draftError !== null}
                  help="The server verifies real file bytes before making anything answerable. SVG is restricted to inert chart and diagram primitives."
                  label="Visual file"
                  maxBytes={MAX_BYTES}
                  onUpload={upload}
                  placeholder="↑"
                />
              )}
            </>
          ) : selected !== null ? (
            <>
              <div className={styles.inspectorHead}>
                <div>
                  <p className={styles.inspectorKicker}>When should it show this?</p>
                  <h3>{selected.title}</h3>
                </div>
                <StateBadge
                  state={
                    selected.status === "active"
                      ? selected.showInAnswers
                        ? "known"
                        : "partial"
                      : "unknown"
                  }
                >
                  {selected.status === "active"
                    ? selected.showInAnswers
                      ? "Answerable"
                      : "Private"
                    : selected.status === "archived"
                      ? "Archived"
                      : selected.status === "pending_revalidation"
                        ? "Needs validation"
                        : "Pending"}
                </StateBadge>
              </div>
              {selected.previewUrl !== null ? (
                selected.mediaType === "video/mp4" ? (
                  <video
                    aria-label={selected.altText}
                    className={styles.largePreview}
                    controls
                    playsInline
                    preload="metadata"
                    src={selected.previewUrl}
                  />
                ) : (
                  <img
                    alt={selected.altText}
                    className={styles.largePreview}
                    src={selected.previewUrl}
                  />
                )
              ) : null}
              <SelectField
                disabled={selected.status !== "active" || saving}
                label="Attach to course"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    courseId: event.target.value,
                  }))
                }
                options={courses.map((course) => ({
                  value: course.courseId,
                  label: course.title,
                }))}
                value={draft.courseId}
              />
              <TextField
                disabled={selected.status !== "active" || saving}
                label="Title"
                maxLength={160}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                value={draft.title}
              />
              <TextAreaField
                disabled={selected.status !== "active" || saving}
                help="This is what the assistant matches against."
                label="Describe it in a sentence"
                maxLength={2_000}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                rows={4}
                value={draft.description}
              />
              <TextAreaField
                disabled={selected.status !== "active" || saving}
                label="Alt text for screen readers"
                maxLength={500}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    altText: event.target.value,
                  }))
                }
                rows={3}
                value={draft.altText}
              />
              <Toggle
                bordered
                checked={draft.showInAnswers}
                description="Only when its searchable description genuinely matches."
                disabled={selected.status !== "active" || saving}
                label="Show it in answers"
                onChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    showInAnswers: checked,
                  }))
                }
              />
              <p className={styles.meta}>
                {selected.visualKind === "chart" ? "Generated chart" : selected.mediaType} ·{" "}
                {selected.fileName} · {Math.max(1, Math.round(selected.sizeBytes / 1024))} KB
                · used {selected.usageCount}{" "}
                {selected.usageCount === 1 ? "time" : "times"}
              </p>
              {selected.previewUrl !== null ? (
                <div className={styles.studentPreview}>
                  <p className={styles.previewLabel}>
                    How it looks to a student
                  </p>
                  <div className={styles.previewBubble}>
                    <p>{selected.description}</p>
                    {previewMediaNode(
                      selected.mediaType,
                      selected.previewUrl,
                      selected.altText,
                    )}
                    {/* Attribution stops at the course: visual_assets has no
                        lesson reference, so a specific lesson (as the mockup
                        shows) cannot be named without inventing one. See the
                        report for what a lesson-level attach-to would need. */}
                    <small>From {selected.courseTitle}</small>
                  </div>
                </div>
              ) : null}
              {actionError !== null ? (
                <p className={styles.validation} role="alert">
                  {actionError}
                </p>
              ) : null}
              {message !== null ? (
                <p className={styles.success} role="status">
                  {message}
                </p>
              ) : null}
              {selected.status !== "archived" ? (
                <div className={styles.actions}>
                  {selected.status === "active" ? (
                    <Button
                      disabled={!dirty || draftError !== null || saving}
                      loading={saving}
                      loadingLabel="Saving…"
                      onClick={() => void saveSelected()}
                      variant="primary"
                    >
                      Save visual
                    </Button>
                  ) : null}
                  {selected.status === "pending_revalidation" ? (
                    <Button
                      loading={saving}
                      loadingLabel="Validating…"
                      onClick={() => void revalidateSelected()}
                      variant="primary"
                    >
                      Validate preserved file
                    </Button>
                  ) : null}
                  {!confirmArchive ? (
                    <Button
                      disabled={saving}
                      onClick={() => setConfirmArchive(true)}
                      variant="danger"
                    >
                      Archive
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {selected.status !== "archived" && confirmArchive ? (
                <div className={styles.archiveConfirm} role="alert">
                  <p>
                    Archive this visual? It disappears from retrieval immediately
                    but its private record remains available in archive history.
                  </p>
                  <div className={styles.actions}>
                    <Button
                      disabled={saving}
                      onClick={() => setConfirmArchive(false)}
                      size="sm"
                    >
                      Keep it
                    </Button>
                    <Button
                      loading={saving}
                      loadingLabel="Archiving…"
                      onClick={() => void archiveSelected()}
                      size="sm"
                      variant="danger"
                    >
                      Yes, archive
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.guide}>
              <p className={styles.inspectorKicker}>How it works</p>
              <h3>Make the picture findable</h3>
              <p>
                The description enters the same published knowledge retrieval as
                lesson text. The private file itself is served only through a
                short-lived signed read.
              </p>
              <div className={styles.studentPreview}>
                <p className={styles.previewLabel}>How it looks to a student</p>
                {/* Nothing is selected, so there is nothing real to preview
                    yet. This used to render fixed demo bars here regardless
                    of what — if anything — was selected, which read as a
                    chart even when you were looking at a photo or a clip.
                    Choose or add a visual to see its actual preview. */}
                <small>
                  Choose or add a visual to preview its learner presentation.
                </small>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export default VisualKnowledgeManager;
