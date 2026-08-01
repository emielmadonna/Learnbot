import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabasePublicConfig } from "./config";

/**
 * Typed wrappers for the public widget delivery RPCs added by migration
 * 20260726093000.
 *
 * These are the only RPCs in the schema granted to `anon`, and they are called
 * with the browser-safe publishable key and NO session. Authorisation is the
 * (widget key, origin) pair the database re-checks on every call — never the
 * key alone, and never a cookie. Nothing in this module may be reused for an
 * authenticated surface.
 */

export const widgetUnavailableCode = "widget_unavailable" as const;

export type WidgetRpcCode =
  | "widget_unavailable"
  | "invalid_request"
  | "rate_limited"
  | "access_denied"
  | "request_denied"
  | "request_failed";

export class WidgetRpcError extends Error {
  constructor(
    readonly code: WidgetRpcCode,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Widget request denied: ${code}`);
    this.name = "WidgetRpcError";
  }
}

/** Presentation the runtime paints itself with. Contains no tenant identity. */
export type WidgetBootstrapBranding = {
  assistantName: string;
  iconGlyph: string | null;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  fontFamily: "system" | "rounded" | "serif";
  welcomeCopy: string;
  launcherLabel: string;
  launcherPosition: "bottom-left" | "bottom-right";
  voiceEnabled: boolean;
  /** Object path inside the public `widget-public` bucket, or null. */
  logoObjectPath: string | null;
  avatarObjectPath: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
};

export type WidgetBootstrapCourse = {
  /** Opaque, widget-key-salted. Never a course UUID. */
  courseRef: string;
  title: string;
};

export type WidgetBootstrapWidget = {
  presentation: "launcher" | "panel";
  launcherPosition: "bottom-left" | "bottom-right";
  launcherLabel: string;
  launcherShape: "bubble" | "pill" | "tab";
  greeting: string | null;
  greetingBubbleEnabled: boolean;
  greetingBubbleDelaySeconds: number;
  showPoweredBy: boolean;
  appearanceMode: "auto" | "light" | "dark";
  anonymousQuestions: boolean;
  courses: WidgetBootstrapCourse[];
};

export type WidgetBootstrapResult = {
  ok: true;
  dataMode: "durable";
  widget: WidgetBootstrapWidget;
  branding: WidgetBootstrapBranding;
};

export type WidgetAskMatch = {
  sourceRef: string;
  courseTitle: string;
  documentTitle: string;
  lessonTitle: string | null;
  sectionName: string | null;
  excerpt: string;
  contentHash: string;
};

export type WidgetAskResult = {
  ok: true;
  dataMode: "durable";
  conversationRef: string;
  sequence: number;
  assistantName: string;
  retrievalMode: string;
  matches: WidgetAskMatch[];
  /**
   * Present only when the server presented a valid conversation operation
   * token. The persona is never returned to a browser caller.
   */
  directive?: { personaInstructions: string | null; tone: string | null };
};

export type WidgetAnswerRecord = {
  ok: true;
  dataMode: "durable";
  conversationRef: string;
  sequence: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function widgetCode(value: unknown): WidgetRpcCode {
  if (typeof value !== "string") return "request_denied";
  if (
    value === "widget_unavailable" ||
    value === "invalid_request" ||
    value === "rate_limited" ||
    value === "access_denied" ||
    value === "request_denied"
  ) {
    return value;
  }
  return "request_denied";
}

export function requireWidgetRpcSuccess(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) throw new WidgetRpcError("request_denied");
  if (value.ok !== true) {
    const retryAfter =
      typeof value.retryAfterSeconds === "number"
        ? value.retryAfterSeconds
        : null;
    throw new WidgetRpcError(widgetCode(value.code), retryAfter);
  }
  return value;
}

/**
 * A sessionless Supabase client. `persistSession` and `autoRefreshToken` are
 * off because there is no user here and there must never be one: a widget
 * request must not be able to borrow a console session's authority.
 */
export function createWidgetSupabaseClient(): SupabaseClient {
  const config = readSupabasePublicConfig();
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

/** Absolute delivery URL for an object in the public widget asset bucket. */
export function widgetAssetUrl(objectPath: string | null): string | null {
  if (!objectPath || objectPath.includes("..") || objectPath.startsWith("/")) {
    return null;
  }
  const config = readSupabasePublicConfig();
  return `${config.url}/storage/v1/object/public/widget-public/${objectPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function isWidgetKey(value: unknown): value is string {
  return typeof value === "string" && /^wk_[0-9a-f]{40}$/u.test(value);
}

export function isConversationRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}

export function isCourseRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

export function parseWidgetBootstrap(value: unknown): WidgetBootstrapResult {
  const result = requireWidgetRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    !isRecord(result.widget) ||
    !isRecord(result.branding) ||
    typeof result.branding.assistantName !== "string"
  ) {
    throw new WidgetRpcError("request_denied");
  }
  return result as unknown as WidgetBootstrapResult;
}

export function parseWidgetAsk(value: unknown): WidgetAskResult {
  const result = requireWidgetRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    typeof result.conversationRef !== "string" ||
    !Array.isArray(result.matches)
  ) {
    throw new WidgetRpcError("request_denied");
  }
  return result as unknown as WidgetAskResult;
}

