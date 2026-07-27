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
    (result.published !== null && !isRecord(result.published)) ||
    (result.draft !== null && !isRecord(result.draft))
  ) {
    throw new AgentRpcError("invalid_response");
  }
  return result as unknown as AgentConfiguration;
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
    requested_publish: input.publish,
    expected_version: input.expectedVersion,
    ...operation,
  });
  if (response.error) {
    throw new AgentRpcError("request_failed");
  }
  return parseAgentConfigurationWrite(response.data);
}
