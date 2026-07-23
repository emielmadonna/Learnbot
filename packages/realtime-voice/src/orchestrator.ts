import type { IsoTimestamp } from "@course-ai/contracts";
import { AsyncQueue } from "./async-queue.js";
import { mismatchError, normalizeVoiceError } from "./errors.js";
import {
  AbortableVoiceSleeper,
  RandomVoiceIdFactory,
  SystemVoiceClock,
} from "./runtime.js";
import type {
  ConversationTurnSnapshot,
  EphemeralClientSessionDescriptor,
  NormalizedVoiceError,
  RealtimeVoiceAdapter,
  RealtimeVoiceOrchestratorDependencies,
  RealtimeVoiceSession,
  RealtimeVoiceTransport,
  StartVoiceSessionInput,
  StartVoiceSessionOutcome,
  TextConversationHandoff,
  VoiceAdapterConnection,
  VoiceAdapterEvent,
  VoiceClock,
  VoiceCostSink,
  VoiceCostEvent,
  VoiceIdFactory,
  VoiceSessionContext,
  VoiceSessionEvent,
  VoiceSessionOptions,
  VoiceSessionState,
  VoiceSleeper,
  VoiceUsageSink,
  VoiceUsageEvent,
} from "./types.js";

const MAX_EPHEMERAL_LIFETIME_MS = 15 * 60_000;
const ALLOWED_TRANSITIONS: Readonly<
  Record<VoiceSessionState, readonly VoiceSessionState[]>
> = {
  idle: ["opening"],
  opening: ["connected", "failed"],
  connected: [
    "listening",
    "responding",
    "reconnecting",
    "text_handoff",
    "closing",
    "failed",
  ],
  listening: [
    "connected",
    "responding",
    "reconnecting",
    "text_handoff",
    "closing",
    "failed",
  ],
  responding: [
    "connected",
    "listening",
    "reconnecting",
    "text_handoff",
    "closing",
    "failed",
  ],
  reconnecting: ["connected", "text_handoff", "closing", "failed"],
  text_handoff: [],
  closing: ["closed", "failed"],
  closed: [],
  failed: [],
};

export class RealtimeVoiceOrchestrator {
  readonly #dependencies: Required<
    Pick<RealtimeVoiceOrchestratorDependencies, "clock" | "sleeper" | "ids">
  > &
    Omit<RealtimeVoiceOrchestratorDependencies, "clock" | "sleeper" | "ids">;

  constructor(dependencies: RealtimeVoiceOrchestratorDependencies) {
    this.#dependencies = {
      ...dependencies,
      clock: dependencies.clock ?? new SystemVoiceClock(),
      sleeper: dependencies.sleeper ?? new AbortableVoiceSleeper(),
      ids: dependencies.ids ?? new RandomVoiceIdFactory(),
    };
  }

  async start(
    input: StartVoiceSessionInput,
  ): Promise<StartVoiceSessionOutcome> {
    const validationError = validateStartInput(
      input.context,
      input.options,
      this.#dependencies.clock.nowMs(),
    );
    if (validationError !== undefined) {
      return { ok: false, error: validationError };
    }

    const managed = new ManagedRealtimeVoiceSession(
      input.context,
      input.options,
      this.#dependencies,
    );
    const opened = await managed.open();
    if (!opened.ok) return opened;
    return { ok: true, session: managed };
  }
}

type ManagedDependencies = {
  readonly adapter: RealtimeVoiceAdapter;
  readonly usageSink: VoiceUsageSink;
  readonly costSink: VoiceCostSink;
  readonly clock: VoiceClock;
  readonly sleeper: VoiceSleeper;
  readonly ids: VoiceIdFactory;
};

class ManagedRealtimeVoiceSession implements RealtimeVoiceSession {
  readonly #events = new AsyncQueue<VoiceSessionEvent>();
  readonly #abort = new AbortController();
  readonly #turns = new Map<string, MutableTurn>();
  readonly #pendingTextInputs: string[] = [];
  readonly #options: VoiceSessionOptions;
  readonly #dependencies: ManagedDependencies;
  #state: VoiceSessionState = "idle";
  #descriptor: EphemeralClientSessionDescriptor | undefined;
  #transport: RealtimeVoiceTransport | undefined;
  #generation = 0;
  #lastEventSequence = 0;
  #lastProviderEventSequence = 0;
  #lastCompletedTurnId: string | undefined;
  #activeTurnId: string | undefined;
  #reconnectPromise: Promise<void> | undefined;

