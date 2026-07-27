"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { AvatarCharacter, AVATAR_POSES, type AvatarPose } from "./avatar-character";
import { Button, EmptyState, FileDrop } from "./ui";
import styles from "./avatar-studio.module.css";

/*
 * Studio review flow for generated character avatars (PLAN.md Section 7.1).
 *
 * This is deliberately its own component rather than more form state bolted
 * onto AgentConfigurator in sections/agent-panel.tsx: consent, generation and
 * review are a distinct workflow with their own server round trips, not
 * another field on the branding draft. It calls the routes under
 * apps/console/src/app/api/agent/avatar/ exclusively — never a vendor SDK,
 * never a second upload path (the consent photo goes through the existing
 * POST /api/agent/asset, kind "avatar-source").
 *
 * A failed, absent or still-generating avatar never blocks anything here:
 * every state below renders text and, at most, a disabled action — there is
 * no code path that leaves the panel unusable.
 */

// Mirrors the two exact statements
// infra/supabase/migrations/20260726100000_character_avatars.sql's
// agent_avatar_record_consent accepts. This is a redundant client-side
// display only — the database validates the exact text again, and the route
// (src/app/api/agent/avatar/route.ts) validates it a third time before
// spending anything.
const CONSENT_SELF_STATEMENT =
  "This is a photo of me. I consent to generating a stylized character likeness from it.";
const CONSENT_PERMISSION_STATEMENT =
  "This is a photo of someone else who has given me their permission to generate a stylized character likeness from it.";

const POSE_LABELS: Record<AvatarPose, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  unsure: "Unsure",
};

type PoseEntry = { storageKey: string | null; revisedPrompt: string | null; url: string | null };
type AvatarSetStatus = "pending_review" | "published" | "retired" | "rejected";

type AvatarSet = {
  avatarSetId: string;
  versionNumber: number;
  status: AvatarSetStatus;
  sourcePhotoUrl: string | null;
  poses: Partial<Record<AvatarPose, PoseEntry>>;
  createdAt: string | null;
  publishedAt: string | null;
};

const CODE_SENTENCES: Record<string, string> = {
  access_denied: "Only a workspace owner or admin can manage the character avatar.",
  consent_required: "Consent could not be recorded, so nothing was generated.",
  invalid_request: "That request could not be understood. Nothing was changed.",
  provider_not_configured:
    "Character avatars aren't configured on this deployment yet. An administrator needs to add an image generation key.",
  provider_failed:
    "The image generator could not finish the set. Nothing was published; you can try again.",
  request_denied: "The change could not be completed. Nothing was saved.",
  source_photo_unavailable: "The uploaded photo could not be read back. Try uploading it again.",
  spend_refused: "This workspace's assistant budget or rate limit stopped generation. Try again shortly.",
  tenant_selection_required: "Select a workspace first.",
};

function sentenceFor(code: string | null): string {
  return (code !== null && CODE_SENTENCES[code]) || "Something went wrong. Nothing was changed.";
}

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

function codeOf(value: unknown): string | null {
  return isRecord(value) && typeof value.code === "string" ? value.code : null;
}

function parsePoseEntry(value: unknown): PoseEntry {
  if (!isRecord(value)) return { storageKey: null, revisedPrompt: null, url: null };
  return {
    storageKey: typeof value.storageKey === "string" ? value.storageKey : null,
    revisedPrompt: typeof value.revisedPrompt === "string" ? value.revisedPrompt : null,
    url: typeof value.url === "string" ? value.url : null,
  };
}

function parseAvatarSet(value: unknown): AvatarSet | null {
  if (!isRecord(value) || typeof value.avatarSetId !== "string") return null;
  const posesRaw = isRecord(value.poses) ? value.poses : {};
  const poses: Partial<Record<AvatarPose, PoseEntry>> = {};
  for (const pose of AVATAR_POSES) {
    if (pose in posesRaw) poses[pose] = parsePoseEntry(posesRaw[pose]);
  }
  const status = typeof value.status === "string" ? value.status : "pending_review";
  return {
    avatarSetId: value.avatarSetId,
    versionNumber: typeof value.versionNumber === "number" ? value.versionNumber : 0,
    status: (["pending_review", "published", "retired", "rejected"] as const).includes(
      status as AvatarSetStatus,
    )
      ? (status as AvatarSetStatus)
      : "pending_review",
    sourcePhotoUrl: typeof value.sourcePhotoUrl === "string" ? value.sourcePhotoUrl : null,
    poses,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : null,
  };
}

