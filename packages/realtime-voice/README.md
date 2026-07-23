# Realtime voice

`@course-ai/realtime-voice` is the provider-neutral orchestration boundary for
low-latency voice conversations. It keeps voice and text in one durable
conversation while isolating provider transports behind a small adapter
interface.

## Guarantees

- Every session carries an explicit tenant, actor, request, trace,
  conversation, browser session, funding source and absolute deadline.
- The lifecycle is an enforced state machine:
  `idle → opening → connected ↔ listening/responding → reconnecting`, ending
  in `text_handoff`, `closed` or `failed`.
- Adapter-specific events are normalized into input audio, partial/final
  transcript, assistant text/audio, turn, usage, cost, reconnect and safe
  error events.
- Barge-in and cancellation interrupt the active provider turn. Locally
  interrupted turns cannot later be overwritten by a delayed completion.
- Reconnect uses an exact tenant/session checkpoint, bounded exponential
  backoff and the original request deadline. Replayed provider sequence
  numbers are ignored, which also prevents duplicated usage/cost recording.
- The client descriptor contains only a short-lived scoped token. Long-lived
  credentials are represented by an opaque `secretRef` that is passed only to
  the adapter and stripped from descriptors, events and errors.
- Voice-created and text-created turns retain the same conversation ID. A
  text handoff carries the safe turn transcript needed by the shared
  conversation service.

## Adapter boundary

Implement `RealtimeVoiceAdapter` without leaking an SDK type into this
package. An adapter opens or resumes a `RealtimeVoiceTransport`, normalizes its
events, and mints an `EphemeralClientSessionDescriptor` scoped to the exact
tenant/conversation/session tuple.

The descriptor is rejected when its scope, adapter, provider or provider
session differs from the requested session; when it is expired; or when its
lifetime exceeds 15 minutes.

`secretRef` is an opaque Vault or secret-manager handle. An adapter resolves
it on the trusted server. It must never treat the value itself as a provider
credential and must never echo it.

## Usage

```ts
const orchestrator = new RealtimeVoiceOrchestrator({
  adapter,
  usageSink,
  costSink,
});

const outcome = await orchestrator.start({
  context: {
    requestId,
    traceId,
    tenantId,
    actorId,
    conversationId,
    sessionId,
    fundingSource: "tenant_byok",
    deadlineMs,
  },
  options: {
    voiceId: "guide",
    mode: "tap_to_start",
    enableBargeIn: true,
    inputMediaType: "audio/pcm;rate=24000",
    outputMediaType: "audio/pcm;rate=24000",
    reconnect: {
      maxAttempts: 3,
      initialBackoffMs: 150,
      maxBackoffMs: 1_000,
    },
    secretRef: "vault://tenant/realtime-provider",
  },
});
```

Consume `session.events()` once; it is a single-consumer ordered stream.
`sendText()` is intentionally available on the same session as
`sendAudio()`. Use `handoffToText()` when realtime voice becomes unavailable
or the user switches modes.

## Validation

```sh
pnpm --filter @course-ai/realtime-voice typecheck
pnpm --filter @course-ai/realtime-voice build
pnpm --filter @course-ai/realtime-voice test
```

The deterministic suite covers provider neutrality, the full lifecycle,
normalized multimodal events, usage/cost hooks, barge-in, cancellation,
bounded reconnect, shared deadlines, open/resume scope mismatch, secret
redaction and text continuity.

## Integration still required

- Register production adapters and select them through the platform's route
  policy/provider-router composition root.
- Back `VoiceUsageSink` and `VoiceCostSink` with the durable idempotent
  telemetry outbox and immutable cost ledger.
- Connect final transcripts and text handoffs to the application
  conversation service so durable messages and citations share one history.
- Add the authenticated endpoint that mints the client descriptor and the
  browser WebRTC/WebSocket transport.
- Define provider-specific session expiry refresh behavior inside adapters;
  this core deliberately contains no named provider SDK.
