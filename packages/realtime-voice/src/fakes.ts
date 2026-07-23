import { AsyncQueue } from "./async-queue.js";
import type {
  AdapterOpenOptions,
  AdapterResumeOptions,
  EphemeralClientSessionDescriptor,
  RealtimeVoiceAdapter,
  RealtimeVoiceTransport,
  VoiceAdapterConnection,
  VoiceAdapterError,
  VoiceAdapterEvent,
  VoiceAdapterOutcome,
  VoiceClock,
  VoiceCostEvent,
  VoiceCostSink,
  VoiceIdFactory,
  VoiceResumeCheckpoint,
  VoiceSessionContext,
  VoiceSleeper,
  VoiceUsageEvent,
  VoiceUsageSink,
} from "./types.js";

export class FakeRealtimeVoiceTransport implements RealtimeVoiceTransport {
  readonly #events = new AsyncQueue<VoiceAdapterEvent>();
  readonly audioChunks: Uint8Array[] = [];
  readonly textInputs: string[] = [];
  commitCount = 0;
  interruptCount = 0;
  readonly closeReasons: string[] = [];

  constructor(readonly providerSessionId: string) {}

  async sendAudio(chunk: Uint8Array): Promise<void> {
    this.audioChunks.push(chunk.slice());
  }

  async commitTurn(): Promise<void> {
    this.commitCount += 1;
  }

  async sendText(text: string): Promise<void> {
    this.textInputs.push(text);
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  events(): AsyncIterable<VoiceAdapterEvent> {
    return this.#events;
  }

  async close(reason: string): Promise<void> {
    this.closeReasons.push(reason);
    this.#events.close();
  }

  emit(event: VoiceAdapterEvent): void {
    this.#events.push(event);
  }

  end(): void {
    this.#events.close();
  }
}

export type FakeAdapterStep =
  | {
      readonly type: "success";
      readonly transport: FakeRealtimeVoiceTransport;
      readonly descriptor?: Partial<EphemeralClientSessionDescriptor>;
    }
  | { readonly type: "failure"; readonly error: VoiceAdapterError }
  | { readonly type: "throw"; readonly error: Error };

export interface FakeRealtimeVoiceAdapterOptions {
  readonly id?: string;
  readonly provider?: string;
  readonly nowMs: number;
  readonly openSteps: readonly FakeAdapterStep[];
  readonly resumeSteps?: readonly FakeAdapterStep[];
}

export class FakeRealtimeVoiceAdapter implements RealtimeVoiceAdapter {
  readonly id: string;
  readonly provider: string;
  readonly openCalls: Array<{
    readonly context: VoiceSessionContext;
    readonly options: AdapterOpenOptions;
  }> = [];
  readonly resumeCalls: Array<{
    readonly context: VoiceSessionContext;
    readonly checkpoint: VoiceResumeCheckpoint;
    readonly options: AdapterResumeOptions;
  }> = [];
  #openIndex = 0;
  #resumeIndex = 0;

  constructor(readonly fixture: FakeRealtimeVoiceAdapterOptions) {
    this.id = fixture.id ?? "fake-realtime";
    this.provider = fixture.provider ?? "fake:realtime";
  }

  async openSession(
    context: VoiceSessionContext,
    options: AdapterOpenOptions,
  ): Promise<VoiceAdapterOutcome<VoiceAdapterConnection>> {
    this.openCalls.push({ context, options });
    return this.#resolveStep(
      this.fixture.openSteps,
      this.#openIndex++,
      context,
    );
  }

  async resumeSession(
    context: VoiceSessionContext,
    checkpoint: VoiceResumeCheckpoint,
    options: AdapterResumeOptions,
  ): Promise<VoiceAdapterOutcome<VoiceAdapterConnection>> {
    this.resumeCalls.push({ context, checkpoint, options });
    return this.#resolveStep(
      this.fixture.resumeSteps ?? [],
      this.#resumeIndex++,
      context,
    );
  }

  #resolveStep(
    steps: readonly FakeAdapterStep[],
    index: number,
    context: VoiceSessionContext,
  ): VoiceAdapterOutcome<VoiceAdapterConnection> {
    const step = steps[Math.min(index, steps.length - 1)];
    if (step === undefined) {
      return {
        ok: false,
        error: {
          code: "provider_unavailable",
          retryable: false,
        },
      };
    }
    if (step.type === "throw") throw step.error;
    if (step.type === "failure") return { ok: false, error: step.error };
    return {
      ok: true,
      value: {
        descriptor: {
          credentialKind: "ephemeral",
          clientToken: `ephemeral-${step.transport.providerSessionId}`,
          expiresAt: new Date(this.fixture.nowMs + 5 * 60_000).toISOString(),
          endpoint: "wss://voice.invalid/realtime",
          adapterId: this.id,
          provider: this.provider,
          providerSessionId: step.transport.providerSessionId,
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          sessionId: context.sessionId,
          ...step.descriptor,
        },
        transport: step.transport,
      },
    };
  }
}

export class MemoryVoiceUsageSink implements VoiceUsageSink {
  readonly events: VoiceUsageEvent[] = [];

  async recordUsage(event: VoiceUsageEvent): Promise<void> {
    this.events.push(event);
  }
}

export class MemoryVoiceCostSink implements VoiceCostSink {
  readonly events: VoiceCostEvent[] = [];

  async recordCost(event: VoiceCostEvent): Promise<void> {
    this.events.push(event);
  }
}

export class DeterministicVoiceRuntime
  implements VoiceClock, VoiceSleeper, VoiceIdFactory
{
  readonly sleepCalls: number[] = [];
  #id = 0;

  constructor(public currentMs: number) {}

  nowMs(): number {
    return this.currentMs;
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.sleepCalls.push(ms);
    this.currentMs += ms;
  }

  next(prefix: string): string {
    this.#id += 1;
    return `${prefix}_${this.#id}`;
  }
}
