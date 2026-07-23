# Voice Mode

Voice is an optional modality of the Student Widget, not a separate product. Text and voice write into the same conversation and message history.

**Locked definition:** conversational voice is a realtime, bidirectional,
streaming session. Capturing a complete recording and uploading it as one
message is an attachment feature, not Voice Mode.

## Session contract

```ts
interface RealtimeVoiceSession {
  id: string;
  sendAudio(chunk: Uint8Array): Promise<void>;
  commitTurn(): Promise<void>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<
    | {type:"transcript.partial"; text:string}
    | {type:"transcript.final"; text:string; confidence?:number}
    | {type:"response.delta"; text:string}
    | {type:"audio.chunk"; bytes:Uint8Array}
    | {type:"turn.end"} | {type:"error"; code:string}
  >;
  close(reason:string): Promise<void>;
}
```

## Modes and continuity

- Push-to-talk: audio is sent while pressed; release commits turn.
- Tap-to-start: explicit start opens a conversational session; tap/end closes.
- Barge-in: detected Student speech cancels current generation/playback, records interruption and starts a new turn.
- Turn state is explicit: `connecting → listening → thinking → speaking`, with
  `listening` reachable directly from `speaking` through barge-in.
- Partial transcripts are captions, not durable messages; final transcript becomes the user message.
- Assistant text is persisted even when spoken; partial unplayed output is marked interrupted.

## Latency budgets

Target budgets (subject to prototype measurement, not provider promises): permission-to-ready <1s excluding user action; partial transcript p95 <500ms after speech; end-of-turn to first text p95 <1.5s; end-of-turn to first audio p95 <2.5s; barge-in playback stop <200ms. UI communicates processing beyond 800ms. Failed budget triggers telemetry and may degrade to text.

## Consent, privacy and retention

Microphone use requires browser permission and an in-product explanation. Active capture and recording states are always visible. Recording is distinct from transient transport. Default planning assumption: no raw recording stored until O-07 is approved. Transcripts follow configured data retention.

Voice selection is Tenant-controlled from approved voices. Cloned/custom voices require a `consents` record naming Creator, purpose, voice, terms/version, grant evidence and revocation. Revocation disables new use; retained artifacts follow approved policy. No inferred or implicit cloning consent.

## Accessibility and mobile

Captions remain available; all controls have labels and keyboard/touch equivalents; text mode is always reachable. Respect reduced motion and OS/browser audio routing. Handle mobile autoplay/background/interruption rules, Bluetooth changes, calls, locked screen and safe-area layout.

## Failure matrix

Permission denial → text mode; STT failure → retry or type; LLM failure → preserved final transcript and retry; TTS failure → show text; realtime failure → close cleanly and continue text; network loss → stop capture/playback, state uncertainty honestly, avoid duplicate committed turns.

Cost entries include STT audio duration, TTS characters/audio duration, realtime session duration/tokens and every fallback leg.
