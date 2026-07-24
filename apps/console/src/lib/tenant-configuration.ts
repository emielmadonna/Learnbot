import type { SupabaseClient } from "@supabase/supabase-js";

import type { TenantContext } from "./supabase/auth-boundary";

export const CONFIGURATION_VERSION = 1;

export const PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "development-local", label: "Development local" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export const ICON_OPTIONS = [
  { id: "spark", label: "Spark", glyph: "✦" },
  { id: "orbit", label: "Orbit", glyph: "◌" },
  { id: "leaf", label: "Leaf", glyph: "❧" },
  { id: "book", label: "Book", glyph: "▤" },
] as const;

export type IconId = (typeof ICON_OPTIONS)[number]["id"];
export type VoiceId = "harbor" | "meadow" | "sol";

export type TenantConfiguration = {
  version: typeof CONFIGURATION_VERSION;
  tenant: {
    id: string;
    slug: string;
    displayName: string;
  };
  permissions: {
    canManage: boolean;
  };
  provider: {
    provider: ProviderId;
    model: string;
  };
  credentials: {
    provider: "openai";
    configured: boolean;
    scope: "deployment" | "tenant" | "none";
    vaultReferencePresent: boolean;
    durableTenantStorage: boolean;
    rawValueReturned: false;
  };
  voiceGuide: {
    enabled: boolean;
    voice: VoiceId;
    guide: string;
  };
  assistant: {
    name: string;
    welcome: string;
    icon: IconId;
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
    textColor: string;
  };
  featureGates: {
    analytics: boolean;
    voice: boolean;
    uploads: boolean;
    contextMapping: boolean;
  };
  revision: {
    tenant: number;
    branding: number;
  };
  persistence: {
    configuration: "durable";
    secrets: "durable" | "not_available";
  };
};

export type TenantConfigurationPatch = {
  provider: ProviderId;
  model: string;
  voiceGuide: TenantConfiguration["voiceGuide"];
  assistant: TenantConfiguration["assistant"];
  featureGates: TenantConfiguration["featureGates"];
  apiKey?: string;
  clearApiKey?: boolean;
  expectedTenantRevision: number;
  expectedBrandingRevision: number;
};

