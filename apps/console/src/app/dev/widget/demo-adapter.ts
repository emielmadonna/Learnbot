import type {
  SimulatorConfiguration,
} from "./protocol";
import type {
  WidgetConversation,
  WidgetRuntimeAdapter,
  WidgetRuntimeEvent,
  WidgetThreadItem,
  WidgetVoiceControl,
} from "./runtime";

type ActivityReporter = (label: string, detail: string) => void;

function timestamp() {
  return new Date().toISOString();
}

function seededConversation(id: string, assistantName: string): WidgetConversation {
  return {
    id,
    items: [
      {
        id: `${id}-welcome`,
        sequence: 1,
        role: "assistant",
        modality: "text",
        status: "complete",
        parts: [
          {
            kind: "text",
            text: `I’m ${assistantName}. Ask me about the lesson, or switch to voice without starting a new conversation.`,
          },
        ],
        createdAt: timestamp(),
      },
    ],
  };
}

function wait(duration: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, duration);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function nextSequence(conversation: WidgetConversation) {
  return Math.max(0, ...conversation.items.map((item) => item.sequence)) + 1;
}

export class DevelopmentWidgetAdapter implements WidgetRuntimeAdapter {
  readonly #configuration: () => SimulatorConfiguration;
  readonly #sessions: Map<string, WidgetConversation>;
  readonly #report: ActivityReporter;
  readonly #assetBase: string;

  constructor(input: {
    configuration: () => SimulatorConfiguration;
    sessions: Map<string, WidgetConversation>;
    report: ActivityReporter;
    assetBase: string;
  }) {
    this.#configuration = input.configuration;
    this.#sessions = input.sessions;
    this.#report = input.report;
    this.#assetBase = input.assetBase;
  }

  async bootstrap(input: Parameters<WidgetRuntimeAdapter["bootstrap"]>[0]) {
    const configuration = this.#configuration();
    const session =
      (input.conversationId
        ? this.#sessions.get(input.conversationId)
        : undefined) ??
      seededConversation(
        `conversation-${configuration.tenantKey.replaceAll(/[^a-z0-9]/gi, "-")}`,
        configuration.branding.assistantName,
      );
    this.#sessions.set(session.id, session);
    this.#report("Session resumed", `${session.id} · ${input.page.title || "untitled page"}`);
    return {
      conversation: session,
      identity: {
        tier: configuration.identityTier,
        ...(configuration.learnerName.trim()
          ? { displayName: configuration.learnerName.trim() }
          : {}),
      },
      learningContext: configuration.context,
      branding: {
        ...configuration.branding,
        logoUrl: `${this.#assetBase}${configuration.branding.logoPath}`,
        fontFamily: "system" as const,
        launcherLabel: `Open ${configuration.branding.assistantName}`,
      },
    };
  }

  async sendText(
    input: Parameters<WidgetRuntimeAdapter["sendText"]>[0],
    emit: (event: WidgetRuntimeEvent) => void,
  ) {
    this.#report("Text turn", `${input.text.length} characters · ${input.page.href}`);
    await wait(180, input.signal);
    const itemId = `assistant-${Date.now()}`;
    const answer =
      "A Minimum Day is the smallest credible action that preserves evidence of momentum. Make it small enough to survive disruption, then record that you kept the promise.";
    for (const chunk of answer.match(/.{1,28}(?:\s|$)/g) ?? [answer]) {
      emit({
        type: "response.delta",
        conversationId: input.conversationId,
        itemId,
        text: chunk,
      });
      await wait(45, input.signal);
    }
    emit({
      type: "response.complete",
      conversationId: input.conversationId,
      itemId,
    });
  }

