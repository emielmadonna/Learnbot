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
