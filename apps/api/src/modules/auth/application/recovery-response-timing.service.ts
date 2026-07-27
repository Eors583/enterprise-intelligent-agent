import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Injectable } from '@nestjs/common';

const MINIMUM_RESPONSE_MS = 300;
const MAXIMUM_JITTER_MS = 100;

export interface RecoveryResponseBudget {
  wait(): Promise<void>;
}

export interface RecoveryTimingDependencies {
  readonly now: () => number;
  readonly randomJitter: (maximumInclusive: number) => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const SYSTEM_TIMING: RecoveryTimingDependencies = {
  now: () => performance.now(),
  randomJitter: (maximumInclusive) => randomInt(maximumInclusive + 1),
  sleep: async (milliseconds) => {
    await delay(milliseconds);
  },
};

/**
 * Adds a common response floor and cryptographic jitter to enumeration-safe
 * recovery requests without blocking the event loop. This only reduces a
 * statistical timing signal: provider/database long tails can still differ,
 * so production rate limiting and an edge WAF remain required.
 */
@Injectable()
export class RecoveryResponseTimingService {
  start(dependencies: RecoveryTimingDependencies = SYSTEM_TIMING): RecoveryResponseBudget {
    const startedAt = dependencies.now();
    const targetDuration = MINIMUM_RESPONSE_MS + dependencies.randomJitter(MAXIMUM_JITTER_MS);
    let waited = false;

    return {
      wait: async () => {
        if (waited) return;
        waited = true;
        const remaining = targetDuration - (dependencies.now() - startedAt);
        if (remaining > 0) await dependencies.sleep(remaining);
      },
    };
  }
}