export function parseWidgetAnswerRecord(value: unknown): WidgetAnswerRecord {
  const result = requireWidgetRpcSuccess(value);
  if (
    result.dataMode !== "durable" ||
    typeof result.conversationRef !== "string"
  ) {
    throw new WidgetRpcError("request_denied");
  }
  return result as unknown as WidgetAnswerRecord;
}

export async function widgetBootstrap(
  supabase: SupabaseClient,
  input: { widgetKey: string; origin: string },
): Promise<WidgetBootstrapResult> {
  const response = await supabase.rpc("widget_bootstrap", {
    widget_key: input.widgetKey,
    origin: input.origin,
  });
  // A transport-level failure is an unavailable capability, not a refusal, and
  // must not be reported to the embedding page as either one specifically.
  if (response.error) throw new WidgetRpcError("request_failed");
  return parseWidgetBootstrap(response.data);
}

export async function widgetAsk(
  supabase: SupabaseClient,
  input: {
    widgetKey: string;
    origin: string;
    question: string;
    conversationRef: string;
    courseRef: string | null;
    idempotencyKey: string;
    traceId: string;
    operationToken: string | null;
  },
): Promise<WidgetAskResult> {
  const response = await supabase.rpc("widget_ask", {
    widget_key: input.widgetKey,
    origin: input.origin,
    question: input.question,
    conversation_ref: input.conversationRef,
    course_ref: input.courseRef,
    idempotency_key: input.idempotencyKey,
    trace_id: input.traceId,
    operation_token: input.operationToken,
  });
  if (response.error) throw new WidgetRpcError("request_failed");
  return parseWidgetAsk(response.data);
}

export async function widgetRecordAnswer(
  supabase: SupabaseClient,
  input: {
    widgetKey: string;
    origin: string;
    conversationRef: string;
    answer: string;
    sources: readonly Record<string, unknown>[];
    providerKey: string;
    providerRequestRef: string;
    idempotencyKey: string;
    traceId: string;
    operationToken: string;
  },
): Promise<WidgetAnswerRecord> {
  const response = await supabase.rpc("widget_record_answer", {
    widget_key: input.widgetKey,
    origin: input.origin,
    conversation_ref: input.conversationRef,
    answer_body: input.answer,
    sources: input.sources,
    provider_key: input.providerKey,
    provider_request_ref: input.providerRequestRef,
    idempotency_key: input.idempotencyKey,
    trace_id: input.traceId,
    operation_token: input.operationToken,
  });
  if (response.error) throw new WidgetRpcError("request_failed");
  return parseWidgetAnswerRecord(response.data);
}

/* ------------------------------------------------------------------ admin */

export type WidgetSettings = {
  enabled: boolean;
  presentation: "launcher" | "panel";
  launcherPosition: "bottom-left" | "bottom-right";
  launcherLabel: string;
  launcherShape: "bubble" | "pill" | "tab";
  greeting: string | null;
  greetingBubbleEnabled: boolean;
  greetingBubbleDelaySeconds: number;
  showPoweredBy: boolean;
  appearanceMode: "auto" | "light" | "dark";
  allowedOrigins: string[];
  anonymousQuestions: boolean;
  showCourseList: boolean;
  courseScope: "all" | string[];
  fontFamily: "system" | "rounded" | "serif";
  voiceEnabled: boolean;
  logoObjectPath: string | null;
  avatarObjectPath: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
};

export type WidgetSettingsSnapshot = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  expectedVersion: number;
  widgetKey: string | null;
  assetPrefix: string | null;
  assetBucket: "widget-public";
  defaults: WidgetSettings;
  settings: WidgetSettings;
  publishedSettings: WidgetSettings | null;
  liveStatus: "live" | "disabled" | "not_published" | "no_key";
};

export type WidgetSettingsWrite = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  expectedVersion: number;
  status: "draft" | "published";
  widgetKey: string;
  assetPrefix: string;
  assetBucket: "widget-public";
  settings: WidgetSettings;
};

export type WidgetSettingsInput = WidgetSettings & {
  rotateKey: boolean;
  publish: boolean;
  expectedVersion: number;
};

export function widgetOperationFields(prefix: string) {
  const operationId = crypto.randomUUID();
  return {
    idempotency_key: `${prefix}:${operationId}`,
    request_id: `${prefix}:${operationId}`,
    trace_id: `web:${operationId}`,
  };
}

