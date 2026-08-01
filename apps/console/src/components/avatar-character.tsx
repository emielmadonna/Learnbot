"use client";

import { useMemo } from "react";
import styles from "./avatar-character.module.css";

export const AVATAR_POSES = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "unsure",
] as const;

export type AvatarPose = (typeof AVATAR_POSES)[number];

export type AvatarPoseUrls = Partial<Record<AvatarPose, string | null | undefined>>;

export type AvatarCharacterProps = {
  /** Signed read URLs, keyed by pose. A missing or null entry falls back to
   * the monogram for that pose — generation in progress, rejected, or never
   * configured are all the same "no image yet" case from here. */
  readonly poseUrls: AvatarPoseUrls;
  /** The app state to render (PLAN.md Section 7.1's five real states). */
  readonly pose: AvatarPose;
  /** brandInitial() fallback — see components/app-shell/brand.ts. */
  readonly monogram: string;
  /** Accessible name. Omit to keep the character purely decorative. */
  readonly label?: string;
  readonly className?: string;
  /** Adds a restrained hover/focus reaction for launcher-sized characters. */
  readonly interactive?: boolean;
};

const poseClass: Record<AvatarPose, string | undefined> = {
  idle: styles.poseIdle,
  listening: styles.poseListening,
  thinking: styles.poseThinking,
  speaking: styles.poseSpeaking,
  unsure: styles.poseUnsure,
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/**
 * The generated character avatar (PLAN.md Section 7.1). Presentational
 * only — it never fetches and never decides which pose is "current"; a
 * caller drives that from real app state (voice active, request sent and no
 * token yet, tokens streaming, retrieval empty). A missing, still-generating
 * or unconfigured avatar always falls back to the monogram: this component
 * can be mounted with an empty `poseUrls` and render exactly what
 * `brandInitial()` already renders elsewhere, so nothing that depends on it
 * can block chat from rendering.
 *
 * Animation is transform and opacity only — idle head-bob, a tilt into
 * `listening`, cross-fade between poses, a small squash-and-stretch on
 * `speaking` — cheap enough to run inside someone else's page. Under
 * `prefers-reduced-motion` the character holds `idle` and does not move;
 * that is enforced in avatar-character.module.css so it holds regardless of
 * which `pose` prop is passed, even before any JavaScript runs.
 */
export function AvatarCharacter({
  poseUrls,
  pose,
  monogram,
  label,
  className,
  interactive = false,
}: AvatarCharacterProps) {
  const layers = useMemo(
    () =>
      AVATAR_POSES.map((candidate) => ({
        pose: candidate,
        url: poseUrls[candidate] ?? null,
      })).filter(
        (layer): layer is { pose: AvatarPose; url: string } => layer.url !== null,
      ),
    [poseUrls],
  );
  const activeUrl = poseUrls[pose] ?? poseUrls.idle ?? null;
  const hasAnyImage = layers.length > 0;

  return (
    <span
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      className={cx(
        styles.root,
        poseClass[pose],
        interactive && styles.interactive,
        className,
      )}
      role={label === undefined ? undefined : "img"}
      tabIndex={interactive ? 0 : undefined}
    >
      <span className={styles.stage}>
        {hasAnyImage ? (
          layers.map((layer) => (
            <img
              alt=""
              className={cx(
                styles.layer,
                layer.pose === pose ? styles.layerActive : styles.layerHidden,
              )}
              data-pose={layer.pose}
              key={layer.pose}
              src={layer.url}
            />
          ))
        ) : (
          <span className={styles.monogram}>{monogram}</span>
        )}
        {hasAnyImage && activeUrl === null ? (
          <span className={styles.monogramOverlay}>{monogram}</span>
        ) : null}
      </span>
    </span>
  );
}

export default AvatarCharacter;
