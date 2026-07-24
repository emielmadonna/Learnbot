import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("production voice uses bounded ephemeral WebM transcription", () => {
  assert.match(transcriptionRoute, /MAX_AUDIO_BYTES = 10 \* 1024 \* 1024/);
  assert.match(transcriptionRoute, /"gpt-4o-mini-transcribe"/);
  assert.match(transcriptionRoute, /"audio\/webm"/);
  assert.match(transcriptionRoute, /rawAudioStored: false/);
  assert.match(transcriptionRoute, /authenticatedLearningClient\(request, \{ mutation: true \}\)/);
  assert.doesNotMatch(transcriptionRoute, /\.from\(|storage\.|writeFile|appendFile/);
});

test("voice transcript follows the durable grounded response path", () => {
  assert.match(client, /"\/api\/learning\/voice\/transcribe"/);
  assert.match(client, /submitMessage\(\s*transcript,\s*"voice"/);
  assert.match(client, /"\/api\/learning\/respond"/);
  assert.match(client, /modality,/);
  assert.match(client, /MAX_VOICE_TURN_MS = 45_000/);
});

test("speech reads a tenant-authorized saved answer with disclosed synthetic voice", () => {
  assert.match(speechRoute, /"learning_get_conversations"/);
  assert.match(speechRoute, /candidate\.actorType === "assistant"/);
  assert.match(speechRoute, /"gpt-4o-mini-tts"/);
  assert.match(speechRoute, /SPEECH_VOICE = "marin"/);
  assert.match(speechRoute, /"X-AI-Generated-Voice": "true"/);
  assert.match(client, /Push-to-talk, not realtime · AI-generated voice/);
});

test("voice lifecycle stops microphone, requests, playback, and object URLs", () => {
  assert.match(client, /voiceRequestRef\.current\?\.abort\(\)/);
  assert.match(client, /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(client, /playbackRef\.current\?\.pause\(\)/);
  assert.match(client, /URL\.revokeObjectURL/);
  assert.match(client, /discardRecordingRef\.current = true/);
});