  async uploadFiles(
    input: Parameters<NonNullable<WidgetRuntimeAdapter["uploadFiles"]>>[0],
    emit: (event: WidgetRuntimeEvent) => void,
  ) {
    for (const file of input.files) {
      const id = `attachment-${Date.now()}-${file.name}`;
      for (const status of ["uploading", "scanning", "extracting", "ready"] as const) {
        emit({
          type: "attachment.updated",
          conversationId: input.conversationId,
          attachment: {
            kind: "attachment",
            id,
            filename: file.name,
            mediaType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            status,
          },
        });
        await wait(240, input.signal);
      }
      this.#report("Attachment ready", `${file.name} · isolated to this conversation`);
    }
  }

  async startVoice(
    input: Parameters<NonNullable<WidgetRuntimeAdapter["startVoice"]>>[0],
    emit: (event: WidgetRuntimeEvent) => void,
  ): Promise<WidgetVoiceControl> {
    const localController = new AbortController();
    const stopOnParentAbort = () => localController.abort();
    input.signal.addEventListener("abort", stopOnParentAbort, { once: true });
    let muted = false;
    this.#report("Voice adapter", "Simulated typed events only · no microphone or media provider");

    void (async () => {
      try {
        emit({ type: "voice.state", conversationId: input.conversationId, state: "connecting" });
        await wait(350, localController.signal);
        emit({ type: "voice.state", conversationId: input.conversationId, state: "listening" });
        await wait(500, localController.signal);
        if (muted) return;
        emit({
          type: "transcript.partial",
          conversationId: input.conversationId,
          text: "How do I keep momentum…",
        });
        await wait(420, localController.signal);
        emit({
          type: "transcript.final",
          conversationId: input.conversationId,
          itemId: `voice-user-${Date.now()}`,
          text: "How do I keep momentum on a disrupted day?",
        });
        emit({ type: "voice.state", conversationId: input.conversationId, state: "thinking" });
        await wait(560, localController.signal);
        const responseId = `voice-assistant-${Date.now()}`;
        emit({
          type: "response.delta",
          conversationId: input.conversationId,
          itemId: responseId,
          text: "Choose the smallest action that still counts, then make the evidence visible.",
        });
        emit({ type: "voice.state", conversationId: input.conversationId, state: "speaking" });
        await wait(700, localController.signal);
        emit({ type: "response.complete", conversationId: input.conversationId, itemId: responseId });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      }
    })();

    return {
      async stop() {
        localController.abort();
        input.signal.removeEventListener("abort", stopOnParentAbort);
      },
      async setMuted(value) {
        muted = value;
      },
      async interrupt() {
        emit({ type: "voice.state", conversationId: input.conversationId, state: "listening" });
      },
    };
  }

  async stopGeneration() {
    this.#report("Generation stopped", "The current partial response remains in the thread");
  }

  reportHealth(event: { code: string; tenantKey?: string }) {
    this.#report("Health signal", `${event.code} · ${event.tenantKey ?? "tenant unavailable"}`);
  }

  injectEvidence(conversation: WidgetConversation, emit: (event: WidgetRuntimeEvent) => void) {
    const configuration = this.#configuration();
    const item: WidgetThreadItem = {
      id: `evidence-${Date.now()}`,
      sequence: nextSequence(conversation),
      role: "assistant",
      modality: "text",
      status: "complete",
      parts: [
        {
          kind: "text",
          text: "Here is the lesson model and the exact source used for this answer.",
        },
        {
          kind: "source",
          id: "source-minimum-day",
          title: "Minimum Day · Build Your Rhythm",
          url: `${this.#assetBase}/dev/widget/host`,
        },
        {
          kind: "diagram",
          id: "diagram-momentum-loop",
          caption: "Disruption → Minimum Day → Evidence → Momentum",
          url: `${this.#assetBase}/widget/momentum-loop.svg`,
          approved: true,
        },
      ],
      createdAt: timestamp(),
    };
    emit({
      type: "thread.item",
      conversationId: conversation.id,
      item,
    });
    this.#report("Approved evidence", `${configuration.tenantName} · source and diagram appended`);
  }
}
