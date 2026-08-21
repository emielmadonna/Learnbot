"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DragEvent } from "react";

import styles from "./file-drop.module.css";
import tokens from "./tokens.module.css";
import { cx } from "./cx";

export type FileDropStatus = "idle" | "uploading" | "uploaded" | "error";

export type FileDropProps = {
  readonly label: string;
  /**
   * Performs the upload. Report 0–1 through onProgress when the transport can
   * measure it; resolve on success and reject with an Error to surface a
   * message. This component never fetches on its own.
   */
  readonly onUpload: (
    file: File,
    onProgress: (ratio: number) => void,
  ) => Promise<void>;
  /** Already-stored image shown when nothing is staged locally. */
  readonly previewUrl?: string | null | undefined;
  /** Placeholder glyph or initials when there is no image at all. */
  readonly placeholder?: string | undefined;
  readonly help?: string | undefined;
  /** Accepted MIME types. Defaults to the common web image formats. */
  readonly accept?: readonly string[] | undefined;
  /** Rejection threshold in bytes. Defaults to 2 MB. */
  readonly maxBytes?: number | undefined;
  readonly onRemove?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
};

const DEFAULT_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
] as const;

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function shortTypes(accept: readonly string[]): string {
  return accept
    .map((type) => type.split("/")[1]?.replace("+xml", "").toUpperCase() ?? type)
    .join(" · ");
}

/**
 * Drag-and-drop image upload with preview, validation and progress.
 * Presentational only — the caller owns the transport via onUpload.
 */
export function FileDrop({
  label,
  onUpload,
  previewUrl,
  placeholder = "—",
  help,
  accept = DEFAULT_ACCEPT,
  maxBytes = DEFAULT_MAX_BYTES,
  onRemove,
  disabled = false,
  id,
  className,
}: FileDropProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-file`;
  const helpId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<FileDropStatus>("idle");
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [staged, setStaged] = useState<{
    name: string;
    url: string;
  }>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (staged?.url) URL.revokeObjectURL(staged.url);
    },
    [staged],
  );

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (file === undefined || disabled) return;
      const typeAllowed =
        file.type === ""
          ? accept.some((type) =>
              file.name
                .toLowerCase()
                .endsWith(`.${type.split("/")[1]?.replace("+xml", "") ?? ""}`),
            )
          : accept.includes(file.type);
      if (!typeAllowed) {
        setStatus("error");
        setError(`${label} must be one of ${shortTypes(accept)}.`);
        return;
      }
      if (file.size > maxBytes) {
        setStatus("error");
        setError(
          `${formatBytes(file.size)} is over the ${formatBytes(maxBytes)} limit.`,
        );
        return;
      }

      const locallyPreviewable = [
        "image/jpeg",
        "image/png",
        "image/webp",
      ].includes(file.type);
      setStaged({
        name: file.name,
        url: locallyPreviewable ? URL.createObjectURL(file) : "",
      });
      setError(undefined);
      setProgress(undefined);
      setStatus("uploading");

      try {
        await onUpload(file, (ratio) => {
          if (mounted.current) setProgress(Math.min(1, Math.max(0, ratio)));
        });
        if (!mounted.current) return;
        setProgress(1);
        setStatus("uploaded");
      } catch (reason) {
        if (!mounted.current) return;
        setStatus("error");
        setError(
          reason instanceof Error
            ? reason.message
            : "The upload did not complete.",
        );
      }
    },
    [accept, disabled, label, maxBytes, onUpload],
  );

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files[0]);
  }

  const shownUrl = staged
    ? staged.url || undefined
    : previewUrl ?? undefined;
  const uploading = status === "uploading";

  return (
    <div
      className={cx(tokens.uiRoot, styles.fileDrop, className)}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDrop={onDrop}
    >
      <span className={styles.label} id={`${controlId}-label`}>
        {label}
      </span>
      <button
        aria-describedby={
          cx(
            help !== undefined ? helpId : "",
            error !== undefined ? errorId : "",
          ) || undefined
        }
        aria-labelledby={`${controlId}-label`}
        className={cx(styles.zone, dragging && styles.dragging)}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        {shownUrl === undefined ? (
          <span className={styles.placeholder}>{placeholder}</span>
        ) : (
          <span className={styles.preview}>
            {/* Object and data URLs of unknown size — not routable through next/image. */}
            <img alt="" src={shownUrl} />
          </span>
        )}
        <span className={styles.copy}>
          <strong>
            {staged?.name ??
              (shownUrl === undefined ? "Drop a file or browse" : "Current file")}
          </strong>
          {uploading ? (
            <span className={styles.progressTrack}>
              <span
                className={cx(
                  styles.progressFill,
                  progress === undefined && styles.progressIndeterminate,
                )}
                style={
                  progress === undefined
                    ? undefined
                    : { width: `${Math.round(progress * 100)}%` }
                }
              />
            </span>
          ) : (
            <small>
              {shortTypes(accept)} · up to {formatBytes(maxBytes)}
            </small>
          )}
        </span>
        <span className={styles.cue}>
          {uploading
            ? progress === undefined
              ? "Uploading"
              : `${Math.round(progress * 100)}%`
            : shownUrl === undefined
              ? "Browse"
              : "Replace"}
        </span>
      </button>
      <input
        accept={accept.join(",")}
        className={styles.hiddenInput}
        disabled={disabled}
        id={controlId}
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
          event.target.value = "";
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      <span className={styles.footRow}>
        {error !== undefined ? (
          <span className={styles.error} id={errorId} role="alert">
            {error}
          </span>
        ) : help !== undefined ? (
          <span className={styles.help} id={helpId}>
            {help}
          </span>
        ) : (
          <span />
        )}
        {onRemove !== undefined && shownUrl !== undefined && !uploading && (
          <button
            className={styles.remove}
            disabled={disabled}
            onClick={() => {
              setStaged(undefined);
              setStatus("idle");
              setProgress(undefined);
              setError(undefined);
              onRemove();
            }}
            type="button"
          >
            Remove
          </button>
        )}
      </span>
    </div>
  );
}

export default FileDrop;
