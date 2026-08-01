import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  acceptedAudioType,
  MAX_MULTIPART_BYTES,
  multipartHeaderError,
  validDeclaredDuration,
} from "../src/app/api/learning/voice/policy";
import {
  consumeVoiceQuota,
  resetVoiceQuotaForTests,
} from "../src/app/api/learning/voice/rate-limit";

const client = readFileSync(
  new URL(
    "../src/app/app/conversation/conversation-client.tsx",
    import.meta.url,
  ),
  "utf8",
);
const transcriptionRoute = readFileSync(
  new URL(
    "../src/app/api/learning/voice/transcribe/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const speechRoute = readFileSync(
  new URL(
    "../src/app/api/learning/voice/speak/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const realtimeRoute = readFileSync(
  new URL(
    "../src/app/api/learning/voice/realtime/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const managedVoiceRoute = readFileSync(
  new URL("../src/lib/supabase/managed-voice.ts", import.meta.url),
  "utf8",
);
const managedVoiceProvider = readFileSync(
  new URL(
    "../../../infra/supabase/functions/learning-provider-voice/index.ts",
    import.meta.url,
  ),
  "utf8",
);
const supabaseConfig = readFileSync(
  new URL("../../../infra/supabase/config.toml", import.meta.url),
  "utf8",
);
const voiceRuntime = readFileSync(
  new URL("../src/lib/voice-runtime.ts", import.meta.url),
  "utf8",
);

test("production voice uses bounded ephemeral WebM transcription", () => {
  assert.match(managedVoiceProvider, /"gpt-4o-mini-transcribe"/);
  assert.match(managedVoiceProvider, /rawAudioStored: false/);
  assert.match(transcriptionRoute, /voiceTenantContext\(request, true\)/);
  assert.match(transcriptionRoute, /!context\.membershipId/);
  assert.match(transcriptionRoute, /validDeclaredDuration/);
  assert.match(managedVoiceProvider, /MAX_AUDIO_BYTES = 10 \* 1024 \* 1024/);
  assert.doesNotMatch(
    managedVoiceProvider,
    /storage\.|writeFile|appendFile/,
  );
});

test("voice transcript follows the durable grounded response path", () => {
  assert.match(client, /"\/api\/learning\/voice\/transcribe"/);
  assert.match(client, /submitMessage\(\s*transcript,\s*"voice"/);
  assert.match(client, /"\/api\/learning\/respond"/);
  assert.match(client, /modality,/);
  assert.match(client, /MAX_VOICE_TURN_MS = 45_000/);
  assert.match(client, /"\/api\/learning\/voice\/transcribe"[\s\S]*cache: "no-store"/);
  assert.match(client, /voiceReadiness !== "ready"/);
});

test("speech reads a tenant-authorized saved answer with disclosed synthetic voice", () => {
  assert.match(speechRoute, /"learning_get_conversations"/);
  assert.match(speechRoute, /candidate\.actorType === "assistant"/);
  assert.match(managedVoiceProvider, /"gpt-4o-mini-tts"/);
  assert.match(speechRoute, /voice: voiceProfile\.voice/);
  assert.match(speechRoute, /"X-AI-Generated-Voice": "true"/);
  assert.match(
    client,
    /Continuous WebRTC voice · automatic turn detection · AI-generated voice · raw audio is not retained/,
  );
  assert.match(
    client,
    /Secure push-to-talk fallback · AI-generated voice · raw audio is not retained/,
  );
});

test("voice lifecycle stops microphone, requests, playback, and object URLs", () => {
  assert.match(client, /voiceRequestRef\.current\?\.abort\(\)/);
  assert.match(client, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(client, /playbackRef\.current\?\.pause\(\)/);
  assert.match(client, /URL\.revokeObjectURL/);
  assert.match(client, /discardRecordingRef\.current = true/);
  assert.match(client, /resetConversationContext\(\)[\s\S]*voiceGenerationRef\.current \+= 1/);
  assert.match(client, /Play \{assistantName\}/);
});

test("voice media policy accepts browser WebM and MP4 families", () => {
  assert.deepEqual(acceptedAudioType("audio/webm;codecs=opus"), {
    extension: "webm",
    providerType: "audio/webm",
  });
  assert.deepEqual(acceptedAudioType("audio/mp4;codecs=mp4a.40.2"), {
    extension: "m4a",
    providerType: "audio/mp4",
  });
  assert.deepEqual(acceptedAudioType("audio/x-m4a"), {
    extension: "m4a",
    providerType: "audio/mp4",
  });
  assert.deepEqual(acceptedAudioType("audio/aac"), {
    extension: "aac",
    providerType: "audio/aac",
  });
  assert.equal(acceptedAudioType("application/octet-stream"), null);
});

test("voice media policy rejects missing bounds and overlong turns", () => {
  assert.equal(validDeclaredDuration("100"), 100);
  assert.equal(validDeclaredDuration("45000"), 45_000);
  assert.equal(validDeclaredDuration("45001"), null);
  assert.equal(validDeclaredDuration(null), null);

  assert.equal(multipartHeaderError(new Headers()), "invalid_content_type");
  const noLength = new Headers({
    "content-type": "multipart/form-data; boundary=test",
  });
  assert.equal(multipartHeaderError(noLength), "length_required");
  const oversized = new Headers({
    "content-type": "multipart/form-data; boundary=test",
    "content-length": String(MAX_MULTIPART_BYTES + 1),
  });
  assert.equal(multipartHeaderError(oversized), "audio_too_large");
  const accepted = new Headers({
    "content-type": "multipart/form-data; boundary=test",
    "content-length": "1024",
  });
  assert.equal(multipartHeaderError(accepted), null);
});

test("process voice quota is bounded per tenant principal and resets", () => {
  resetVoiceQuotaForTests();
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      consumeVoiceQuota("transcribe", "tenant-a:principal-a", 1_000).allowed,
      true,
    );
  }
  const denied = consumeVoiceQuota(
    "transcribe",
    "tenant-a:principal-a",
    1_000,
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, "process-instance");
  assert.equal(denied.retryAfterSeconds, 60);
  assert.equal(
    consumeVoiceQuota("transcribe", "tenant-a:principal-b", 1_000).allowed,
    true,
  );
  assert.equal(
    consumeVoiceQuota("transcribe", "tenant-a:principal-a", 61_000).allowed,
    true,
  );
  resetVoiceQuotaForTests();
});

test("voice speaks the tenant's configured voice, never a hardcoded one", () => {
  // `tenant_branding.agent_voice` was editable, displayed, and read by nothing:
  // a white-label client chose a voice and heard "marin".
  for (const route of [speechRoute, realtimeRoute]) {
    assert.match(route, /resolveTenantVoice\(/);
    assert.doesNotMatch(route, /"marin"/);
  }
  assert.match(voiceRuntime, /DEFAULT_VOICE = "marin"/);
  assert.match(voiceRuntime, /SUPPORTED_VOICES[\s\S]*"cedar"/);
});

test("voice quota is decided durably, not by a per-process map", () => {
  // The provider boundary itself reserves quota, so a caller cannot bypass it
  // by invoking the JWT-protected function directly.
  for (const route of [transcriptionRoute, speechRoute, realtimeRoute]) {
    assert.doesNotMatch(route, /consumeVoiceQuota\(/);
    assert.match(route, /invokeManagedVoice\(/);
  }
  assert.match(managedVoiceProvider, /learning_reserve_provider_call/);
  assert.match(managedVoiceProvider, /voice\.transcribe/);
  assert.match(managedVoiceProvider, /voice\.speak/);
  assert.match(managedVoiceProvider, /voice\.realtime/);
});

test("every voice provider call is metered", () => {
  assert.match(managedVoiceProvider, /learning_record_provider_cost/);
  assert.match(
    managedVoiceProvider,
    /action: "transcribe"[\s\S]*unit: "audio_seconds"/,
  );
  assert.match(
    managedVoiceProvider,
    /action: "speak"[\s\S]*unit: "characters"/,
  );
  assert.match(
    managedVoiceProvider,
    /action: "realtime"[\s\S]*unit: "realtime_sessions"/,
  );
});

test("managed voice never requires or exposes a provider key in Next", () => {
  for (const route of [
    transcriptionRoute,
    speechRoute,
    realtimeRoute,
    managedVoiceRoute,
  ]) {
    assert.doesNotMatch(route, /OPENAI_API_KEY/);
    assert.doesNotMatch(route, /api\.openai\.com/);
  }
  assert.match(managedVoiceRoute, /functions\/v1\/learning-provider-voice/);
  assert.match(managedVoiceProvider, /learning_provider_runtime_credential/);
  assert.match(managedVoiceProvider, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.match(
    supabaseConfig,
    /\[functions\.learning-provider-voice\]\s+verify_jwt = true/u,
  );
});

test("managed voice revalidates identity, tenant, and managed access", () => {
  assert.match(managedVoiceProvider, /authClient\.auth\.getUser/);
  assert.match(managedVoiceProvider, /auth_current_access_state/);
  assert.match(managedVoiceProvider, /must_change_password/);
  assert.match(managedVoiceProvider, /auth_current_tenant_context/);
  assert.match(managedVoiceProvider, /context\.tenant_id !== tenantId/);
  assert.match(managedVoiceProvider, /MAX_JSON_BYTES = 64 \* 1024/);
  assert.match(managedVoiceProvider, /MAX_SDP_BYTES = 32 \* 1024/);
});

test("GA realtime WebRTC uses plain unified-interface multipart fields", () => {
  assert.match(
    managedVoiceProvider,
    /providerBody\.set\("sdp", sdp\)/,
  );
  assert.match(
    managedVoiceProvider,
    /providerBody\.set\("session", JSON\.stringify\(session\)\)/,
  );
  assert.doesNotMatch(
    managedVoiceProvider,
    /providerBody\.set\(\s*"sdp",\s*new Blob/u,
  );
});
