import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type VoiceAction = "readiness" | "transcribe" | "speak" | "realtime";

const OPENAI_TRANSCRIPTION_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const SPEECH_MODEL = "gpt-4o-mini-tts";
const REALTIME_MODEL = "gpt-realtime-2.1";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 256 * 1024;
const MAX_VOICE_TURN_MS = 45_000;
const MAX_SPEECH_CHARACTERS = 4_096;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 32 * 1024;
const REQUEST_DEADLINE_MS = 45_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const supportedVoices = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);
const mediaTypes = new Map([
  ["audio/webm", { extension: "webm", providerType: "audio/webm" }],
  ["video/webm", { extension: "webm", providerType: "audio/webm" }],
  ["audio/mp4", { extension: "m4a", providerType: "audio/mp4" }],
  ["video/mp4", { extension: "mp4", providerType: "video/mp4" }],
  ["audio/m4a", { extension: "m4a", providerType: "audio/mp4" }],
  ["audio/x-m4a", { extension: "m4a", providerType: "audio/mp4" }],
  ["audio/aac", { extension: "aac", providerType: "audio/aac" }],
]);

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publishableKey() {
  try {
    const values = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}",
    ) as Record<string, unknown>;
    return typeof values.default === "string" ? values.default : "";
  } catch {
    return "";
  }
}

function createAuthClient(authorization: string) {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = publishableKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: authorization } },
  });
}

function createServiceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function firstRecord(value: unknown): JsonRecord | null {
  if (Array.isArray(value)) {
    return isRecord(value[0]) ? value[0] : null;
  }
  return isRecord(value) ? value : null;
}

