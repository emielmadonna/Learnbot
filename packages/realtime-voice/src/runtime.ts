import type {
  VoiceClock,
  VoiceIdFactory,
  VoiceSleeper,
} from "./types.js";

export class SystemVoiceClock implements VoiceClock {
  nowMs(): number {
    return Date.now();
  }
}

export class AbortableVoiceSleeper implements VoiceSleeper {
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}

export class RandomVoiceIdFactory implements VoiceIdFactory {
  next(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }
}
