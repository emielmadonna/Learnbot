import type { SupabaseClient } from "@supabase/supabase-js";

export const agentToneOptions = [
  "neutral",
  "friendly",
  "encouraging",
  "professional",
  "socratic",
  "concise",
] as const;

export type AgentTone = (typeof agentToneOptions)[number];

/** Either every published course, or an explicit allow-list of course ids. */
export type AgentCourseScope = "all" | string[];

export const agentEscalationTriggerOptions = [
  "manual",
  "always_available",
  "after_no_results",
  "after_repeated_question",
] as const;

export type AgentEscalationTrigger =
  (typeof agentEscalationTriggerOptions)[number];

export type AgentConfigurationVersion = {
  brandingId: string;
  status: "draft" | "published" | "retired";
  version: number;
  assistantName: string;
  iconGlyph: string | null;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  welcomeMessage: string;
  personaInstructions: string | null;
  tone: AgentTone;
  voice: string | null;
  courseScope: AgentCourseScope;
  logoStorageKey: string | null;
  avatarStorageKey: string | null;
  privacyCopy: string | null;
  /** Platform-allowed model id. Never a free-text value. */
  model: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  /** Long-form free-text guidance, layered on top of personaInstructions. */
  extendedInstructions: string | null;
  voiceEnabled: boolean;
  voiceSpeakingRate: number;
  voiceBargeInEnabled: boolean;
  retrievalCount: number;
  retrievalSimilarityFloor: number;
  /** Wording only — whether an empty retrieval refuses is not configurable. */
  noResultsMessage: string;
  escalationEnabled: boolean;
  escalationTrigger: AgentEscalationTrigger;
  escalationMessage: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type AgentConfiguration = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  expectedVersion: number;
  published: AgentConfigurationVersion | null;
  draft: AgentConfigurationVersion | null;
  defaults: Record<string, unknown>;
  toneOptions: string[];
  modelOptions: string[];
  escalationTriggerOptions: string[];
  assetPrefix: string;
};

export type AgentConfigurationInput = {
  assistantName: string;
  iconGlyph: string | null;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  welcomeMessage: string;
  personaInstructions: string | null;
  tone: string;
  voice: string | null;
  courseScope: AgentCourseScope;
  logoStorageKey: string | null;
  avatarStorageKey: string | null;
  model: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  extendedInstructions: string | null;
  voiceEnabled: boolean;
  voiceSpeakingRate: number;
  voiceBargeInEnabled: boolean;
  retrievalCount: number;
  retrievalSimilarityFloor: number;
  noResultsMessage: string;
  escalationEnabled: boolean;
  escalationTrigger: string;
  escalationMessage: string | null;
  publish: boolean;
  expectedVersion: number;
};

export type AgentConfigurationWrite = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  expectedVersion: number;
  configuration: AgentConfigurationVersion;
};

export type AgentConfigurationRevisionSummary = {
  version: number;
  status: "draft" | "published" | "retired";
  assistantName: string;
  welcomeMessage: string;
  tone: string;
  model: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentConfigurationRevisions = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  revisions: AgentConfigurationRevisionSummary[];
};

export type AgentConfigurationRollbackInput = {
  targetVersion: number;
  publish: boolean;
  expectedVersion: number;
};

export class AgentRpcError extends Error {
  constructor(readonly code: string) {
    super(`Agent configuration request denied: ${code}`);
    this.name = "AgentRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireAgentRpcSuccess(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new AgentRpcError("invalid_response");
  if (value.ok !== true) {
    throw new AgentRpcError(
      typeof value.code === "string" ? value.code : "request_denied",
    );
  }
  return value;
}

export function parseAgentConfiguration(value: unknown): AgentConfiguration {
  const result = requireAgentRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    typeof result.tenantId !== "string" ||
    typeof result.expectedVersion !== "number" ||
    typeof result.assetPrefix !== "string" ||
    !Array.isArray(result.toneOptions) ||
    !Array.isArray(result.modelOptions) ||
    !Array.isArray(result.escalationTriggerOptions) ||
    (result.published !== null && !isRecord(result.published)) ||
    (result.draft !== null && !isRecord(result.draft))
  ) {
    throw new AgentRpcError("invalid_response");
  }
  return result as unknown as AgentConfiguration;
}

export function parseAgentConfigurationRevisions(
  value: unknown,
): AgentConfigurationRevisions {
  const result = requireAgentRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    typeof result.tenantId !== "string" ||
    !Array.isArray(result.revisions)
  ) {
    throw new AgentRpcError("invalid_response");
  }
  return result as unknown as AgentConfigurationRevisions;
}

