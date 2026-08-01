import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";

const poses = ["idle", "listening", "thinking", "speaking", "unsure"] as const;
const readTtlSeconds = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function signPose(
  supabase: SupabaseClient,
  avatar: Record<string, unknown>,
  pose: (typeof poses)[number],
) {
  const poseMap = isRecord(avatar.poses) ? avatar.poses : {};
  const entry = isRecord(poseMap[pose]) ? poseMap[pose] : null;
  const storageKey = typeof entry?.storageKey === "string" ? entry.storageKey : "";
  if (!storageKey) return [pose, null] as const;
  const signed = await supabase.storage
    .from("tenant-private")
    .createSignedUrl(storageKey, readTtlSeconds);
  return [pose, signed.error ? null : signed.data?.signedUrl ?? null] as const;
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const result = await executeLearningRpc(
      supabase,
      "learning_get_published_avatar",
    );
    const avatar = isRecord(result.avatar) ? result.avatar : null;
    const poseUrls = avatar
      ? Object.fromEntries(
          await Promise.all(poses.map((pose) => signPose(supabase, avatar, pose))),
        )
      : {};
    return NextResponse.json(
      {
        ok: true,
        avatarSetId:
          avatar && typeof avatar.avatarSetId === "string"
            ? avatar.avatarSetId
            : null,
        poseUrls,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthenticationBoundaryError) {
      const classified = classifyAuthBoundaryError(error);
      return NextResponse.json(
        { ok: false, code: classified.code },
        { status: classified.status },
      );
    }
    return NextResponse.json(
      { ok: false, code: "request_failed" },
      { status: 503 },
    );
  }
}