async function safetyIdentifier(authUserId: string, tenantId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`learningbot:${tenantId}:${authUserId}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function providerError(
  action: VoiceAction,
  status: number,
  headers: Headers,
) {
  const retryable = status === 408 || status === 429 || status >= 500;
  const labels: Record<Exclude<VoiceAction, "readiness">, string> = {
    transcribe: "The voice turn could not be transcribed.",
    speak: "The saved answer could not be converted to speech.",
    realtime: "Continuous voice could not connect.",
  };
  const code =
    status === 401 || status === 403
      ? "provider_authentication_failed"
      : action === "transcribe"
        ? "transcription_failed"
        : action === "speak"
          ? "speech_failed"
          : "realtime_provider_failed";
  const retryAfter = headers.get("retry-after");
  return json(
    {
      ok: false,
      code,
      message:
        action === "readiness"
          ? "Voice readiness could not be verified."
          : labels[action],
      retryable,
    },
    502,
    retryAfter ? { "retry-after": retryAfter } : {},
  );
}

async function authenticate(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return {
      failure: json(
        {
          ok: false,
          code: "authentication_required",
          message: "A verified sign-in is required.",
        },
        401,
      ),
    };
  }
  const authClient = createAuthClient(authorization);
  const serviceClient = createServiceClient();
  if (!authClient || !serviceClient) {
    return {
      failure: json(
        {
          ok: false,
          code: "credential_boundary_unavailable",
          message: "The managed voice boundary is unavailable.",
        },
        503,
      ),
    };
  }
  const token = authorization.slice("Bearer ".length).trim();
  const { data: identity, error: identityError } =
    await authClient.auth.getUser(token);
  const user = identity.user;
  if (
    identityError ||
    !user ||
    user.is_anonymous ||
    (!user.email_confirmed_at && !user.phone_confirmed_at)
  ) {
    return {
      failure: json(
        {
          ok: false,
          code: "authentication_required",
          message: "A verified sign-in is required.",
        },
        401,
      ),
    };
  }
  const { data: accessData, error: accessError } = await authClient.rpc(
    "auth_current_access_state",
  );
  const access = firstRecord(accessData);
  if (accessError || !access) {
    return {
      failure: json(
        {
          ok: false,
          code: "credential_boundary_unavailable",
          message: "The managed account state could not be verified.",
        },
        503,
      ),
    };
  }
  if (access.managed === true && access.must_change_password === true) {
    return {
      failure: json(
        {
          ok: false,
          code: "password_change_required",
          message: "Change the temporary password before using voice.",
        },
        403,
      ),
    };
  }
  return { authClient, serviceClient, user };
}

async function resolveBoundary(
  authClient: SupabaseClient,
  serviceClient: SupabaseClient,
  userId: string,
  tenantId: string,
) {
  const { data: contextData, error: contextError } = await authClient.rpc(
    "auth_current_tenant_context",
  );
  const context = firstRecord(contextData);
  if (
    contextError ||
    !context ||
    context.selected !== true ||
    context.tenant_id !== tenantId ||
    typeof context.principal_id !== "string"
  ) {
    return {
      failure: json(
        {
          ok: false,
          code: "tenant_selection_required",
          message: "Select the requested workspace before using voice.",
        },
        409,
      ),
    };
  }

  const { data: credentialData, error: credentialError } =
    await serviceClient.rpc("learning_provider_runtime_credential", {
      caller_auth_user_id: userId,
      target_tenant_id: tenantId,
      requested_provider: "openai",
    });
  if (credentialError || !isRecord(credentialData)) {
    return {
      failure: json(
        {
          ok: false,
          code: "credential_boundary_unavailable",
          message: "The managed voice credential could not be resolved.",
        },
        503,
      ),
    };
  }
  let credential =
    credentialData.ok === true && typeof credentialData.credential === "string"
      ? credentialData.credential.trim()
      : "";
  if (
    !credential &&
    credentialData.code === "tenant_credential_not_configured"
  ) {
    credential = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  }
  if (!credential || credential.length < 20) {
    return {
      failure: json(
        {
          ok: false,
          code:
            credentialData.code === "access_denied"
              ? "access_denied"
              : "voice_provider_not_configured",
          message: "Voice is not configured for this workspace.",
        },
        credentialData.code === "access_denied" ? 403 : 503,
      ),
    };
  }
  return {
    credential,
    principalId: context.principal_id as string,
  };
}

const capabilities = {
  transcribe: "voice.transcribe",
  speak: "voice.speak",
  realtime: "voice.realtime",
} as const;

async function reserve(
  client: SupabaseClient,
  action: Exclude<VoiceAction, "readiness">,
  tenantId: string,
  principalId: string,
) {
  const { data, error } = await client.rpc("learning_reserve_provider_call", {
    requested_capability: capabilities[action],
    subject_key: `${tenantId}:${principalId}`,
    target_tenant_id: null,
    operation_token: null,
  });
  if (error || !isRecord(data)) {
    return json(
      {
        ok: false,
        code: "voice_metering_unavailable",
        message: "Voice quota could not be verified.",
        retryable: true,
      },
      503,
    );
  }
  if (data.ok !== true || data.allowed !== true) {
    const code =
      data.code === "daily_budget_exceeded" ||
      data.code === "monthly_budget_exceeded"
        ? "voice_budget_exceeded"
        : "voice_rate_limited";
    const retryAfter =
      typeof data.retryAfterSeconds === "number"
        ? Math.max(1, Math.trunc(data.retryAfterSeconds))
        : 1;
    return json(
      {
        ok: false,
        code,
        message:
          code === "voice_budget_exceeded"
            ? "This workspace has reached its voice budget."
            : "Too many voice requests. Wait a moment and try again.",
        retryable: code === "voice_rate_limited",
      },
      429,
      {
        "retry-after": String(retryAfter),
        "x-voice-ratelimit-scope": "durable-tenant",
      },
    );
  }
  return null;
}

async function meter(
  client: SupabaseClient,
  input: {
    action: Exclude<VoiceAction, "readiness">;
    model: string;
    quantity: number;
    unit: string;
    costMicro: number;
    conversationId?: string | null;
  },
) {
  try {
    await client.rpc("learning_record_provider_cost", {
      requested_capability: capabilities[input.action],
      provider_key: "openai:voice",
      model_key: input.model,
      quantity: Math.max(0, input.quantity),
      unit: input.unit,
      estimated_cost_micro: Math.max(0, Math.round(input.costMicro)),
      trace_id: `voice-${input.action}:${crypto.randomUUID()}`,
      idempotency_key: `voice-${input.action}:${crypto.randomUUID()}`,
      request_id: null,
      target_conversation_id: input.conversationId ?? null,
      provider_metadata_safe: {
        kind: input.action,
        rawAudioStored: false,
      },
      target_tenant_id: null,
      operation_token: null,
    });
  } catch {
    // Metering is best effort after a successful provider result. Content and
    // credentials are intentionally never included in Edge logs.
  }
}

function normalizedMediaType(value: string) {
  return value.toLowerCase().split(";")[0]?.trim() ?? "";
}

async function transcribe(
  request: Request,
  client: SupabaseClient,
  credential: string,
  tenantId: string,
  principalId: string,
) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const declaredLength = request.headers.get("content-length");
  if (!contentType.startsWith("multipart/form-data;")) {
    return json(
      {
        ok: false,
        code: "invalid_content_type",
        message: "A multipart microphone recording is required.",
      },
      415,
    );
  }
  if (!declaredLength) {
    return json(
      {
        ok: false,
        code: "length_required",
        message: "A bounded Content-Length is required for voice turns.",
      },
      411,
    );
  }
  if (
    !/^\d+$/u.test(declaredLength) ||
    Number(declaredLength) < 1 ||
    Number(declaredLength) > MAX_MULTIPART_BYTES
  ) {
    return json(
      {
        ok: false,
        code: "audio_too_large",
        message: "Voice turns are limited to 45 seconds and 10 MB.",
      },
      413,
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(
      {
        ok: false,
        code: "invalid_audio",
        message: "The microphone recording could not be read.",
      },
      400,
    );
  }
  const audio = form.get("audio");
  const rawDuration = form.get("durationMs");
  const durationMs =
    typeof rawDuration === "string" && /^\d{2,5}$/u.test(rawDuration)
      ? Number(rawDuration)
      : 0;
  const media =
    audio instanceof File
      ? mediaTypes.get(normalizedMediaType(audio.type))
      : null;
  if (
    !(audio instanceof File) ||
    audio.size < 64 ||
    audio.size > MAX_AUDIO_BYTES ||
    !media ||
    durationMs < 100 ||
    durationMs > MAX_VOICE_TURN_MS
  ) {
    return json(
      {
        ok: false,
        code: "invalid_audio",
        message: "A supported recording of 45 seconds or less is required.",
      },
      400,
    );
  }

  const quota = await reserve(client, "transcribe", tenantId, principalId);
  if (quota) return quota;

  const providerBody = new FormData();
  providerBody.set(
    "file",
    new File([audio], `voice-turn.${media.extension}`, {
      type: media.providerType,
    }),
  );
  providerBody.set("model", TRANSCRIPTION_MODEL);
  providerBody.set("response_format", "json");
  const providerResponse = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: providerBody,
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  if (!providerResponse.ok) {
    return providerError("transcribe", providerResponse.status, providerResponse.headers);
  }
  let payload: unknown;
  try {
    payload = await providerResponse.json();
  } catch {
    payload = null;
  }
  const transcript =
    isRecord(payload) && typeof payload.text === "string"
      ? payload.text.trim()
      : "";
  if (!transcript || transcript.length > 8_000) {
    return json(
      {
        ok: false,
        code: "transcription_empty",
        message: "I did not catch that. Please try the voice turn again.",
      },
      422,
    );
  }
  await meter(client, {
    action: "transcribe",
    model: TRANSCRIPTION_MODEL,
    quantity: durationMs / 1_000,
    unit: "audio_seconds",
    costMicro: (durationMs / 1_000) * 100,
  });
  return json(
    {
      ok: true,
      transcript,
      model: TRANSCRIPTION_MODEL,
      rawAudioStored: false,
      durationPolicyMs: MAX_VOICE_TURN_MS,
    },
    200,
    { "x-voice-ratelimit-scope": "durable-tenant" },
  );
}

async function speak(
  input: JsonRecord,
  client: SupabaseClient,
  credential: string,
  tenantId: string,
  principalId: string,
) {
  const answer = typeof input.input === "string" ? input.input.trim() : "";
  const voice =
    typeof input.voice === "string" ? input.voice.trim().toLowerCase() : "";
  const conversationId =
    typeof input.conversationId === "string" ? input.conversationId : "";
  const messageId = typeof input.messageId === "string" ? input.messageId : "";
  if (
    !answer ||
    answer.length > MAX_SPEECH_CHARACTERS ||
    !supportedVoices.has(voice) ||
    !uuidPattern.test(conversationId) ||
    !uuidPattern.test(messageId)
  ) {
    return json(
      {
        ok: false,
        code: "invalid_request",
        message: "A bounded saved assistant answer is required.",
      },
      400,
    );
  }
  const quota = await reserve(client, "speak", tenantId, principalId);
  if (quota) return quota;

  const providerResponse = await fetch(OPENAI_SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SPEECH_MODEL,
      voice,
      input: answer,
      response_format: "mp3",
      instructions:
        "Speak as a calm, warm learning companion. Read the supplied answer faithfully without adding words.",
    }),
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  if (!providerResponse.ok || !providerResponse.body) {
    return providerError("speak", providerResponse.status, providerResponse.headers);
  }
  await meter(client, {
    action: "speak",
    model: SPEECH_MODEL,
    quantity: answer.length,
    unit: "characters",
    costMicro: answer.length * 15,
    conversationId,
  });
  return new Response(providerResponse.body, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "audio/mpeg",
      "content-disposition": 'inline; filename="assistant-answer.mp3"',
      "x-ai-generated-voice": "true",
      "x-content-type-options": "nosniff",
      "x-voice-name": voice,
      "x-voice-ratelimit-scope": "durable-tenant",
    },
  });
}

async function realtime(
  input: JsonRecord,
  client: SupabaseClient,
  credential: string,
  userId: string,
  tenantId: string,
  principalId: string,
) {
  const sdp = typeof input.sdp === "string" ? input.sdp : "";
  const voice =
    typeof input.voice === "string" ? input.voice.trim().toLowerCase() : "";
  if (
    !sdp.startsWith("v=0") ||
    new TextEncoder().encode(sdp).byteLength > MAX_SDP_BYTES ||
    !supportedVoices.has(voice)
  ) {
    return json(
      {
        ok: false,
        code: "invalid_sdp",
        message: "A bounded WebRTC session description is required.",
      },
      400,
    );
  }
  const quota = await reserve(client, "realtime", tenantId, principalId);
  if (quota) return quota;

  const session = {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions:
      "You are a calm learning voice. Automatic answers are disabled because the application grounds every turn in the tenant's published learning. When the application asks you to read a saved answer, speak that answer faithfully, without adding facts or changing its meaning.",
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: {
          model: TRANSCRIPTION_MODEL,
          language: "en",
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
          create_response: false,
          interrupt_response: true,
        },
      },
      output: { voice },
    },
  };
  const providerBody = new FormData();
  // The GA unified WebRTC interface expects two plain multipart fields. File
  // parts add filename/content-disposition metadata and are rejected by
  // `/v1/realtime/calls`, even though the underlying strings are valid.
  providerBody.set("sdp", sdp);
  providerBody.set("session", JSON.stringify(session));
  const providerResponse = await fetch(OPENAI_REALTIME_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "openai-safety-identifier": await safetyIdentifier(userId, tenantId),
    },
    body: providerBody,
    signal: AbortSignal.timeout(20_000),
  });
  const answerSdp = await providerResponse.text();
  if (!providerResponse.ok || !answerSdp.startsWith("v=0")) {
    return providerError("realtime", providerResponse.status, providerResponse.headers);
  }
  await meter(client, {
    action: "realtime",
    model: REALTIME_MODEL,
    quantity: 1,
    unit: "realtime_sessions",
    costMicro: 300_000,
  });
  return new Response(answerSdp, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/sdp",
      "x-ai-generated-voice": "true",
      "x-content-type-options": "nosniff",
      "x-voice-name": voice,
      "x-voice-transport": "webrtc",
      "x-voice-ratelimit-scope": "durable-tenant",
    },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const authenticated = await authenticate(request);
  if ("failure" in authenticated) return authenticated.failure;

  let action: VoiceAction;
  let tenantId: string;
  let input: JsonRecord = {};
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data;")) {
    // Transcription is parsed inside its action handler so the File is never
    // copied, logged, persisted, or added to a JSON object.
    action = "transcribe";
    tenantId = request.headers.get("x-learningbot-tenant-id") ?? "";
  } else {
    const declaredLength = request.headers.get("content-length");
    if (
      !contentType.startsWith("application/json") ||
      !declaredLength ||
      !/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) < 1 ||
      Number(declaredLength) > MAX_JSON_BYTES
    ) {
      return json(
        {
          ok: false,
          code: !contentType.startsWith("application/json")
            ? "invalid_content_type"
            : !declaredLength
              ? "length_required"
              : "request_too_large",
        },
        !contentType.startsWith("application/json")
          ? 415
          : !declaredLength
            ? 411
            : 413,
      );
    }
    try {
      const parsed = await request.json();
      if (!isRecord(parsed)) return json({ ok: false, code: "invalid_request" }, 400);
      input = parsed;
    } catch {
      return json({ ok: false, code: "invalid_request" }, 400);
    }
    action =
      input.action === "readiness" ||
      input.action === "speak" ||
      input.action === "realtime"
        ? input.action
        : "readiness";
    tenantId = typeof input.tenantId === "string" ? input.tenantId : "";
  }
  if (!uuidPattern.test(tenantId)) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const boundary = await resolveBoundary(
    authenticated.authClient,
    authenticated.serviceClient,
    authenticated.user.id,
    tenantId,
  );
  if ("failure" in boundary) return boundary.failure;
  if (action === "readiness") {
    return json({
      ok: true,
      configured: true,
      managedBoundary: true,
      rawAudioStored: false,
    });
  }
  if (action === "transcribe") {
    return transcribe(
      request,
      authenticated.authClient,
      boundary.credential,
      tenantId,
      boundary.principalId,
    );
  }
  if (action === "speak") {
    return speak(
      input,
      authenticated.authClient,
      boundary.credential,
      tenantId,
      boundary.principalId,
    );
  }
  return realtime(
    input,
    authenticated.authClient,
    boundary.credential,
    authenticated.user.id,
    tenantId,
    boundary.principalId,
  );
});
