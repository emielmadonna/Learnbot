import type { AttemptTimer, TimerOutcome } from "./types.js";

export class SystemAttemptTimer implements AttemptTimer {
  async run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<TimerOutcome<T>> {
    if (timeoutMs <= 0) {
      return { type: "timed_out" };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<TimerOutcome<T>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort("provider_attempt_timeout");
        resolve({ type: "timed_out" });
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        task(controller.signal).then(
          (value): TimerOutcome<T> => ({ type: "completed", value }),
        ),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