function poseUrlsOf(set: AvatarSet | null | undefined) {
  const result: Partial<Record<AvatarPose, string | null>> = {};
  if (!set) return result;
  for (const pose of AVATAR_POSES) result[pose] = set.poses[pose]?.url ?? null;
  return result;
}

export type AvatarStudioProps = {
  /** brandInitial() fallback shown until a set is published. */
  readonly monogram: string;
  readonly assistantName: string;
  readonly disabled?: boolean;
};

export function AvatarStudio({ monogram, assistantName, disabled = false }: AvatarStudioProps) {
  const headingId = useId();
  const [sets, setSets] = useState<AvatarSet[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [consentChoice, setConsentChoice] = useState<"self" | "permission" | null>(null);
  const [sourcePhoto, setSourcePhoto] = useState<{ key: string; mediaType: string; url: string } | null>(
    null,
  );
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [previewPose, setPreviewPose] = useState<AvatarPose>("idle");
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/agent/avatar", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = await readJson(response);
      if (!response.ok || !isRecord(body) || !Array.isArray(body.sets)) {
        setLoadError(sentenceFor(codeOf(body)));
        setSets([]);
        return;
      }
      setSets(body.sets.map(parseAvatarSet).filter((set): set is AvatarSet => set !== null));
    } catch {
      setLoadError("The character avatar panel could not load. Nothing was changed.");
      setSets([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const published = sets?.find((set) => set.status === "published") ?? null;
  const pendingReview =
    sets
      ?.filter((set) => set.status === "pending_review")
      .sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;

  const uploadSourcePhoto = useCallback(async (file: File, onProgress: (ratio: number) => void) => {
    const created = await fetch("/api/agent/asset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "avatar-source",
        mediaType: file.type,
        sizeBytes: file.size,
      }),
    });
    const body = await readJson(created);
    if (!created.ok || !isRecord(body) || !isRecord(body.upload)) {
      throw new Error(sentenceFor(codeOf(body)));
    }
    const objectKey = typeof body.objectKey === "string" ? body.objectKey : null;
    const url = typeof body.upload.url === "string" ? body.upload.url : null;
    if (objectKey === null || url === null) {
      throw new Error("Storage did not return a usable upload location.");
    }
    const required = isRecord(body.upload.requiredHeaders) ? body.upload.requiredHeaders : {};
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(required)) {
      if (typeof value === "string") headers[name] = value;
    }
    onProgress(0.2);
    const put = await fetch(url, { method: "PUT", headers, body: file });
    if (!put.ok) throw new Error("Storage rejected the photo. It was not saved.");
    onProgress(1);
    setSourcePhoto({ key: objectKey, mediaType: file.type, url: URL.createObjectURL(file) });
    setActionError(null);
  }, []);

  const generate = useCallback(async () => {
    if (sourcePhoto === null || consentChoice === null) return;
    setGenerating(true);
    setActionError(null);
    try {
      const response = await fetch("/api/agent/avatar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourcePhotoStorageKey: sourcePhoto.key,
          sourcePhotoMediaType: sourcePhoto.mediaType,
          consent: {
            statement:
              consentChoice === "self" ? CONSENT_SELF_STATEMENT : CONSENT_PERMISSION_STATEMENT,
          },
        }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          isRecord(body) && typeof body.message === "string" ? body.message : sentenceFor(codeOf(body)),
        );
      }
      setSourcePhoto(null);
      setConsentChoice(null);
      setReloadToken((token) => token + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Generation failed. Nothing was saved.");
    } finally {
      setGenerating(false);
    }
  }, [consentChoice, sourcePhoto]);

  const review = useCallback(
    async (avatarSetId: string, decision: "publish" | "reject") => {
      setReviewing(avatarSetId);
      setActionError(null);
      try {
        const response = await fetch("/api/agent/avatar/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ avatarSetId, decision }),
        });
        const body = await readJson(response);
        if (!response.ok) throw new Error(sentenceFor(codeOf(body)));
        setReloadToken((token) => token + 1);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "The review decision failed.");
      } finally {
        setReviewing(null);
      }
    },
    [],
  );

  const previewSet = pendingReview ?? published;

  return (
    <section aria-labelledby={`${headingId}-avatar`} className={styles.group}>
      <h3 className={styles.groupTitle} id={`${headingId}-avatar`}>
        Character avatar
      </h3>
      <p className={styles.groupNote}>
        Generate a stylized character from your own photo. It animates between five poses as{" "}
        {assistantName || "the assistant"} listens, thinks, speaks and comes up empty — see it move
        below before you publish it.
      </p>

      <div className={styles.previewRow}>
        <div className={styles.previewFrame}>
          <AvatarCharacter monogram={monogram} pose={previewPose} poseUrls={poseUrlsOf(previewSet)} />
        </div>
        <div className={styles.previewControls}>
          <span className={styles.previewLabel}>Preview pose</span>
          <div className={styles.poseButtons}>
            {AVATAR_POSES.map((pose) => (
              <button
                aria-pressed={previewPose === pose}
                className={styles.poseButton}
                key={pose}
                onClick={() => setPreviewPose(pose)}
                type="button"
              >
                {POSE_LABELS[pose]}
              </button>
            ))}
          </div>
          {previewSet === null ? (
            <p className={styles.previewNote}>
              No avatar yet — this shows the monogram fallback, exactly like a student would see.
            </p>
          ) : previewSet.status === "pending_review" ? (
            <p className={styles.previewNote}>Awaiting your review below. Not visible to students yet.</p>
          ) : (
            <p className={styles.previewNote}>This is the live avatar.</p>
          )}
        </div>
      </div>

      {loadError !== null ? (
        <EmptyState description={loadError} headline="Could not load the character avatar" tone="error" />
      ) : null}

      {pendingReview !== null ? (
        <div className={styles.reviewCard}>
          <p className={styles.reviewHeadline}>
            A new set (version {pendingReview.versionNumber}) is ready to review.
          </p>
          <div className={styles.poseGrid}>
            {AVATAR_POSES.map((pose) => (
              <figure className={styles.poseTile} key={pose}>
                <div className={styles.poseTileImage}>
                  <AvatarCharacter monogram={monogram} pose={pose} poseUrls={poseUrlsOf(pendingReview)} />
                </div>
                <figcaption>{POSE_LABELS[pose]}</figcaption>
              </figure>
            ))}
          </div>
          <div className={styles.reviewActions}>
            <Button
              disabled={disabled || reviewing !== null}
              loading={reviewing === pendingReview.avatarSetId}
              onClick={() => void review(pendingReview.avatarSetId, "publish")}
              variant="primary"
            >
              Approve &amp; publish
            </Button>
            <Button
              disabled={disabled || reviewing !== null}
              onClick={() => void review(pendingReview.avatarSetId, "reject")}
              variant="ghost"
            >
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.generateCard}>
          <FileDrop
            accept={["image/png", "image/jpeg", "image/webp"]}
            disabled={disabled || generating}
            help="A clear photo of one person's face. Square, up to 2 MB."
            label="Your photo"
            onRemove={() => setSourcePhoto(null)}
            onUpload={uploadSourcePhoto}
            placeholder="Photo"
            previewUrl={sourcePhoto?.url}
          />

          <fieldset className={styles.consentFieldset} disabled={disabled || generating}>
            <legend className={styles.consentLegend}>
              Before generating, confirm who is in the photo. This is recorded, with your name and the
              time, so a later removal request is always answerable.
            </legend>
            <label className={styles.consentOption}>
              <input
                checked={consentChoice === "self"}
                name="avatar-consent"
                onChange={() => setConsentChoice("self")}
                type="radio"
                value="self"
              />
              <span>{CONSENT_SELF_STATEMENT}</span>
            </label>
            <label className={styles.consentOption}>
              <input
                checked={consentChoice === "permission"}
                name="avatar-consent"
                onChange={() => setConsentChoice("permission")}
                type="radio"
                value="permission"
              />
              <span>{CONSENT_PERMISSION_STATEMENT}</span>
            </label>
          </fieldset>

          {actionError !== null ? <p className={styles.error}>{actionError}</p> : null}

          <Button
            disabled={disabled || generating || sourcePhoto === null || consentChoice === null}
            fullWidth
            loading={generating}
            loadingLabel="Generating five poses — this can take a couple of minutes…"
            onClick={() => void generate()}
            variant="primary"
          >
            Generate character avatar
          </Button>
        </div>
      )}
    </section>
  );
}

export default AvatarStudio;
