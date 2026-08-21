import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  classifyAuthBoundaryError,
} from "../../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  getWidgetSettings,
  widgetOperationFields,
  WidgetRpcError,
  type WidgetSettings,
  type WidgetSettingsSnapshot,
} from "../../../../lib/supabase/widget-rpc";

export const dynamic = "force-dynamic";

const MAX_ORIGINS = 20;
const MAX_GREETING = 500;
const MAX_LAUNCHER_LABEL = 40;
const MAX_GREETING_DELAY_SECONDS = 120;
const safeCodes = new Set([
  "access_denied",
  "idempotency_conflict",
  "invalid_request",
  "request_denied",
  "request_failed",
  "tenant_not_found",
  "tenant_selection_required",
  "version_conflict",
]);
const conflictCodes = new Set([
  "idempotency_conflict",
  "tenant_selection_required",
  "version_conflict",
]);

class WidgetSettingsError extends Error {
  constructor(readonly code: string) {
    super(`Widget settings request denied: ${code}`);
    this.name = "WidgetSettingsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isRecord(candidate) ? candidate : null;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseWidgetSettings(value: unknown): WidgetSettings | null {
  if (!isRecord(value)) return null;
  const courseScope =
    value.courseScope === "all"
      ? "all"
      : Array.isArray(value.courseScope) &&
          value.courseScope.every((entry) => typeof entry === "string")
        ? value.courseScope
        : null;
  if (
    typeof value.enabled !== "boolean" ||
    (value.presentation !== "launcher" && value.presentation !== "panel") ||
    (value.launcherPosition !== "bottom-left" &&
      value.launcherPosition !== "bottom-right") ||
    typeof value.launcherLabel !== "string" ||
    (value.launcherShape !== "bubble" &&
      value.launcherShape !== "pill" &&
      value.launcherShape !== "tab") ||
    !nullableString(value.greeting) ||
    typeof value.greetingBubbleEnabled !== "boolean" ||
    !Number.isInteger(value.greetingBubbleDelaySeconds) ||
    (value.greetingBubbleDelaySeconds as number) < 0 ||
    (value.greetingBubbleDelaySeconds as number) >
      MAX_GREETING_DELAY_SECONDS ||
    typeof value.showPoweredBy !== "boolean" ||
    (value.appearanceMode !== "auto" &&
      value.appearanceMode !== "light" &&
      value.appearanceMode !== "dark") ||
    !Array.isArray(value.allowedOrigins) ||
    !value.allowedOrigins.every((entry) => typeof entry === "string") ||
    typeof value.anonymousQuestions !== "boolean" ||
    typeof value.showCourseList !== "boolean" ||
    courseScope === null ||
    (value.fontFamily !== "system" &&
      value.fontFamily !== "rounded" &&
      value.fontFamily !== "serif") ||
    typeof value.voiceEnabled !== "boolean" ||
    !nullableString(value.logoObjectPath) ||
    !nullableString(value.avatarObjectPath) ||
    !nullableString(value.privacyUrl) ||
    !nullableString(value.termsUrl) ||
    !nullableString(value.supportUrl)
  ) {
    return null;
  }
  return {
    enabled: value.enabled,
    presentation: value.presentation,
    launcherPosition: value.launcherPosition,
    launcherLabel: value.launcherLabel,
    launcherShape: value.launcherShape,
    greeting: value.greeting,
    greetingBubbleEnabled: value.greetingBubbleEnabled,
    greetingBubbleDelaySeconds:
      value.greetingBubbleDelaySeconds as number,
    showPoweredBy: value.showPoweredBy,
    appearanceMode: value.appearanceMode,
    allowedOrigins: value.allowedOrigins,
    anonymousQuestions: value.anonymousQuestions,
    showCourseList: value.showCourseList,
    courseScope,
    fontFamily: value.fontFamily,
    voiceEnabled: value.voiceEnabled,
    logoObjectPath: value.logoObjectPath,
    avatarObjectPath: value.avatarObjectPath,
    privacyUrl: value.privacyUrl,
    termsUrl: value.termsUrl,
    supportUrl: value.supportUrl,
  };
}

function requiredBoolean(value: unknown) {
  if (typeof value !== "boolean") throw new WidgetRpcError("invalid_request");
  return value;
}

function requiredText(value: unknown, max: number, allowEmpty = false) {
  if (typeof value !== "string") throw new WidgetRpcError("invalid_request");
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length === 0) || trimmed.length > max) {
    throw new WidgetRpcError("invalid_request");
  }
  return trimmed;
}

function expectedVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WidgetRpcError("invalid_request");
  }
  return parsed;
}

function greetingDelaySeconds(value: unknown) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_GREETING_DELAY_SECONDS
  ) {
    throw new WidgetRpcError("invalid_request");
  }
  return parsed;
}

function allowedOrigins(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) {
    throw new WidgetRpcError("invalid_request");
  }
  const origins = value.map((entry) => {
    if (typeof entry !== "string" || entry !== entry.trim() || entry.includes("*")) {
      throw new WidgetRpcError("invalid_request");
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new WidgetRpcError("invalid_request");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== entry ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new WidgetRpcError("invalid_request");
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new WidgetRpcError("invalid_request");
  }
  return origins;
}

function operationFields(value: unknown) {
  const base = widgetOperationFields("widget-settings");
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 160 ||
    !/^[A-Za-z0-9:_-]+$/u.test(value)
  ) {
    return base;
  }
  return {
    idempotency_key: `widget-settings:${value}`,
    request_id: `widget-settings:${value}`,
    trace_id: base.trace_id,
  };
}

function editorEnvelope(
  snapshot:
    | WidgetSettingsSnapshot
    | {
        ok: true;
        dataMode: "durable";
        tenantId: string;
        expectedVersion: number;
        widgetKey: string | null;
        liveStatus?: string;
        settings: WidgetSettings;
      },
) {
  return {
    ok: true,
    dataMode: "durable",
    tenantId: snapshot.tenantId,
    expectedVersion: snapshot.expectedVersion,
    liveStatus: "liveStatus" in snapshot ? snapshot.liveStatus : undefined,
    settings: {
      enabled: snapshot.settings.enabled,
      publicKey: snapshot.widgetKey,
      allowedOrigins: snapshot.settings.allowedOrigins,
      greeting: snapshot.settings.greeting ?? "",
      launcherLabel: snapshot.settings.launcherLabel,
      launcherPosition: snapshot.settings.launcherPosition,
      launcherShape: snapshot.settings.launcherShape,
      greetingBubbleEnabled: snapshot.settings.greetingBubbleEnabled,
      greetingBubbleDelaySeconds:
        snapshot.settings.greetingBubbleDelaySeconds,
      showPoweredBy: snapshot.settings.showPoweredBy,
      appearanceMode: snapshot.settings.appearanceMode,
      presentation: snapshot.settings.presentation,
      anonymousAccess: snapshot.settings.anonymousQuestions,
      updatedAt: null,
    },
  };
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      {
        status: failure.status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  if (error instanceof WidgetRpcError) {
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
      {
        status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  if (error instanceof WidgetSettingsError) {
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
      {
        status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  return NextResponse.json(
    { ok: false, code: "request_denied" },
    {
      status: 400,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request);
    const snapshot = await getWidgetSettings(supabase);
    return NextResponse.json(editorEnvelope(snapshot), {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const current = await getWidgetSettings(supabase);
    const body = (await request.json()) as unknown;
    if (!isRecord(body)) throw new WidgetRpcError("invalid_request");

    const enabled = requiredBoolean(body.enabled);
    const anonymousQuestions = requiredBoolean(body.anonymousAccess);
    const launcherPosition =
      body.launcherPosition === "bottom-left"
        ? "bottom-left"
        : body.launcherPosition === "bottom-right"
          ? "bottom-right"
          : null;
    const presentation =
      body.presentation === "launcher"
        ? "launcher"
        : body.presentation === "panel"
          ? "panel"
          : null;
    const launcherShape =
      body.launcherShape === "bubble" ||
      body.launcherShape === "pill" ||
      body.launcherShape === "tab"
        ? body.launcherShape
        : null;
    const appearanceMode =
      body.appearanceMode === "auto" ||
      body.appearanceMode === "light" ||
      body.appearanceMode === "dark"
        ? body.appearanceMode
        : null;
    if (
      launcherPosition === null ||
      presentation === null ||
      launcherShape === null ||
      appearanceMode === null
    ) {
      throw new WidgetRpcError("invalid_request");
    }

    const settings: WidgetSettings = {
      ...current.settings,
      enabled,
      presentation,
      launcherPosition,
      launcherLabel: requiredText(
        body.launcherLabel,
        MAX_LAUNCHER_LABEL,
        true,
      ),
      launcherShape,
      greeting: requiredText(body.greeting, MAX_GREETING),
      greetingBubbleEnabled: requiredBoolean(body.greetingBubbleEnabled),
      greetingBubbleDelaySeconds: greetingDelaySeconds(
        body.greetingBubbleDelaySeconds,
      ),
      showPoweredBy: requiredBoolean(body.showPoweredBy),
      appearanceMode,
      allowedOrigins: allowedOrigins(body.allowedOrigins),
      anonymousQuestions,
    };
    const version = expectedVersion(body.expectedVersion);
    const response = await supabase.rpc("tenant_update_widget_settings", {
      requested_enabled: settings.enabled,
      requested_presentation: settings.presentation,
      requested_launcher_position: settings.launcherPosition,
      requested_launcher_label: settings.launcherLabel,
      requested_launcher_shape: settings.launcherShape,
      requested_greeting: settings.greeting,
      requested_greeting_bubble_enabled: settings.greetingBubbleEnabled,
      requested_greeting_bubble_delay_seconds:
        settings.greetingBubbleDelaySeconds,
      requested_show_powered_by: settings.showPoweredBy,
      requested_appearance_mode: settings.appearanceMode,
      requested_allowed_origins: settings.allowedOrigins,
      requested_anonymous_questions: settings.anonymousQuestions,
      requested_show_course_list: settings.showCourseList,
      requested_course_scope: settings.courseScope,
      requested_font_family: settings.fontFamily,
      requested_voice_enabled: settings.voiceEnabled,
      requested_logo_object_path: settings.logoObjectPath,
      requested_avatar_object_path: settings.avatarObjectPath,
      requested_privacy_url: settings.privacyUrl,
      requested_terms_url: settings.termsUrl,
      requested_support_url: settings.supportUrl,
      requested_rotate_key: false,
      requested_publish: true,
      expected_version: version,
      ...operationFields(body.idempotencyKey),
    });
    if (response.error) throw new WidgetRpcError("request_failed");
    const written = firstRecord(response.data);
    if (written === null) throw new WidgetRpcError("request_denied");
    if (written.ok !== true) {
      const code =
        typeof written.code === "string" && safeCodes.has(written.code)
          ? written.code
          : "request_denied";
      throw new WidgetSettingsError(code);
    }
    const writtenSettings = parseWidgetSettings(written.settings);
    if (
      written.dataMode !== "durable" ||
      typeof written.tenantId !== "string" ||
      typeof written.expectedVersion !== "number" ||
      typeof written.widgetKey !== "string" ||
      writtenSettings === null
    ) {
      throw new WidgetRpcError("request_denied");
    }
    return NextResponse.json(
      editorEnvelope({
        ok: true,
        dataMode: "durable",
        tenantId: written.tenantId,
        expectedVersion: written.expectedVersion,
        widgetKey: written.widgetKey,
        settings: writtenSettings,
      }),
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
