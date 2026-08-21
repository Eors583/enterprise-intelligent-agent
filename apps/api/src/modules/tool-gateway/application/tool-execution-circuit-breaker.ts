import { Injectable } from '@nestjs/common';

export interface ToolCircuitDecision {
  readonly allowed: boolean;
  readonly reopenAt: Date | null;
}

interface CircuitState {
  failures: number;
  openedUntil: number | null;
}

/**
 * Process-local fast circuit. Durable UNKNOWN state and the Outbox lease remain
 * the correctness boundary; this circuit only limits repeated pressure on an
 * unhealthy provider in a single worker replica.
 */
@Injectable()
export class ToolExecutionCircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly openMs = 30_000,
  ) {}

  allow(key: string, now = new Date()): ToolCircuitDecision {
    const state = this.states.get(key);
    if (state?.openedUntil === null || state === undefined) {
      return { allowed: true, reopenAt: null };
    }
    if (state.openedUntil > now.getTime()) {
      return { allowed: false, reopenAt: new Date(state.openedUntil) };
    }
    state.openedUntil = null;
    state.failures = Math.max(0, this.failureThreshold - 1);
    return { allowed: true, reopenAt: null };
  }

  succeed(key: string): void {
    this.states.delete(key);
  }

  fail(key: string, now = new Date()): void {
    const state = this.states.get(key) ?? { failures: 0, openedUntil: null };
    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.openedUntil = now.getTime() + this.openMs;
    }
    this.states.set(key, state);
  }
}
