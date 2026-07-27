export const DEFAULT_AGENT_RUN_MAX_INPUT_TOKENS = 16_000;
export const DEFAULT_AGENT_RUN_MAX_OUTPUT_TOKENS = 4_000;
export const DEFAULT_AGENT_RUN_RESERVED_TOKENS =
  DEFAULT_AGENT_RUN_MAX_INPUT_TOKENS + DEFAULT_AGENT_RUN_MAX_OUTPUT_TOKENS;
export const AGENT_RUN_CONCURRENCY_HOLD_STATUSES = ['DISPATCHING', 'RUNNING', 'UNKNOWN'] as const;

export interface AgentRunQuotaSnapshot {
  readonly concurrencyLimit: number;
  readonly rateLimitPerMinute: number;
  readonly monthlyTokenLimit: bigint;
  readonly activeRuns: number;
  readonly runsLastMinute: number;
  readonly oldestDispatchInWindow: Date | null;
  readonly monthlyTokensUsed: bigint;
  readonly tokensReserved: bigint;
}

export type AgentRunQuotaDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'deferred';
      readonly reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT' | 'TENANT_AGENT_RUN_RATE_LIMIT';
      readonly availableAt: Date;
    }
  | {
      readonly kind: 'rejected';
      readonly reasonCode: 'TENANT_MONTHLY_TOKEN_QUOTA_EXCEEDED';
    };

export function decideAgentRunQuota(
  snapshot: AgentRunQuotaSnapshot,
  reservationTokens: number,
  now = new Date(),
): AgentRunQuotaDecision {
  if (!Number.isSafeInteger(reservationTokens) || reservationTokens <= 0) {
    throw new Error('Agent Run token reservation must be a positive safe integer.');
  }

  const projectedTokens =
    snapshot.monthlyTokensUsed + snapshot.tokensReserved + BigInt(reservationTokens);
  if (projectedTokens > snapshot.monthlyTokenLimit) {
    return { kind: 'rejected', reasonCode: 'TENANT_MONTHLY_TOKEN_QUOTA_EXCEEDED' };
  }

  if (snapshot.activeRuns >= snapshot.concurrencyLimit) {
    return {
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_CONCURRENCY_LIMIT',
      availableAt: new Date(now.getTime() + 2_000),
    };
  }

  if (snapshot.runsLastMinute >= snapshot.rateLimitPerMinute) {
    const windowEnd =
      snapshot.oldestDispatchInWindow === null
        ? now.getTime() + 60_000
        : snapshot.oldestDispatchInWindow.getTime() + 60_000;
    return {
      kind: 'deferred',
      reasonCode: 'TENANT_AGENT_RUN_RATE_LIMIT',
      availableAt: new Date(Math.max(now.getTime() + 1_000, windowEnd + 50)),
    };
  }

  return { kind: 'allowed' };
}