export async function getWidgetSettings(
  supabase: SupabaseClient,
): Promise<WidgetSettingsSnapshot> {
  const response = await supabase.rpc("tenant_get_widget_settings");
  if (response.error) throw new WidgetRpcError("request_failed");
  const result = requireWidgetRpcSuccess(response.data);
  if (
    result.dataMode !== "durable" ||
    typeof result.expectedVersion !== "number" ||
    !isRecord(result.settings)
  ) {
    throw new WidgetRpcError("request_denied");
  }
  return result as unknown as WidgetSettingsSnapshot;
}

export async function updateWidgetSettings(
  supabase: SupabaseClient,
  input: WidgetSettingsInput,
  operation: ReturnType<typeof widgetOperationFields>,
): Promise<WidgetSettingsWrite> {
  const response = await supabase.rpc("tenant_update_widget_settings", {
    requested_enabled: input.enabled,
    requested_presentation: input.presentation,
    requested_launcher_position: input.launcherPosition,
    requested_launcher_label: input.launcherLabel,
    requested_launcher_shape: input.launcherShape,
    requested_greeting: input.greeting,
    requested_greeting_bubble_enabled: input.greetingBubbleEnabled,
    requested_greeting_bubble_delay_seconds:
      input.greetingBubbleDelaySeconds,
    requested_show_powered_by: input.showPoweredBy,
    requested_appearance_mode: input.appearanceMode,
    requested_allowed_origins: input.allowedOrigins,
    requested_anonymous_questions: input.anonymousQuestions,
    requested_show_course_list: input.showCourseList,
    requested_course_scope: input.courseScope,
    requested_font_family: input.fontFamily,
    requested_voice_enabled: input.voiceEnabled,
    requested_logo_object_path: input.logoObjectPath,
    requested_avatar_object_path: input.avatarObjectPath,
    requested_privacy_url: input.privacyUrl,
    requested_terms_url: input.termsUrl,
    requested_support_url: input.supportUrl,
    requested_rotate_key: input.rotateKey,
    requested_publish: input.publish,
    expected_version: input.expectedVersion,
    ...operation,
  });
  if (response.error) throw new WidgetRpcError("request_failed");
  const result = requireWidgetRpcSuccess(response.data);
  if (
    result.dataMode !== "durable" ||
    typeof result.expectedVersion !== "number" ||
    typeof result.widgetKey !== "string"
  ) {
    throw new WidgetRpcError("request_denied");
  }
  return result as unknown as WidgetSettingsWrite;
}

/**
 * A visual the assistant already showed this visitor, resolved for delivery.
 *
 * The read is scoped by disclosure, not by membership: the database returns a
 * row only when this exact (widget key, origin, conversationRef) triple has
 * already been shown this exact asset. See the header of
 * 20260731060000_widget_visual_media_disclosure.sql for why a widget key --
 * which ships publicly in a <script> tag -- cannot be allowed to stand in for
 * "may read any of this tenant's media".
 *
 * `privateObjectKey` never reaches a browser. The route signs and streams it
 * server-side, exactly as the authenticated visual route does.
 */
export type WidgetVisualAsset = {
  visualAssetId: string;
  title: string;
  altText: string;
  mediaType: string;
  sizeBytes: number;
  privateObjectKey: string;
};

export async function widgetGetVisualAsset(
  supabase: SupabaseClient,
  input: {
    widgetKey: string;
    origin: string;
    conversationRef: string;
    visualAssetId: string;
  },
): Promise<WidgetVisualAsset> {
  const response = await supabase.rpc("widget_get_visual_asset_for_read", {
    widget_key: input.widgetKey,
    origin: input.origin,
    conversation_ref: input.conversationRef,
    target_visual_asset_id: input.visualAssetId,
  });
  if (response.error) throw new WidgetRpcError("request_failed");
  const result = requireWidgetRpcSuccess(response.data);
  if (
    result.dataMode !== "durable" ||
    typeof result.privateObjectKey !== "string" ||
    typeof result.mediaType !== "string" ||
    typeof result.sizeBytes !== "number"
  ) {
    throw new WidgetRpcError("request_denied");
  }
  return result as unknown as WidgetVisualAsset;
}

/**
 * Records that an answer surfaced these visuals, which is what later authorises
 * the visitor to read them. Requires the server-held
 * `conversation.answer.record` operation token, so a browser can never grant
 * itself access to an asset it was not shown.
 */
export async function widgetRecordVisualDisclosure(
  supabase: SupabaseClient,
  input: {
    widgetKey: string;
    origin: string;
    conversationRef: string;
    visualAssetIds: readonly string[];
    operationToken: string;
  },
): Promise<void> {
  if (input.visualAssetIds.length === 0) return;
  const response = await supabase.rpc("widget_record_visual_disclosure", {
    widget_key: input.widgetKey,
    origin: input.origin,
    conversation_ref: input.conversationRef,
    visual_asset_ids: input.visualAssetIds,
    operation_token: input.operationToken,
  });
  if (response.error) throw new WidgetRpcError("request_failed");
  requireWidgetRpcSuccess(response.data);
}
