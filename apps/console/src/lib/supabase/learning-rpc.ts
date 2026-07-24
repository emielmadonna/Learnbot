import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthenticationBoundaryError } from "./auth-boundary";

export type LearningBlock = {
  contentBlockId: string;
  type: string;
  position: number;
  content: Record<string, unknown>;
};

export type LearningLesson = {
  lessonId: string;
  title: string;
  position: number;
  status: string;
  progressState: "not_started" | "in_progress" | "completed";
  blocks: LearningBlock[];
};

export type LearningModule = {
  moduleId: string;
  title: string;
  position: number;
  status: string;
  lessons: LearningLesson[];
};

export type LearningCourse = {
  courseId: string;
  title: string;
  description: string | null;
  status: string;
  recordVersion: number;
  progress: {
    state: string;
    lessonsCompleted: number;
    lessonsTotal: number;
    percentComplete: number;
    lastActivityAt: string | null;
  };
  modules: LearningModule[];
};

export type LearningWorkspace = {
  ok: true;
  dataMode: "durable";
  tenant: {
    tenantId: string;
    slug: string;
    displayName: string;
    status: string;
  };
  identity: {
    role: string;
    canAuthor: boolean;
  };
  branding: {
    assistantName: string;
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
    textColor: string;
    welcomeMessage: string;
  } | null;
  courses: LearningCourse[];
};

export class LearningRpcError extends Error {
  constructor(readonly code: string) {
    super(`Learning request denied: ${code}`);
    this.name = "LearningRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireLearningRpcSuccess(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new LearningRpcError("invalid_response");
  if (value.ok !== true) {
    throw new LearningRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  return value;
}

export function parseLearningWorkspace(value: unknown): LearningWorkspace {
  const result = requireLearningRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    !isRecord(result.tenant) ||
    !isRecord(result.identity) ||
    !Array.isArray(result.courses)
  ) {
    throw new LearningRpcError("invalid_response");
  }
  return result as unknown as LearningWorkspace;
}

export async function getLearningWorkspace(
  supabase: SupabaseClient,
): Promise<LearningWorkspace> {
  const response = await supabase.rpc("learning_get_workspace");
  if (response.error) {
    throw new AuthenticationBoundaryError(
      "learning.workspace_failed",
      "The durable learning workspace could not be loaded.",
    );
  }
  return parseLearningWorkspace(response.data);
}

export function learningOperationKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}
