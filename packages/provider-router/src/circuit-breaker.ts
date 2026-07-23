import type { CircuitBreakerPolicy } from "@course-ai/contracts";
import type { CircuitState, CircuitStateStore } from "./types.js";

export class InMemoryCircuitStateStore implements CircuitStateStore {
  readonly #states = new Map<string, CircuitState>();

  get(key: string): CircuitState | undefined {
    return this.#states.get(key);
  }

  set(key: string, state: CircuitState): void {
    this.#states.set(key, state);
  }

  delete(key: string): void {
    this.#states.delete(key);
  }
}

export class CircuitBreaker {
  constructor(
    private readonly store: CircuitStateStore,
    private readonly nowMs: () => number,
  ) {}

  isOpen(key: string, policy: CircuitBreakerPolicy): boolean {
    const state = this.store.get(key);
    if (state?.openedAtMs === undefined) {
      return false;
    }
    if (this.nowMs() - state.openedAtMs >= policy.resetMs) {
      this.store.set(key, { failures: 0 });
      return false;
    }
    return true;
  }

  success(key: string): void {
    this.store.delete(key);
  }

  failure(key: string, policy: CircuitBreakerPolicy): void {
    const current = this.store.get(key);
    const failures = (current?.failures ?? 0) + 1;
    this.store.set(key, {
      failures,
      ...(failures >= policy.failures ? { openedAtMs: this.nowMs() } : {}),
    });
  }
}
