"use client";

import { type FormEvent, useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "../../lib/supabase/client";
import styles from "./workspace.module.css";

type Course = { courseId: string; title: string };
type UploadItem = {
  intentId: string;
  filename: string;
  uploadStatus: string;
  ingestionStatus: string | null;
  nextCheckpoint: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default function UploadLearning({ courses }: { courses: Course[] }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    try {
      const response = await fetch("/api/learning/uploads", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isRecord(payload) || !Array.isArray(payload.items)) {
        throw new Error("Upload history is temporarily unavailable.");
      }
      setItems(payload.items as UploadItem[]);
    } catch {
      setMessage(
        "Upload history is temporarily unavailable. Your existing files remain private.",
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    const courseId = String(data.get("courseId") ?? "");
    if (!(file instanceof File) || !file.size || !courseId) return;
    setBusy(true);
    setMessage("Creating a private upload…");
    try {
      const intentResponse = await fetch("/api/learning/uploads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId,
          filename: file.name,
          mediaType: file.type || "text/plain",
          sizeBytes: file.size,
        }),
      });
      const intent = (await intentResponse.json()) as unknown;
      if (
        !intentResponse.ok ||
        !isRecord(intent) ||
        typeof intent.intentId !== "string" ||
        typeof intent.path !== "string" ||
        typeof intent.token !== "string" ||
        typeof intent.bucket !== "string"
      ) {
        throw new Error("The signed upload could not be created.");
      }
      setMessage("Uploading into private quarantine…");
      const supabase = createBrowserSupabaseClient();
      const uploaded = await supabase.storage
        .from(intent.bucket)
        .uploadToSignedUrl(intent.path, intent.token, file, {
          contentType: file.type || "text/plain",
          upsert: false,
        });
      if (uploaded.error) {
        throw new Error("The file could not be uploaded.");
      }
      const confirmed = await fetch(
        `/api/learning/uploads/${intent.intentId}/confirm`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ courseId }),
        },
      );
      if (!confirmed.ok) {
        throw new Error("The uploaded file could not be verified.");
      }
      form.reset();
      setMessage(
        "Upload verified. It is quarantined and waiting for malware scanning; it is not learner-visible yet.",
      );
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The upload could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.uploadPanel}>
      <form onSubmit={submit}>
        <label>
          <span>Course</span>
          <select name="courseId" required disabled={busy}>
            <option value="">Choose a course</option>
            {courses.map((course) => (
              <option key={course.courseId} value={course.courseId}>
                {course.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Source file</span>
          <input
            name="file"
            type="file"
            accept=".pdf,.txt,.md,.docx"
            required
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy || courses.length === 0}>
          {busy ? "Uploading…" : "Upload source"}
        </button>
      </form>
      <p role="status">
        {message ??
          "PDF, text, Markdown, or Word up to 25 MB. Files stay private in quarantine until security scanning succeeds."}
      </p>
      {items.length ? (
        <div className={styles.uploadList}>
          {items.slice(0, 5).map((item) => (
            <article key={item.intentId}>
              <span aria-hidden="true">↥</span>
              <div>
                <b>{item.filename}</b>
                <small>
                  {item.ingestionStatus
                    ? `${item.ingestionStatus} · ${item.nextCheckpoint ?? "pipeline"}`
                    : item.uploadStatus}
                </small>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
