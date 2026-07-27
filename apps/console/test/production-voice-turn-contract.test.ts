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
import { DEFAULT_VOICE, SUPPORTED_VOICES } from "../src/lib/voice-runtime";

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

test("production voice uses bounded ephemeral WebM transcription", () => {
  assert.match(transcriptionRoute, /"gpt-4o-mini-transcribe"/);
  assert.match(transcriptionRoute, /rawAudioStored: false/);
  assert.match(transcriptionRoute, /voiceTenantContext\(request, true\)/);
  assert.match(transcriptionRoute, /context\.membershipId/);
  assert.match(transcriptionRoute, /validDeclaredDuration/);
  assert.doesNotMatch(transcriptionRoute, /\.from\(|storage\.|writeFile|appendFile/);
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
  assert.match(speechRoute, /"gpt-4o-mini-tts"/);
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
  assert.equal(DEFAULT_VOICE, "marin");
  assert.ok((SUPPORTED_VOICES as readonly string[]).includes("cedar"));
});

test("voice quota is decided durably, not by a per-process map", () => {
  // The process map reset on every serverless cold start, so it bounded
  // nothing. SQL is now authoritative for all three voice routes.
  for (const route of [transcriptionRoute, speechRoute, realtimeRoute]) {
    assert.match(route, /await enforceVoiceQuota\(/);
    assert.doesNotMatch(route, /consumeVoiceQuota\(/);
  }
});

test("every voice provider call is metered", () => {
  assert.match(transcriptionRoute, /meterVoiceUsage\([\s\S]*"audio_seconds"/);
  assert.match(speechRoute, /meterVoiceUsage\([\s\S]*"characters"/);
  assert.match(realtimeRoute, /meterVoiceUsage\([\s\S]*"realtime_sessions"/);
});