const DEFAULTS = {
  provider: "openai" as ProviderId,
  model: "gpt-4o-mini",
  voice: "harbor" as VoiceId,
  voiceGuide:
    "Warm, concise, and encouraging. Ask one useful follow-up when the learner needs a next step.",
  assistantName: "LearningBot",
  welcome: "How can I help you learn today?",
  icon: "spark" as IconId,
  primaryColor: "#315F50",
  accentColor: "#D8A653",
  surfaceColor: "#FFFDF8",
  textColor: "#17201B",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function providerValue(value: unknown): ProviderId {
  return value === "development-local" ? "development-local" : "openai";
}

function voiceValue(value: unknown): VoiceId {
  return value === "meadow" || value === "sol" ? value : "harbor";
}

function iconValue(value: unknown): IconId {
  return value === "orbit" || value === "leaf" || value === "book"
    ? value
    : "spark";
}

function hexValue(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toUpperCase()
    : fallback;
}

function safeModel(value: unknown) {
  const model = stringValue(value, DEFAULTS.model);
  return /^[a-z0-9._:-]{2,120}$/iu.test(model) ? model : DEFAULTS.model;
}

function safeSettings(value: unknown) {
  return isRecord(value) ? value : {};
}

function safeNestedSettings(settings: Record<string, unknown>) {
  return isRecord(settings.learningBot) ? settings.learningBot : {};
}

function credentialStatus(
  vaultReferencePresent: boolean,
): TenantConfiguration["credentials"] {
  return {
    provider: "openai",
    configured: vaultReferencePresent,
    scope: vaultReferencePresent ? "tenant" : "deployment",
    vaultReferencePresent,
    durableTenantStorage: vaultReferencePresent,
    rawValueReturned: false,
  };
}

export function parseTenantConfiguration(input: {
  tenant: Record<string, unknown>;
  branding?: Record<string, unknown> | null;
  role: string | null;
}): TenantConfiguration {
  const settings = safeSettings(input.tenant.settings);
  const learningBot = safeNestedSettings(settings);
  const storedConfiguration = isRecord(settings.configuration)
    ? settings.configuration
    : {};
  const featureGates = isRecord(learningBot.featureGates)
    ? learningBot.featureGates
    : {};
  const durableProvider = storedConfiguration.provider ?? learningBot.provider;
  const durableModel = storedConfiguration.model ?? learningBot.model;
  const durableFeatureGates = isRecord(storedConfiguration.featureGates)
    ? storedConfiguration.featureGates
    : featureGates;
  const branding = input.branding ?? {};
  const voiceConfiguration = isRecord(branding.voice_configuration)
    ? branding.voice_configuration
    : {};

  const provider = providerValue(durableProvider);
  const vaultReferencePresent =
    typeof storedConfiguration.credential_vault_ref === "string" &&
    /^vault:\/\/[a-z0-9/_:.~-]{3,240}$/iu.test(
      storedConfiguration.credential_vault_ref,
    );
  return {
    version: CONFIGURATION_VERSION,
    tenant: {
      id: stringValue(input.tenant.tenant_id, ""),
      slug: stringValue(input.tenant.slug, "workspace"),
      displayName: stringValue(input.tenant.display_name, "Learning workspace"),
    },
    permissions: {
      canManage: input.role === "tenant_owner" || input.role === "tenant_admin",
    },
    provider: {
      provider,
      model: safeModel(durableModel),
    },
    credentials: credentialStatus(vaultReferencePresent),
    voiceGuide: {
      enabled: booleanValue(voiceConfiguration.enabled, true),
      voice: voiceValue(voiceConfiguration.voiceId),
      guide: stringValue(voiceConfiguration.guide, DEFAULTS.voiceGuide),
    },
    assistant: {
      name: stringValue(branding.assistant_name, DEFAULTS.assistantName),
      welcome: stringValue(branding.welcome_message, DEFAULTS.welcome),
      icon: iconValue(learningBot.icon),
      primaryColor: hexValue(branding.primary_color, DEFAULTS.primaryColor),
      accentColor: hexValue(branding.accent_color, DEFAULTS.accentColor),
      surfaceColor: hexValue(branding.surface_color, DEFAULTS.surfaceColor),
      textColor: hexValue(branding.text_color, DEFAULTS.textColor),
    },
    featureGates: {
      analytics: booleanValue(durableFeatureGates.analytics, true),
      voice: booleanValue(durableFeatureGates.voice, true),
      uploads: booleanValue(durableFeatureGates.uploads, true),
      contextMapping: booleanValue(durableFeatureGates.contextMapping, true),
    },
    revision: {
      tenant: Number(input.tenant.record_version) || 1,
      branding: Number(branding.record_version) || 1,
    },
    persistence: {
      configuration: "durable",
      secrets: vaultReferencePresent ? "durable" : "not_available",
    },
  };
}

export function validateTenantConfigurationPatch(
  value: unknown,
): TenantConfigurationPatch {
  if (!isRecord(value)) throw new TenantConfigurationError("invalid_request");
  if (
    "api_key" in value ||
    "secret" in value ||
    "credential" in value ||
    "credentials" in value
  ) {
    throw new TenantConfigurationError("secret_write_not_supported");
  }
  const provider = providerValue(value.provider);
  const model = safeModel(value.model);
  if (typeof value.model !== "string" || value.model.trim() !== model) {
    throw new TenantConfigurationError("invalid_model");
  }
  const voiceGuide = isRecord(value.voiceGuide) ? value.voiceGuide : {};
  const assistant = isRecord(value.assistant) ? value.assistant : {};
  const featureGates = isRecord(value.featureGates) ? value.featureGates : {};
  const apiKey = "apiKey" in value
    ? typeof value.apiKey === "string" && /^[\x20-\x7e]{20,500}$/u.test(value.apiKey.trim())
      ? value.apiKey.trim()
      : null
    : undefined;
  if ("apiKey" in value && apiKey === null) {
    throw new TenantConfigurationError("invalid_credential");
  }
  const clearApiKey = "clearApiKey" in value ? value.clearApiKey : false;
  if (typeof clearApiKey !== "boolean" || (clearApiKey && Boolean(apiKey))) {
    throw new TenantConfigurationError("invalid_credential");
  }
  const normalizedApiKey = apiKey === null ? undefined : apiKey;
  const expectedTenantRevision = Number(value.expectedTenantRevision);
  const expectedBrandingRevision = Number(value.expectedBrandingRevision);
  if (!Number.isInteger(expectedTenantRevision) || expectedTenantRevision < 1) {
    throw new TenantConfigurationError("invalid_revision");
  }
  if (!Number.isInteger(expectedBrandingRevision) || expectedBrandingRevision < 1) {
    throw new TenantConfigurationError("invalid_revision");
  }

  return {
    provider,
    model,
    voiceGuide: {
      enabled: booleanValue(voiceGuide.enabled, true),
      voice: voiceValue(voiceGuide.voice),
      guide: stringValue(voiceGuide.guide, DEFAULTS.voiceGuide).slice(0, 2_000),
    },
    assistant: {
      name: stringValue(assistant.name, DEFAULTS.assistantName).slice(0, 80),
      welcome: stringValue(assistant.welcome, DEFAULTS.welcome).slice(0, 500),
      icon: iconValue(assistant.icon),
      primaryColor: hexValue(assistant.primaryColor, DEFAULTS.primaryColor),
      accentColor: hexValue(assistant.accentColor, DEFAULTS.accentColor),
      surfaceColor: hexValue(assistant.surfaceColor, DEFAULTS.surfaceColor),
      textColor: hexValue(assistant.textColor, DEFAULTS.textColor),
    },
    featureGates: {
      analytics: booleanValue(featureGates.analytics, true),
      voice: booleanValue(featureGates.voice, true),
      uploads: booleanValue(featureGates.uploads, true),
      contextMapping: booleanValue(featureGates.contextMapping, true),
    },
    ...(normalizedApiKey !== undefined ? { apiKey: normalizedApiKey } : {}),
    ...(clearApiKey ? { clearApiKey: true } : {}),
    expectedTenantRevision,
    expectedBrandingRevision,
  };
}

export class TenantConfigurationError extends Error {
  constructor(readonly code: string) {
    super(`Tenant configuration request failed: ${code}`);
    this.name = "TenantConfigurationError";
  }
}

async function readTenantRows(
  supabase: SupabaseClient,
  context: TenantContext,
) {
  if (!context.selected || !context.tenantId) {
    throw new TenantConfigurationError("tenant_selection_required");
  }
  const [tenantResponse, brandingResponse] = await Promise.all([
    supabase
      .from("tenants")
      .select("tenant_id, slug, display_name, settings, record_version")
      .eq("tenant_id", context.tenantId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("tenant_branding")
      .select(
        "tenant_branding_id, status, version_number, record_version, assistant_name, primary_color, accent_color, surface_color, text_color, welcome_message, voice_configuration, updated_at",
      )
      .eq("tenant_id", context.tenantId)
      .is("deleted_at", null)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (tenantResponse.error || brandingResponse.error || !tenantResponse.data) {
    throw new TenantConfigurationError("read_failed");
  }
  return {
    tenant: tenantResponse.data as Record<string, unknown>,
    branding: (brandingResponse.data as Record<string, unknown> | null) ?? null,
  };
}

export async function getTenantConfiguration(
  supabase: SupabaseClient,
  context: TenantContext,
) {
  const rows = await readTenantRows(supabase, context);
  return parseTenantConfiguration({
    ...rows,
    role: context.identityRole,
  });
}

export async function updateTenantConfiguration(
  supabase: SupabaseClient,
  context: TenantContext,
  patch: TenantConfigurationPatch,
  options: { authorization?: string | undefined } = {},
) {
  if (context.identityRole !== "tenant_owner" && context.identityRole !== "tenant_admin") {
    throw new TenantConfigurationError("access_denied");
  }
  if (!context.tenantId) throw new TenantConfigurationError("tenant_selection_required");

  const rows = await readTenantRows(supabase, context);
  const settings = safeSettings(rows.tenant.settings);
  const existingLearningBot = safeNestedSettings(settings);
  const existingConfiguration = isRecord(settings.configuration)
    ? settings.configuration
    : {};
  let credentialReference: string | null | undefined;
  if (patch.apiKey !== undefined || patch.clearApiKey === true) {
    const credentialResponse = await supabase.functions.invoke(
      "learning-provider-credentials",
      {
        body: {
          tenantId: context.tenantId,
          provider: patch.provider,
          apiKey: patch.apiKey ?? "",
          clearApiKey: patch.clearApiKey === true,
          requestId: `tenant-credential:${crypto.randomUUID()}`,
        },
        ...(options.authorization
          ? { headers: { Authorization: options.authorization } }
          : {}),
      },
    );
    const result = credentialResponse.data as Record<string, unknown> | null;
    if (
      credentialResponse.error ||
      !result ||
      result.ok !== true ||
      (result.vaultReference !== null &&
        typeof result.vaultReference !== "string")
    ) {
      throw new TenantConfigurationError("credential_boundary_unavailable");
    }
    credentialReference = result.vaultReference as string | null;
  }
  const nextConfiguration = {
    ...existingConfiguration,
    provider: patch.provider,
    model: patch.model,
    featureGates: patch.featureGates,
  } as Record<string, unknown>;
  if (credentialReference !== undefined) {
    if (credentialReference) nextConfiguration.credential_vault_ref = credentialReference;
    else delete nextConfiguration.credential_vault_ref;
  }
  const nextSettings = {
    ...settings,
    configuration: nextConfiguration,
    learningBot: {
      ...existingLearningBot,
      provider: patch.provider,
      model: patch.model,
      icon: patch.assistant.icon,
      featureGates: patch.featureGates,
    },
  };
  const tenantUpdate = await supabase
    .from("tenants")
    .update({ settings: nextSettings })
    .eq("tenant_id", context.tenantId)
    .eq("record_version", patch.expectedTenantRevision)
    .select("tenant_id")
    .maybeSingle();
  if (tenantUpdate.error || !tenantUpdate.data) {
    throw new TenantConfigurationError("version_conflict");
  }

  const branding = rows.branding;
  if (!branding?.tenant_branding_id) {
    throw new TenantConfigurationError("branding_not_found");
  }
  const brandingUpdate = await supabase
    .from("tenant_branding")
    .update({
      assistant_name: patch.assistant.name,
      primary_color: patch.assistant.primaryColor,
      accent_color: patch.assistant.accentColor,
      surface_color: patch.assistant.surfaceColor,
      text_color: patch.assistant.textColor,
      welcome_message: patch.assistant.welcome,
      voice_configuration: {
        enabled: patch.voiceGuide.enabled,
        voiceId: patch.voiceGuide.voice,
        displayName:
          patch.voiceGuide.voice[0]!.toUpperCase() + patch.voiceGuide.voice.slice(1),
        guide: patch.voiceGuide.guide,
      },
    })
    .eq("tenant_branding_id", branding.tenant_branding_id)
    .eq("record_version", patch.expectedBrandingRevision)
    .select("tenant_branding_id")
    .maybeSingle();
  if (brandingUpdate.error || !brandingUpdate.data) {
    throw new TenantConfigurationError("version_conflict");
  }

  return getTenantConfiguration(supabase, context);
}
