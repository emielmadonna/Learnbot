import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../lib/supabase/auth-boundary";
import {
  AgentRpcError,
  agentEditableVersion,
  agentEscalationTriggerOptions,
  agentOperationFields,
  agentToneOptions,
  getAgentConfiguration,
  updateAgentConfiguration,
  type AgentConfigurationInput,
  type AgentCourseScope,
} from "../../../lib/supabase/agent-rpc";
import { authenticatedLearningClient } from "../../../lib/supabase/learning-route";

const brandAssetTtlSeconds = 600;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const colorPattern = /^#[0-9A-Fa-f]{6}$/u;
const voicePattern = /^[a-z0-9][a-z0-9._-]{0,60}$/u;
const tones = new Set<string>(agentToneOptions);
const escalationTriggers = new Set<string>(agentEscalationTriggerOptions);
// Mirrors app_private.agent_allowed_models() in
// infra/supabase/migrations/20260726097000_agent_control_surface.sql. This
// is a redundant client-side guard only — the database CHECK constraint and
// RPC validation are the actual boundary a caller cannot bypass.
const agentModels = new Set<string>([
  "gpt-5.6-luna",
  "gpt-5.6-luna-mini",
  "gpt-5.6-luna-pro",
]);
const conflictCodes = new Set([
  "idempotency_conflict",
  "tenant_selection_required",
  "version_conflict",
]);
const safeCodes = new Set([
  "access_denied",
  "course_scope_invalid",
  "idempotency_conflict",
  "invalid_request",
  "request_denied",
  // The RPC could not be executed at all (missing, ungranted, or refused by
  // the database). It is reported as an unavailable dependency, not as a
  // rejected request and never as a failed sign-in.
  "request_failed",
  "tenant_not_found",
  "tenant_selection_required",
  "version_conflict",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, min: number, max: number) {
  if (typeof value !== "string") throw new AgentRpcError("invalid_request");
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new AgentRpcError("invalid_request");
  }
  return trimmed;
}

function optionalText(value: unknown, max: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new AgentRpcError("invalid_request");
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new AgentRpcError("invalid_request");
  return trimmed;
}

function requiredColor(value: unknown) {
  const color = requiredText(value, 7, 7);
  if (!colorPattern.test(color)) throw new AgentRpcError("invalid_request");
  return color.toUpperCase();
}

function requiredBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new AgentRpcError("invalid_request");
  return value;
}

function boundedNumber(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new AgentRpcError("invalid_request");
  }
  return parsed;
}

function boundedInteger(value: unknown, min: number, max: number) {
  const parsed = boundedNumber(value, min, max);
  if (!Number.isInteger(parsed)) throw new AgentRpcError("invalid_request");
  return parsed;
}

function assetKey(value: unknown, tenantId: string) {
  const key = optionalText(value, 1024);
  if (key === null) return null;
  if (!key.startsWith(`${tenantId}/branding/`) || key.includes("..")) {
    throw new AgentRpcError("invalid_request");
  }
  return key;
}

function courseScope(value: unknown): AgentCourseScope {
  if (value === undefined || value === null || value === "all") return "all";
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new AgentRpcError("invalid_request");
  }
  const scope = value.map((entry) => {
    if (typeof entry !== "string" || !uuidPattern.test(entry)) {
      throw new AgentRpcError("invalid_request");
    }
    return entry.toLowerCase();
  });
  return Array.from(new Set(scope));
}