export function parseAgentConfigurationWrite(
  value: unknown,
): AgentConfigurationWrite {
  const result = requireAgentRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    typeof result.tenantId !== "string" ||
    typeof result.expectedVersion !== "number" ||
    !isRecord(result.configuration)
  ) {
    throw new AgentRpcError("invalid_response");
  }
  return result as unknown as AgentConfigurationWrite;
}

/** The head version an editor must echo back to write without conflict. */
export function agentExpectedVersion(configuration: AgentConfiguration) {
  return configuration.expectedVersion;
}

/**
 * The version an editor should render: the head of the version chain.
 *
 * "draft ?? published" is wrong after a publish. Publishing appends a new
 * `published` row and retires the previous live one, but it leaves every older
 * `draft` row in place, so preferring the draft resurrects a superseded
 * version — and signs its asset keys — even though `expectedVersion` has moved
 * past it. The row whose `version` equals `expectedVersion` is the head; if
 * neither matches, the higher version number wins.
 */
export function agentEditableVersion(
  configuration: AgentConfiguration,
): AgentConfigurationVersion | null {
  const draft = configuration.draft;
  const published = configuration.published;
  if (draft?.version === configuration.expectedVersion) return draft;
  if (published?.version === configuration.expectedVersion) return published;
  if (draft === null) return published;
  if (published === null) return draft;
  return draft.version >= published.version ? draft : published;
}

export function agentOperationFields(prefix: string) {
  const operationId = crypto.randomUUID();
  return {
    idempotency_key: `${prefix}:${operationId}`,
    request_id: `${prefix}:${operationId}`,
    trace_id: `web:${operationId}`,
  };
}

export async function getAgentConfiguration(
  supabase: SupabaseClient,
): Promise<AgentConfiguration> {
  const response = await supabase.rpc("tenant_get_agent_configuration");
  if (response.error) {
    // The RPC itself could not run: it is missing, not granted, or the
    // database refused it. That is an unavailable capability, not a failed
    // sign-in, and it must never be reported as one.
    throw new AgentRpcError("request_failed");
  }
  return parseAgentConfiguration(response.data);
}

export async function updateAgentConfiguration(
  supabase: SupabaseClient,
  input: AgentConfigurationInput,
  operation: ReturnType<typeof agentOperationFields>,
): Promise<AgentConfigurationWrite> {
  const response = await supabase.rpc("tenant_update_agent_configuration", {
    requested_assistant_name: input.assistantName,
    requested_icon_glyph: input.iconGlyph,
    requested_primary_color: input.primaryColor,
    requested_accent_color: input.accentColor,
    requested_surface_color: input.surfaceColor,
    requested_text_color: input.textColor,
    requested_welcome_message: input.welcomeMessage,
    requested_persona_instructions: input.personaInstructions,
    requested_agent_tone: input.tone,
    requested_agent_voice: input.voice,
    requested_course_scope: input.courseScope,
    requested_logo_storage_key: input.logoStorageKey,
    requested_avatar_storage_key: input.avatarStorageKey,
    requested_model: input.model,
    requested_temperature: input.temperature,
    requested_top_p: input.topP,
    requested_max_output_tokens: input.maxOutputTokens,
    requested_extended_instructions: input.extendedInstructions,
    requested_voice_enabled: input.voiceEnabled,
    requested_voice_speaking_rate: input.voiceSpeakingRate,
    requested_voice_barge_in_enabled: input.voiceBargeInEnabled,
    requested_retrieval_count: input.retrievalCount,
    requested_retrieval_similarity_floor: input.retrievalSimilarityFloor,
    requested_no_results_message: input.noResultsMessage,
    requested_escalation_enabled: input.escalationEnabled,
    requested_escalation_trigger: input.escalationTrigger,
    requested_escalation_message: input.escalationMessage,
    requested_publish: input.publish,
    expected_version: input.expectedVersion,
    ...operation,
  });
  if (response.error) {
    throw new AgentRpcError("request_failed");
  }
  return parseAgentConfigurationWrite(response.data);
}

export async function listAgentConfigurationRevisions(
  supabase: SupabaseClient,
): Promise<AgentConfigurationRevisions> {
  const response = await supabase.rpc(
    "tenant_list_agent_configuration_revisions",
  );
  if (response.error) {
    throw new AgentRpcError("request_failed");
  }
  return parseAgentConfigurationRevisions(response.data);
}

export async function rollbackAgentConfiguration(
  supabase: SupabaseClient,
  input: AgentConfigurationRollbackInput,
  operation: ReturnType<typeof agentOperationFields>,
): Promise<AgentConfigurationWrite> {
  const response = await supabase.rpc(
    "tenant_rollback_agent_configuration",
    {
      target_version: input.targetVersion,
      requested_publish: input.publish,
      expected_version: input.expectedVersion,
      ...operation,
    },
  );
  if (response.error) {
    throw new AgentRpcError("request_failed");
  }
  return parseAgentConfigurationWrite(response.data);
}