  constructor(
    readonly context: VoiceSessionContext,
    options: VoiceSessionOptions,
    dependencies: ManagedDependencies,
  ) {
    this.#options = options;
    this.#dependencies = dependencies;
  }

  get state(): VoiceSessionState {
    return this.#state;
  }

  get clientDescriptor(): EphemeralClientSessionDescriptor {
    if (this.#descriptor === undefined) {
      throw new Error("Realtime voice session has not opened.");
    }
    return this.#descriptor;
  }

  async open(): Promise<
    | { readonly ok: true; readonly session: RealtimeVoiceSession }
    | { readonly ok: false; readonly error: NormalizedVoiceError }
  > {
    this.#transition("opening");
    try {
      const result = await this.#dependencies.adapter.openSession(
        this.context,
        adapterOpenOptions(this.#options, this.#abort.signal),
      );
      if (!result.ok) {
        const error = normalizeVoiceError(
          result.error,
          this.#dependencies.adapter.id,
          sensitiveValues(this.#options),
        );
        this.#fail(error);
        return { ok: false, error };
      }
      const scopeError = validateConnection(
        result.value,
        this.context,
        this.#dependencies,
        this.#options,
      );
      if (scopeError !== undefined) {
        await safeClose(result.value.transport, "invalid_session_scope");
        this.#fail(scopeError);
        return { ok: false, error: scopeError };
      }
      this.#installConnection(result.value);
      this.#transition("connected");
      this.#startPump(result.value.transport, this.#generation);
      return { ok: true, session: this };
    } catch (error) {
      const normalized = normalizeVoiceError(
        error,
        this.#dependencies.adapter.id,
        sensitiveValues(this.#options),
      );
      this.#fail(normalized);
      return { ok: false, error: normalized };
    }
  }

  async sendAudio(chunk: Uint8Array): Promise<void> {
    this.#assertInteractive();
    if (chunk.byteLength === 0) {
      throw new TypeError("Audio chunk must not be empty.");
    }
    if (this.#state === "responding") {
      if (!this.#options.enableBargeIn) {
        throw new Error("Audio cannot be sent while the assistant is responding.");
      }
      await this.bargeIn();
    }
    await this.#requireTransport().sendAudio(chunk);
    this.#lastEventSequence += 1;
    this.#events.push({
      type: "input.audio",
      sequence: this.#lastEventSequence,
      byteLength: chunk.byteLength,
    });
    if (this.#state === "connected") this.#transition("listening");
  }

  async commitTurn(): Promise<void> {
    this.#assertInteractive();
    if (this.#state !== "listening" && this.#state !== "connected") {
      throw new Error(`Cannot commit audio while session is ${this.#state}.`);
    }
    await this.#requireTransport().commitTurn();
    this.#transition("responding");
  }

  async sendText(text: string): Promise<void> {
    this.#assertInteractive();
    const normalized = text.trim();
    if (normalized.length === 0) {
      throw new TypeError("Text input must not be empty.");
    }
    if (this.#state === "responding") {
      await this.cancelTurn();
    }
    await this.#requireTransport().sendText(normalized);
    this.#pendingTextInputs.push(normalized);
    this.#events.push({
      type: "input.text",
      text: normalized,
      conversationId: this.context.conversationId,
    });
    this.#transition("responding");
  }

  async bargeIn(): Promise<void> {
    this.#assertInteractive();
    if (!this.#options.enableBargeIn) {
      throw new Error("Barge-in is disabled for this session.");
    }
    if (this.#state !== "responding") {
      throw new Error(`Cannot barge in while session is ${this.#state}.`);
    }
    await this.#requireTransport().interrupt();
    this.#markActiveTurnInterrupted();
    this.#transition("listening");
  }

  async cancelTurn(): Promise<void> {
    this.#assertInteractive();
    if (this.#state !== "responding" && this.#state !== "listening") {
      throw new Error(`Cannot cancel a turn while session is ${this.#state}.`);
    }
    await this.#requireTransport().interrupt();
    this.#markActiveTurnInterrupted();
    this.#transition("connected");
  }

  async handoffToText(
    reason: TextConversationHandoff["reason"] = "user_requested",
  ): Promise<TextConversationHandoff> {
    if (isTerminal(this.#state)) {
      throw new Error(`Cannot hand off a session that is ${this.#state}.`);
    }
    const handoff: TextConversationHandoff = {
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      requestId: this.context.requestId,
      traceId: this.context.traceId,
      conversationId: this.context.conversationId,
      sessionId: this.context.sessionId,
      fundingSource: this.context.fundingSource,
      modality: "text",
      reason,
      turns: this.#turnSnapshots(),
      lastEventSequence: this.#lastEventSequence,
    };
    this.#transition("text_handoff");
    this.#events.push({ type: "session.text_handoff", handoff });
    this.#abort.abort("text_handoff");
    if (this.#transport !== undefined) {
      await safeClose(this.#transport, "text_handoff");
    }
    this.#events.close();
    return handoff;
  }

  async close(reason = "user_closed"): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "text_handoff") return;
    if (this.#state === "failed") {
      this.#events.close();
      return;
    }
    this.#transition("closing");
    this.#abort.abort(reason);
    if (this.#transport !== undefined) {
      await safeClose(this.#transport, reason);
    }
    this.#transition("closed");
    this.#events.close();
  }

  events(): AsyncIterable<VoiceSessionEvent> {
    return this.#events;
  }

  #installConnection(connection: VoiceAdapterConnection): void {
    const descriptor = connection.descriptor;
    this.#descriptor = {
      credentialKind: "ephemeral",
      clientToken: descriptor.clientToken,
      expiresAt: descriptor.expiresAt,
      endpoint: descriptor.endpoint,
      adapterId: descriptor.adapterId,
      provider: descriptor.provider,
      providerSessionId: descriptor.providerSessionId,
      tenantId: descriptor.tenantId,
      conversationId: descriptor.conversationId,
      sessionId: descriptor.sessionId,
    };
    this.#transport = connection.transport;
    this.#generation += 1;
  }

  #startPump(transport: RealtimeVoiceTransport, generation: number): void {
    void this.#pump(transport, generation);
  }

  async #pump(
    transport: RealtimeVoiceTransport,
    generation: number,
  ): Promise<void> {
    try {
      for await (const event of transport.events()) {
        if (generation !== this.#generation || isTerminal(this.#state)) return;
        if (containsSensitiveValue(event, sensitiveValues(this.#options))) {
          this.#fail(
            normalizeVoiceError(
              { code: "protocol_error", retryable: false },
              this.#dependencies.adapter.id,
            ),
          );
          return;
        }
        if (event.sequence <= this.#lastProviderEventSequence) continue;
        this.#lastProviderEventSequence = event.sequence;
        this.#lastEventSequence = Math.max(
          this.#lastEventSequence,
          event.sequence,
        );
        if (event.type === "disconnected") {
          if (event.retryable) {
            await this.#reconnect();
          } else {
            this.#fail(
              normalizeVoiceError(
                {
                  code: "connection_lost",
                  retryable: false,
                  safeDetails: { reasonCode: event.reasonCode },
                },
                this.#dependencies.adapter.id,
                sensitiveValues(this.#options),
              ),
            );
          }
          return;
        }
        if (event.type === "error") {
          const normalized = normalizeVoiceError(
            event.error,
            this.#dependencies.adapter.id,
            sensitiveValues(this.#options),
          );
          this.#events.push({ type: "error", error: normalized });
          if (event.error.retryable) {
            await this.#reconnect();
          } else {
            this.#fail(normalized, false);
          }
          return;
        }
        await this.#handleAdapterEvent(event);
      }
    } catch (error) {
      if (generation !== this.#generation || isTerminal(this.#state)) return;
      const normalized = normalizeVoiceError(
        error,
        this.#dependencies.adapter.id,
        sensitiveValues(this.#options),
      );
      this.#events.push({ type: "error", error: normalized });
      if (normalized.retryable) {
        await this.#reconnect();
      } else {
        this.#fail(normalized, false);
      }
    }
  }

  async #handleAdapterEvent(event: Exclude<
    VoiceAdapterEvent,
    { readonly type: "disconnected" | "error" }
  >): Promise<void> {
    const conversationId = this.context.conversationId;
    switch (event.type) {
      case "input_audio.accepted":
        return;
      case "transcript.partial":
        this.#events.push({
          type: "transcript.partial",
          sequence: event.sequence,
          text: event.text,
        });
        return;
      case "transcript.final": {
        const turn = this.#turn(event.turnId);
        turn.userText = event.text;
        this.#events.push({
          ...event,
          conversationId,
        });
        return;
      }
      case "assistant.text.delta": {
        const turn = this.#turn(event.turnId);
        turn.assistantText = `${turn.assistantText ?? ""}${event.text}`;
        this.#events.push({ ...event, conversationId });
        return;
      }
      case "assistant.text.final": {
        const turn = this.#turn(event.turnId);
        turn.assistantText = event.text;
        this.#events.push({ ...event, conversationId });
        return;
      }
      case "assistant.audio.delta":
        this.#events.push({
          type: "assistant.audio",
          sequence: event.sequence,
          chunk: event.chunk,
          turnId: event.turnId,
          conversationId,
        });
        return;
      case "turn.started": {
        this.#activeTurnId = event.turnId;
        const turn = this.#turn(event.turnId);
        const pendingText = this.#pendingTextInputs.shift();
        if (pendingText !== undefined && turn.userText === undefined) {
          turn.userText = pendingText;
        }
        if (this.#state !== "responding") this.#transition("responding");
        this.#events.push({ ...event, conversationId });
        return;
      }
      case "turn.completed": {
        const turn = this.#turn(event.turnId);
        if (turn.status === "interrupted") return;
        turn.status = "complete";
        this.#lastCompletedTurnId = event.turnId;
        this.#activeTurnId = undefined;
        this.#events.push({ ...event, conversationId });
        if (this.#state === "responding") this.#transition("connected");
        return;
      }
      case "turn.interrupted": {
        const turn = this.#turn(event.turnId);
        if (turn.status === "interrupted") return;
        turn.status = "interrupted";
        if (this.#activeTurnId === event.turnId) this.#activeTurnId = undefined;
        this.#events.push({ ...event, conversationId });
        return;
      }
      case "usage":
        await this.#recordUsage(event);
        return;
    }
  }

  async #recordUsage(
    event: Extract<VoiceAdapterEvent, { readonly type: "usage" }>,
  ): Promise<void> {
    const occurredAt = new Date(this.#dependencies.clock.nowMs()).toISOString();
    const common = {
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      requestId: this.context.requestId,
      traceId: this.context.traceId,
      conversationId: this.context.conversationId,
      sessionId: this.context.sessionId,
      providerSessionId: this.#requireTransport().providerSessionId,
      adapterId: this.#dependencies.adapter.id,
      provider: this.#dependencies.adapter.provider,
      fundingSource: this.context.fundingSource,
      usage: event.usage,
      ...(event.modelOrSku === undefined
        ? {}
        : { modelOrSku: event.modelOrSku }),
      occurredAt,
    };
    const usage: VoiceUsageEvent = {
      eventId: this.#dependencies.ids.next("voice_usage"),
      ...common,
    };
    const cost: VoiceCostEvent = {
      eventId: this.#dependencies.ids.next("voice_cost"),
      ...common,
      estimatedCost: event.estimatedCost,
    };
    await this.#dependencies.usageSink.recordUsage(usage);
    await this.#dependencies.costSink.recordCost(cost);
    this.#events.push({ type: "usage", event: usage });
    this.#events.push({ type: "cost", event: cost });
  }

  async #reconnect(): Promise<void> {
    if (this.#reconnectPromise !== undefined) {
      await this.#reconnectPromise;
      return;
    }
    this.#reconnectPromise = this.#performReconnect();
    try {
      await this.#reconnectPromise;
    } finally {
      this.#reconnectPromise = undefined;
    }
  }

  async #performReconnect(): Promise<void> {
    if (isTerminal(this.#state)) return;
    this.#transition("reconnecting");
    const checkpoint = {
      tenantId: this.context.tenantId,
      conversationId: this.context.conversationId,
      sessionId: this.context.sessionId,
      providerSessionId: this.#requireTransport().providerSessionId,
      lastEventSequence: this.#lastProviderEventSequence,
      ...(this.#lastCompletedTurnId === undefined
        ? {}
        : { lastCompletedTurnId: this.#lastCompletedTurnId }),
    };
    let lastError: NormalizedVoiceError | undefined;
    for (
      let attempt = 1;
      attempt <= this.#options.reconnect.maxAttempts;
      attempt += 1
    ) {
      const now = this.#dependencies.clock.nowMs();
      const remaining = this.context.deadlineMs - now;
      const delayMs = Math.min(
        this.#options.reconnect.initialBackoffMs * 2 ** (attempt - 1),
        this.#options.reconnect.maxBackoffMs,
      );
      if (remaining <= delayMs) {
        const deadline = normalizeVoiceError(
          { code: "deadline_exceeded", retryable: false },
          this.#dependencies.adapter.id,
        );
        this.#events.push({ type: "error", error: deadline });
        this.#fail(deadline, false);
        return;
      }
      this.#events.push({
        type: "session.reconnect_scheduled",
        attempt,
        delayMs,
        remainingDeadlineMs: remaining,
      });
      try {
        await this.#dependencies.sleeper.sleep(delayMs, this.#abort.signal);
      } catch {
        if (!isTerminal(this.#state)) {
          const aborted = normalizeVoiceError(
            { code: "aborted", retryable: false },
            this.#dependencies.adapter.id,
          );
          this.#fail(aborted);
        }
        return;
      }
      if (this.#dependencies.clock.nowMs() >= this.context.deadlineMs) {
        const deadline = normalizeVoiceError(
          { code: "deadline_exceeded", retryable: false },
          this.#dependencies.adapter.id,
        );
        this.#events.push({ type: "error", error: deadline });
        this.#fail(deadline, false);
        return;
      }
      try {
        const resumed = await this.#dependencies.adapter.resumeSession(
          this.context,
          checkpoint,
          adapterResumeOptions(this.#options, this.#abort.signal),
        );
        if (!resumed.ok) {
          lastError = normalizeVoiceError(
            resumed.error,
            this.#dependencies.adapter.id,
            sensitiveValues(this.#options),
          );
          if (!resumed.error.retryable) break;
          continue;
        }
        const scopeError = validateConnection(
          resumed.value,
          this.context,
          this.#dependencies,
          this.#options,
        );
        if (scopeError !== undefined) {
          await safeClose(resumed.value.transport, "invalid_session_scope");
          lastError = scopeError;
          break;
        }
        this.#installConnection(resumed.value);
        this.#transition("connected");
        this.#events.push({
          type: "session.reconnected",
          attempt,
          providerSessionId: resumed.value.transport.providerSessionId,
        });
        this.#startPump(resumed.value.transport, this.#generation);
        return;
      } catch (error) {
        lastError = normalizeVoiceError(
          error,
          this.#dependencies.adapter.id,
          sensitiveValues(this.#options),
        );
        if (!lastError.retryable) break;
      }
    }
    const exhausted =
      lastError ??
      normalizeVoiceError(
        { code: "connection_lost", retryable: false },
        this.#dependencies.adapter.id,
      );
    this.#events.push({ type: "error", error: exhausted });
    this.#fail(exhausted, false);
  }

  #markActiveTurnInterrupted(): void {
    if (this.#activeTurnId === undefined) return;
    const turnId = this.#activeTurnId;
    this.#turn(turnId).status = "interrupted";
    this.#lastEventSequence += 1;
    this.#events.push({
      type: "turn.interrupted",
      sequence: this.#lastEventSequence,
      turnId,
      conversationId: this.context.conversationId,
    });
    this.#activeTurnId = undefined;
  }

  #turn(turnId: string): MutableTurn {
    const existing = this.#turns.get(turnId);
    if (existing !== undefined) return existing;
    const created: MutableTurn = { turnId, status: "streaming" };
    this.#turns.set(turnId, created);
    return created;
  }

  #turnSnapshots(): readonly ConversationTurnSnapshot[] {
    return [...this.#turns.values()].map((turn) => ({
      turnId: turn.turnId,
      ...(turn.userText === undefined ? {} : { userText: turn.userText }),
      ...(turn.assistantText === undefined
        ? {}
        : { assistantText: turn.assistantText }),
      status: turn.status,
    }));
  }

  #requireTransport(): RealtimeVoiceTransport {
    if (this.#transport === undefined) {
      throw new Error("Realtime voice transport is unavailable.");
    }
    return this.#transport;
  }

  #assertInteractive(): void {
    if (
      this.#state !== "connected" &&
      this.#state !== "listening" &&
      this.#state !== "responding"
    ) {
      throw new Error(`Realtime voice session is not interactive: ${this.#state}.`);
    }
    if (this.#dependencies.clock.nowMs() >= this.context.deadlineMs) {
      throw new Error("Realtime voice session deadline has expired.");
    }
  }

  #transition(next: VoiceSessionState): void {
    if (next === this.#state) return;
    const previousState = this.#state;
    if (!ALLOWED_TRANSITIONS[previousState].includes(next)) {
      throw new Error(
        `Invalid realtime voice state transition: ${previousState} -> ${next}.`,
      );
    }
    this.#state = next;
    this.#events.push({
      type: "session.state",
      state: next,
      previousState,
    });
  }

  #fail(error: NormalizedVoiceError, emit = true): void {
    if (isTerminal(this.#state)) return;
    if (emit) this.#events.push({ type: "error", error });
    this.#transition("failed");
    this.#abort.abort(error.code);
    if (this.#transport !== undefined) {
      void safeClose(this.#transport, error.code);
    }
    this.#events.close();
  }
}

interface MutableTurn {
  readonly turnId: string;
  userText?: string;
  assistantText?: string;
  status: ConversationTurnSnapshot["status"];
}

function adapterOpenOptions(
  options: VoiceSessionOptions,
  signal: AbortSignal,
) {
  return {
    voiceId: options.voiceId,
    ...(options.language === undefined ? {} : { language: options.language }),
    mode: options.mode,
    enableBargeIn: options.enableBargeIn,
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
    inputMediaType: options.inputMediaType,
    outputMediaType: options.outputMediaType,
    signal,
    ...(options.secretRef === undefined
      ? {}
      : { secretRef: options.secretRef }),
  };
}

function adapterResumeOptions(
  options: VoiceSessionOptions,
  signal: AbortSignal,
) {
  return {
    signal,
    ...(options.secretRef === undefined
      ? {}
      : { secretRef: options.secretRef }),
  };
}

function sensitiveValues(options: VoiceSessionOptions): readonly string[] {
  return options.secretRef === undefined ? [] : [options.secretRef];
}

function validateStartInput(
  context: VoiceSessionContext,
  options: VoiceSessionOptions,
  nowMs: number,
): NormalizedVoiceError | undefined {
  if (
    context.tenantId.trim().length === 0 ||
    context.actorId.trim().length === 0 ||
    context.requestId.trim().length === 0 ||
    context.traceId.trim().length === 0 ||
    context.conversationId.trim().length === 0 ||
    context.sessionId.trim().length === 0 ||
    options.voiceId.trim().length === 0 ||
    options.inputMediaType.trim().length === 0 ||
    options.outputMediaType.trim().length === 0 ||
    options.reconnect.maxAttempts < 0 ||
    options.reconnect.initialBackoffMs < 0 ||
    options.reconnect.maxBackoffMs < options.reconnect.initialBackoffMs
  ) {
    return normalizeVoiceError({
      code: "invalid_request",
      retryable: false,
    });
  }
  if (context.deadlineMs <= nowMs) {
    return normalizeVoiceError({
      code: "deadline_exceeded",
      retryable: false,
    });
  }
  return undefined;
}

function validateConnection(
  connection: VoiceAdapterConnection,
  context: VoiceSessionContext,
  dependencies: ManagedDependencies,
  options: VoiceSessionOptions,
): NormalizedVoiceError | undefined {
  const { descriptor, transport } = connection;
  if (
    descriptor.credentialKind !== "ephemeral" ||
    descriptor.tenantId !== context.tenantId ||
    descriptor.conversationId !== context.conversationId ||
    descriptor.sessionId !== context.sessionId ||
    descriptor.adapterId !== dependencies.adapter.id ||
    descriptor.provider !== dependencies.adapter.provider ||
    descriptor.providerSessionId !== transport.providerSessionId
  ) {
    return {
      ...mismatchError(),
      adapterId: dependencies.adapter.id,
    };
  }
  const now = dependencies.clock.nowMs();
  const expiresAt = Date.parse(descriptor.expiresAt);
  const endpointIsSafe = isSafeRealtimeEndpoint(descriptor.endpoint);
  if (
    containsSensitiveValue(descriptor, sensitiveValues(options)) ||
    descriptor.clientToken.trim().length === 0 ||
    !endpointIsSafe ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > MAX_EPHEMERAL_LIFETIME_MS
  ) {
    return normalizeVoiceError(
      { code: "response_invalid", retryable: false },
      dependencies.adapter.id,
    );
  }
  return undefined;
}

function containsSensitiveValue(
  value: unknown,
  sensitive: readonly string[],
  seen: Set<object> = new Set(),
): boolean {
  if (sensitive.length === 0 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return sensitive.some(
      (item) => item.length > 0 && value.includes(item),
    );
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const item of Object.values(value)) {
    if (containsSensitiveValue(item, sensitive, seen)) return true;
  }
  return false;
}

function isSafeRealtimeEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === "wss:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isTerminal(state: VoiceSessionState): boolean {
  return state === "closed" || state === "failed" || state === "text_handoff";
}

async function safeClose(
  transport: RealtimeVoiceTransport,
  reason: string,
): Promise<void> {
  try {
    await transport.close(reason);
  } catch {
    // Close is best effort; the session's terminal state remains authoritative.
  }
}

export function toIsoTimestamp(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}