function parseInput(value: unknown, tenantId: string): AgentConfigurationInput {
  if (!isRecord(value)) throw new AgentRpcError("invalid_request");
  const tone =
    typeof value.tone === "string" ? value.tone.trim().toLowerCase() : "neutral";
  if (!tones.has(tone)) throw new AgentRpcError("invalid_request");
  const voice = optionalText(value.voice, 61)?.toLowerCase() ?? null;
  if (voice !== null && !voicePattern.test(voice)) {
    throw new AgentRpcError("invalid_request");
  }
  const model =
    typeof value.model === "string" ? value.model.trim().toLowerCase() : "";
  // The model is chosen from a platform-allowed set only, never free text.
  if (!agentModels.has(model)) throw new AgentRpcError("invalid_request");
  const escalationTrigger =
    typeof value.escalationTrigger === "string"
      ? value.escalationTrigger.trim().toLowerCase()
      : "manual";
  if (!escalationTriggers.has(escalationTrigger)) {
    throw new AgentRpcError("invalid_request");
  }
  const escalationEnabled = requiredBoolean(value.escalationEnabled, false);
  const escalationMessage = optionalText(value.escalationMessage, 500);
  // Escalation copy is meaningless without escalation switched on. Enforced
  // here and again by the database CHECK constraint.
  if (escalationEnabled && escalationMessage === null) {
    throw new AgentRpcError("invalid_request");
  }
  const expectedVersion = Number(value.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new AgentRpcError("invalid_request");
  }
  return {
    assistantName: requiredText(value.assistantName, 1, 80),
    iconGlyph: optionalText(value.iconGlyph, 16),
    primaryColor: requiredColor(value.primaryColor),
    accentColor: requiredColor(value.accentColor),
    surfaceColor: requiredColor(value.surfaceColor),
    textColor: requiredColor(value.textColor),
    welcomeMessage: requiredText(value.welcomeMessage, 1, 500),
    personaInstructions: optionalText(value.personaInstructions, 4000),
    tone,
    voice,
    courseScope: courseScope(value.courseScope),
    logoStorageKey: assetKey(value.logoStorageKey, tenantId),
    avatarStorageKey: assetKey(value.avatarStorageKey, tenantId),
    // Generation. Defaults are chosen so a creator never has to touch these.
    model,
    temperature: boundedNumber(value.temperature ?? 0.4, 0, 2),
    topP: boundedNumber(value.topP ?? 1, 0.01, 1),
    maxOutputTokens: boundedInteger(value.maxOutputTokens ?? 800, 64, 4000),
    extendedInstructions: optionalText(value.extendedInstructions, 8000),
    // Voice.
    voiceEnabled: requiredBoolean(value.voiceEnabled, true),
    voiceSpeakingRate: boundedNumber(value.voiceSpeakingRate ?? 1, 0.5, 2),
    voiceBargeInEnabled: requiredBoolean(value.voiceBargeInEnabled, true),
    // Grounding behaviour. The count and floor are configurable; the decision
    // to refuse on empty retrieval is not — there is no field for it here.
    retrievalCount: boundedInteger(value.retrievalCount ?? 6, 1, 20),
    retrievalSimilarityFloor: boundedNumber(
      value.retrievalSimilarityFloor ?? 0.2,
      0,
      1,
    ),
    noResultsMessage: requiredText(value.noResultsMessage, 1, 500),
    // Escalation.
    escalationEnabled,
    escalationTrigger,
    escalationMessage,
    publish: value.publish === true,
    expectedVersion,
  };
}

/**
 * A caller-supplied key makes a retried save replay the prior write instead of
 * appending a second configuration version. Anything unusable is replaced by a
 * fresh server-generated operation.
 */
function operationFields(value: unknown) {
  const base = agentOperationFields("agent-configuration");
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 160 ||
    !/^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    return base;
  }
  return {
    idempotency_key: `agent-configuration:${value}`,
    request_id: `agent-configuration:${value}`,
    trace_id: base.trace_id,
  };
}

async function signBrandAsset(
  supabase: SupabaseClient,
  key: string | null | undefined,
) {
  if (typeof key !== "string" || key.length === 0) return null;
  const signed = await supabase.storage
    .from("tenant-private")
    .createSignedUrl(key, brandAssetTtlSeconds);
  if (signed.error || !signed.data) return null;
  return signed.data.signedUrl;
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof AgentRpcError) {
    const code = safeCodes.has(error.code) ? error.code : "request_denied";
    const status =
      code === "request_failed"
        ? 503
        : code === "access_denied"
          ? 403
          : conflictCodes.has(code)
            ? 409
            : 400;
    return NextResponse.json(
      { ok: false, code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_denied" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const configuration = await getAgentConfiguration(supabase);
    // Sign the head version's keys, not "draft ?? published": after a publish
    // the older draft row survives with a lower version number, and preferring
    // it here would hand the editor a superseded logo.
    const active = agentEditableVersion(configuration);
    const [logoUrl, avatarUrl] = await Promise.all([
      signBrandAsset(supabase, active?.logoStorageKey),
      signBrandAsset(supabase, active?.avatarStorageKey),
    ]);
    return NextResponse.json(
      { ...configuration, assets: { logoUrl, avatarUrl } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    // Agent behaviour is tenant-wide administrative state, so the write always
    // requires a verified same-origin browser request in addition to the
    // database-side role and tenant checks.
    assertSameOrigin(request);
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const current = await getAgentConfiguration(supabase);
    const body = (await request.json()) as unknown;
    const input = parseInput(body, current.tenantId);
    const written = await updateAgentConfiguration(
      supabase,
      input,
      operationFields(isRecord(body) ? body.idempotencyKey : null),
    );
    return NextResponse.json(written, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
